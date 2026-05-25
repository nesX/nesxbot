/**
 * Detector de whipsaw de precio — núcleo puro.
 *
 * Un whipsaw es un movimiento violento donde el precio se desplaza mucho en poco
 * tiempo, pero termina cerca de donde empezó. Son típicamente causados por
 * cascadas de liquidaciones en futuros.
 *
 * Detección: vela de alto rango activa el tracking → se espera minBars →
 * si el precio está cerca del open → whipsaw. Si no, se extiende barra a barra
 * hasta maxBars evaluando en cada paso. Si llega a maxBars sin confirmar →
 * se descarta como tendencial y se hace replay de la zona extendida para no
 * perder spikes nuevos.
 *
 * Esta función no tiene side effects: sin imports de cache, repo ni logger.
 */

/**
 * @typedef {object} SpikeDetectorConfig
 * @property {number} volatilityMultiplier   - Multiplicador sobre SMA del rango (default: 3)
 * @property {number} smaPeriod              - Período del SMA del rango (default: 50)
 * @property {number} displacementThreshold  - Ratio máximo |close - open| / rango para ser whipsaw (default: 0.3)
 * @property {number} contractionThreshold   - Fracción del rango pico para considerar contracción (default: 0.35)
 * @property {number} minBars                - Barras mínimas antes de evaluar displacement (default: 5)
 * @property {number} maxBars                - Barras máximas, si llega sin confirmar se descarta (default: 20)
 */

/**
 * @typedef {object} SpikeDetectorState
 * @property {'monitoring'|'spike_active'|'evaluating'} phase
 * @property {number|null} spikeHigh
 * @property {number|null} spikeLow
 * @property {number|null} peakRange
 * @property {number|null} spikeStartTime
 * @property {number|null} spikeOpenPrice
 * @property {number} spikeBars
 * @property {number[]} recentRanges          - Buffer circular de rangos para SMA
 * @property {object[]} extensionBuffer       - Velas de la zona extendida (para replay)
 * @property {number|null} lastProcessedTime
 */

/**
 * @typedef {object} SpikeEvent
 * @property {'spike_range_detected'} type
 * @property {object} data
 * @property {number} data.spikeHigh
 * @property {number} data.spikeLow
 * @property {number} data.peakRange
 * @property {number} data.spikeStartTime
 * @property {number} data.confirmationTime
 * @property {number} data.spikeBars
 * @property {number} data.spikeOpenPrice
 * @property {number} data.spikeClosePrice
 * @property {number} data.displacementRatio
 */

export function createInitialState() {
  return {
    phase: 'monitoring',
    spikeHigh: null,
    spikeLow: null,
    peakRange: null,
    spikeStartTime: null,
    spikeOpenPrice: null,
    spikeBars: 0,
    recentRanges: [],
    extensionBuffer: [],
    lastProcessedTime: null,
  };
}

export function createDefaultConfig(overrides = {}) {
  return {
    volatilityMultiplier: 3,
    smaPeriod: 50,
    displacementThreshold: 0.3,
    contractionThreshold: 0.35,
    minBars: 5,
    maxBars: 20,
    ...overrides,
  };
}

// ── Funciones auxiliares internas ────────────────────────────────────────────

function calculateRange(candle) {
  return parseFloat(candle.high) - parseFloat(candle.low);
}

function calculateSMA(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((sum, v) => sum + v, 0) / period;
}

function isVolatile(range, smaRange, multiplier) {
  if (smaRange === null) return false;
  return range > multiplier * smaRange;
}

function isNewExtreme(candle, state) {
  return parseFloat(candle.high) > state.spikeHigh || parseFloat(candle.low) < state.spikeLow;
}

function calculateDisplacementRatio(openPrice, closePrice, spikeHigh, spikeLow) {
  const range = spikeHigh - spikeLow;
  if (range === 0) return 1;
  return Math.abs(closePrice - openPrice) / range;
}

function resetToMonitoring(state) {
  state.phase = 'monitoring';
  state.spikeHigh = null;
  state.spikeLow = null;
  state.peakRange = null;
  state.spikeStartTime = null;
  state.spikeOpenPrice = null;
  state.spikeBars = 0;
  state.extensionBuffer = [];
}

function updateExtremes(newState, high, low, range) {
  if (high > newState.spikeHigh) newState.spikeHigh = high;
  if (low < newState.spikeLow) newState.spikeLow = low;
  if (range > newState.peakRange) newState.peakRange = range;
}

// ── Función principal ─────────────────────────────────────────────────────────

/**
 * Procesa una nueva vela y actualiza el estado del detector.
 * Función pura: sin side effects.
 *
 * @param {object} candle
 * @param {SpikeDetectorState} state
 * @param {SpikeDetectorConfig} config
 * @param {((decision: object) => void)|null} [onDecision] - Callback opcional de debug.
 *   Se llama en cada punto de decisión con un objeto estructurado.
 *   Cuando es null/undefined no hay overhead alguno.
 * @returns {{ state: SpikeDetectorState, events: SpikeEvent[] }}
 */
