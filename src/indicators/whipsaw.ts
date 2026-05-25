/**
 * whipsaw.ts
 *
 * Detector de whipsaw de precio — puerto TypeScript del núcleo puro spikeDetector.js.
 *
 * Un whipsaw es un movimiento violento donde el precio se desplaza mucho en poco
 * tiempo, pero termina cerca de donde empezó. Típicamente causados por cascadas
 * de liquidaciones en futuros.
 *
 * Algoritmo:
 *   1. Filtro de volatilidad: rango > SMA(rangos, smaPeriod) × volatilityMultiplier
 *   2. Displacement ratio: |close - openSpike| / (spikeHigh - spikeLow) < displacementThreshold
 *
 * La confirmación se evalúa desde minBars hasta maxBars. Si llega a maxBars sin
 * confirmar, se descarta y se hace replay del buffer para no perder spikes nuevos.
 *
 * Esta función no tiene side effects: solo opera con el estado que recibe.
 */

import type { Candle } from '../types.js';

// ---------------------------------------------------------------------------
// Tipos públicos
// ---------------------------------------------------------------------------

export interface WhipsawConfig {
  /** Multiplicador sobre el SMA del rango para activar el tracking (default: 3) */
  volatilityMultiplier: number;
  /** Ventana del SMA de rangos (default: 50) */
  smaPeriod: number;
  /** Ratio máximo |close - openSpike| / rango para clasificar como whipsaw (default: 0.3) */
  displacementThreshold: number;
  /** Barras mínimas antes de evaluar el displacement (default: 5) */
  minBars: number;
  /** Barras máximas; si llega sin confirmar se descarta como tendencial (default: 20) */
  maxBars: number;
}

export interface WhipsawState {
  phase: 'monitoring' | 'spike_active' | 'evaluating';
  spikeHigh: number | null;
  spikeLow: number | null;
  peakRange: number | null;
  spikeStartTime: number | null;
  spikeOpenPrice: number | null;
  spikeBars: number;
  recentRanges: number[];
  extensionBuffer: Candle[];
  lastProcessedTime: number | null;
}

export interface WhipsawEvent {
  type: 'whipsaw_detected';
  spikeHigh: number;
  spikeLow: number;
  peakRange: number;
  spikeStartTime: number;
  confirmationTime: number;
  spikeBars: number;
  spikeOpenPrice: number;
  spikeClosePrice: number;
  displacementRatio: number;
}