export function processCandle(candle, state, config, onDecision) {
  let newState = {
    ...state,
    recentRanges: [...state.recentRanges],
    extensionBuffer: [...state.extensionBuffer],
  };

  const range = calculateRange(candle);
  const open = parseFloat(candle.open);
  const close = parseFloat(candle.close);
  const high = parseFloat(candle.high);
  const low = parseFloat(candle.low);

  newState.recentRanges.push(range);
  if (newState.recentRanges.length > config.smaPeriod) {
    newState.recentRanges.shift();
  }

  newState.lastProcessedTime = Number(candle.open_time);

  const smaRange = calculateSMA(newState.recentRanges, config.smaPeriod);
  const events = [];

  // ── Fase: monitoring ──────────────────────────────────────────────────────
  if (newState.phase === 'monitoring') {
    if (smaRange === null) {
      onDecision?.({
        type: 'sma_not_ready',
        phase: 'monitoring',
        candle,
        buffered: newState.recentRanges.length,
        required: config.smaPeriod,
      });
    } else if (isVolatile(range, smaRange, config.volatilityMultiplier)) {
      newState.phase = 'spike_active';
      newState.spikeHigh = high;
      newState.spikeLow = low;
      newState.peakRange = range;
      newState.spikeStartTime = Number(candle.open_time);
      newState.spikeOpenPrice = open;
      newState.spikeBars = 1;
      newState.extensionBuffer = [];
      onDecision?.({
        type: 'spike_activated',
        phase: 'monitoring',
        candle,
        range,
        smaRange,
        multiplier: config.volatilityMultiplier,
        threshold: smaRange * config.volatilityMultiplier,
      });
    } else {
      onDecision?.({
        type: 'range_skip',
        phase: 'monitoring',
        candle,
        range,
        smaRange,
        threshold: smaRange * config.volatilityMultiplier,
      });
    }
    return { state: newState, events };
  }

  // ── Fase: spike_active (acumulando hasta minBars) ─────────────────────────
  if (newState.phase === 'spike_active') {
    newState.spikeBars += 1;
    updateExtremes(newState, high, low, range);

    if (newState.spikeBars < config.minBars) {
      onDecision?.({
        type: 'spike_building',
        phase: 'spike_active',
        candle,
        bar: newState.spikeBars,
        minBars: config.minBars,
      });
    } else {
      // Evaluar displacement al alcanzar minBars
      const ratio = calculateDisplacementRatio(
        newState.spikeOpenPrice, close, newState.spikeHigh, newState.spikeLow
      );

      if (ratio < config.displacementThreshold) {
        // Whipsaw confirmado en minBars
        onDecision?.({
          type: 'whipsaw_confirmed',
          candle,
          ratio,
          threshold: config.displacementThreshold,
          bars: newState.spikeBars,
          phase: 'spike_active',
        });
        events.push({
          type: 'spike_range_detected',
          data: {
            spikeHigh: newState.spikeHigh,
            spikeLow: newState.spikeLow,
            peakRange: newState.peakRange,
            spikeStartTime: newState.spikeStartTime,
            confirmationTime: Number(candle.open_time),
            spikeBars: newState.spikeBars,
            spikeOpenPrice: newState.spikeOpenPrice,
            spikeClosePrice: close,
            displacementRatio: ratio,
          },
        });
        resetToMonitoring(newState);
      } else {
        // No confirmó en minBars → pasar a evaluating
        onDecision?.({
          type: 'moved_to_evaluating',
          phase: 'spike_active',
          candle,
          ratio,
          threshold: config.displacementThreshold,
          bars: newState.spikeBars,
        });
        newState.phase = 'evaluating';
        newState.extensionBuffer = [candle];
      }
    }
    return { state: newState, events };
  }

  // ── Fase: evaluating (entre minBars y maxBars) ────────────────────────────
  if (newState.phase === 'evaluating') {
    newState.spikeBars += 1;
    updateExtremes(newState, high, low, range);
    newState.extensionBuffer.push(candle);

    const ratio = calculateDisplacementRatio(
      newState.spikeOpenPrice, close, newState.spikeHigh, newState.spikeLow
    );

    if (ratio < config.displacementThreshold) {
      // Whipsaw confirmado en zona extendida
      onDecision?.({
        type: 'whipsaw_confirmed',
        candle,
        ratio,
        threshold: config.displacementThreshold,
        bars: newState.spikeBars,
        phase: 'evaluating',
      });
      events.push({
        type: 'spike_range_detected',
        data: {
          spikeHigh: newState.spikeHigh,
          spikeLow: newState.spikeLow,
          peakRange: newState.peakRange,
          spikeStartTime: newState.spikeStartTime,
          confirmationTime: Number(candle.open_time),
          spikeBars: newState.spikeBars,
          spikeOpenPrice: newState.spikeOpenPrice,
          spikeClosePrice: close,
          displacementRatio: ratio,
        },
      });
      resetToMonitoring(newState);
      return { state: newState, events };
    }

    if (newState.spikeBars >= config.maxBars) {
      // Llegó a maxBars sin confirmar → tendencial, descartar
      onDecision?.({
        type: 'discarded_trending',
        phase: 'evaluating',
        candle,
        ratio,
        threshold: config.displacementThreshold,
        bars: newState.spikeBars,
        bufferedCount: newState.extensionBuffer.length,
      });
      const bufferedCandles = [...newState.extensionBuffer];
      resetToMonitoring(newState);

      // Replay de la zona extendida para no perder spikes nuevos
      for (const bufferedCandle of bufferedCandles) {
        const replayResult = processCandle(bufferedCandle, newState, config, onDecision);
        newState = { ...replayResult.state };
        events.push(...replayResult.events);
      }
    } else {
      onDecision?.({
        type: 'evaluating_watching',
        candle,
        ratio,
        threshold: config.displacementThreshold,
        bars: newState.spikeBars,
        maxBars: config.maxBars,
      });
    }

    return { state: newState, events };
  }

  return { state: newState, events };
}