export interface WhipsawResult {
  state: WhipsawState;
  events: WhipsawEvent[];
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

export function createWhipsawState(): WhipsawState {
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

export function createWhipsawConfig(overrides: Partial<WhipsawConfig> = {}): WhipsawConfig {
  return {
    volatilityMultiplier: 3,
    smaPeriod: 50,
    displacementThreshold: 0.3,
    minBars: 5,
    maxBars: 20,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

function calcSMA(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((sum, v) => sum + v, 0) / period;
}

function calcDisplacementRatio(
  openPrice: number,
  closePrice: number,
  spikeHigh: number,
  spikeLow: number,
): number {
  const range = spikeHigh - spikeLow;
  if (range === 0) return 1;
  return Math.abs(closePrice - openPrice) / range;
}

function updateExtremes(state: WhipsawState, high: number, low: number, range: number): void {
  if (state.spikeHigh === null || high > state.spikeHigh) state.spikeHigh = high;
  if (state.spikeLow === null  || low < state.spikeLow)   state.spikeLow  = low;
  if (state.peakRange === null || range > state.peakRange) state.peakRange = range;
}

function resetToMonitoring(state: WhipsawState): void {
  state.phase          = 'monitoring';
  state.spikeHigh      = null;
  state.spikeLow       = null;
  state.peakRange      = null;
  state.spikeStartTime = null;
  state.spikeOpenPrice = null;
  state.spikeBars      = 0;
  state.extensionBuffer = [];
}

// ---------------------------------------------------------------------------
// Función principal
// ---------------------------------------------------------------------------

/**
 * Procesa una vela y retorna el nuevo estado y los eventos generados.
 * Función pura: no modifica el estado que recibe (crea shallow copy).
 */
export function processWhipsawCandle(
  candle: Candle,
  state: WhipsawState,
  config: WhipsawConfig,
): WhipsawResult {
  // Shallow copy para inmutabilidad
  const s: WhipsawState = {
    ...state,
    recentRanges: [...state.recentRanges],
    extensionBuffer: [...state.extensionBuffer],
  };

  const range = candle.high - candle.low;
  const open  = candle.open;
  const close = candle.close;
  const high  = candle.high;
  const low   = candle.low;

  // Actualizar el buffer de rangos
  s.recentRanges.push(range);
  if (s.recentRanges.length > config.smaPeriod) s.recentRanges.shift();
  s.lastProcessedTime = candle.openTime;

  const smaRange = calcSMA(s.recentRanges, config.smaPeriod);
  const events: WhipsawEvent[] = [];

  // ── Monitoring ──────────────────────────────────────────────────────────────
  if (s.phase === 'monitoring') {
    if (smaRange !== null && range > config.volatilityMultiplier * smaRange) {
      s.phase          = 'spike_active';
      s.spikeHigh      = high;
      s.spikeLow       = low;
      s.peakRange      = range;
      s.spikeStartTime = candle.openTime;
      s.spikeOpenPrice = open;
      s.spikeBars      = 1;
      s.extensionBuffer = [];
    }
    return { state: s, events };
  }

  // ── Spike active (acumulando hasta minBars) ──────────────────────────────────
  if (s.phase === 'spike_active') {
    s.spikeBars += 1;
    updateExtremes(s, high, low, range);

    if (s.spikeBars >= config.minBars) {
      const ratio = calcDisplacementRatio(s.spikeOpenPrice!, close, s.spikeHigh!, s.spikeLow!);

      if (ratio < config.displacementThreshold) {
        events.push({
          type:             'whipsaw_detected',
          spikeHigh:        s.spikeHigh!,
          spikeLow:         s.spikeLow!,
          peakRange:        s.peakRange!,
          spikeStartTime:   s.spikeStartTime!,
          confirmationTime: candle.openTime,
          spikeBars:        s.spikeBars,
          spikeOpenPrice:   s.spikeOpenPrice!,
          spikeClosePrice:  close,
          displacementRatio: ratio,
        });
        resetToMonitoring(s);
      } else {
        s.phase = 'evaluating';
        s.extensionBuffer = [candle];
      }
    }
    return { state: s, events };
  }

  // ── Evaluating (entre minBars y maxBars) ──────────────────────────────────────
  if (s.phase === 'evaluating') {
    s.spikeBars += 1;
    updateExtremes(s, high, low, range);
    s.extensionBuffer.push(candle);

    const ratio = calcDisplacementRatio(s.spikeOpenPrice!, close, s.spikeHigh!, s.spikeLow!);

    if (ratio < config.displacementThreshold) {
      events.push({
        type:             'whipsaw_detected',
        spikeHigh:        s.spikeHigh!,
        spikeLow:         s.spikeLow!,
        peakRange:        s.peakRange!,
        spikeStartTime:   s.spikeStartTime!,
        confirmationTime: candle.openTime,
        spikeBars:        s.spikeBars,
        spikeOpenPrice:   s.spikeOpenPrice!,
        spikeClosePrice:  close,
        displacementRatio: ratio,
      });
      resetToMonitoring(s);
      return { state: s, events };
    }

    if (s.spikeBars >= config.maxBars) {
      // Tendencial — descartar y hacer replay del buffer
      const buffered = [...s.extensionBuffer];
      resetToMonitoring(s);

      for (const bufferedCandle of buffered) {
        const r = processWhipsawCandle(bufferedCandle, s, config);
        Object.assign(s, r.state);
        s.recentRanges    = r.state.recentRanges;
        s.extensionBuffer = r.state.extensionBuffer;
        events.push(...r.events);
      }
    }

    return { state: s, events };
  }

  return { state: s, events };
}
