/**
 * WhipsawReversionStrategy.ts
 *
 * Detecta whipsaws (movimientos violentos que regresan al punto de partida) y
 * genera trades de reversión cuando el precio alcanza zonas proyectadas a partir
 * del rango del whipsaw.
 *
 * Detección del whipsaw:
 *   1. Vela con rango > SMA(rangos) × volatilityMultiplier → activa el tracking
 *   2. Se acumulan velas hasta [minBars, maxBars] evaluando:
 *      |close - openSpike| / (spikeHigh - spikeLow) < displacementThreshold
 *   3. Si el ratio es bajo → precio regresó cerca del origen → WHIPSAW CONFIRMADO
 *
 * Zonas de proyección (Range = spikeHigh - spikeLow):
 *   Ancla opuesta a la dirección de proyección (igual que SpinningTopFibStrategy):
 *     UP   ancla en spikeLow:  spikeLow  + Range × multiplier
 *     DOWN ancla en spikeHigh: spikeHigh − Range × multiplier
 *
 *   Zona UP   (SHORT): [spikeLow  + Range × projMin,  spikeLow  + Range × projMax]
 *   Zona DOWN (LONG):  [spikeHigh − Range × projMax,  spikeHigh − Range × projMin]
 *
 * Ejemplo con projMin=1.8, projMax=2.1 y Range=100:
 *   spikeLow=1000, spikeHigh=1100
 *   UP zone SHORT: [1180, 1210]  → SL=1210, entry=1180, TP2=1100 (spikeHigh)
 *   DOWN zone LONG: [890, 920]   → SL=890,  entry=920,  TP2=1000 (spikeLow)
 */

import StrategyBase from '../StrategyBase.js';
import { aggregateCandles } from '../CandleAggregator.js';
import type { Candle, MarketState, TradePlan } from '../../types.js';
import {
  processWhipsawCandle,
  createWhipsawState,
  createWhipsawConfig,
  type WhipsawConfig,
  type WhipsawState,
  type WhipsawEvent,
} from '../../indicators/whipsaw.js';
import { rsi } from '../../indicators/rsi.js';
import { macd } from '../../indicators/macd.js';

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

export interface WhipsawReversionConfig {
  /**
   * Timeframe en minutos sobre el que corre el detector de whipsaw.
   * 1 = usar velas 1m directamente. 5 = agregar a 5m, etc.
   * Soporta: 1, 5, 15, 30, 60, 240, 1440
   * @default 1
   */
  candleInterval?: number;

  // ── Detector de whipsaw ──────────────────────────────────────────────────
  /** Multiplicador sobre el SMA del rango para activar el tracking (default: 3) */
  volatilityMultiplier?: number;
  /** Ventana del SMA de rangos (default: 50) */
  smaPeriod?: number;
  /** Ratio máximo |close − openSpike| / rango para clasificar como whipsaw (default: 0.3) */
  displacementThreshold?: number;
  /** Barras mínimas antes de evaluar el displacement (default: 5) */
  minBars?: number;
  /** Barras máximas; si llega sin confirmar se descarta (default: 20) */
  maxBars?: number;

  // ── Zonas de proyección ──────────────────────────────────────────────────
  /**
   * Proyección mínima del rango del whipsaw para definir el borde interior de la zona.
   * Ejemplo: 1.8 → el borde interior está a 1.8× el rango desde el extremo del whipsaw.
   * @default 1.8
   */
  projMin: number;
  /**
   * Proyección máxima del rango del whipsaw para definir el borde exterior de la zona.
   * Ejemplo: 2.1 → el borde exterior está a 2.1× el rango desde el extremo del whipsaw.
   * @default 2.1
   */
  projMax: number;

  // ── Gestión del trade ────────────────────────────────────────────────────
  /** Porcentaje de la posición a cerrar en TP1 (ej: 50) */
  tp1SizePercent: number;
  /**
   * Risk:Reward del TP1 respecto al ancho de la zona.
   * @default 1.0
   */
  tp1RR?: number;
  /**
   * Risk:Reward del TP2 respecto al ancho de la zona.
   * Si es null, TP2 apunta al spikeHigh/spikeLow (reversión completa al whipsaw).
   * @default null
   */
  tp2RR?: number | null;
  /**
   * Si true, el SL se mueve a breakeven al tocar TP1.
   * @default true
   */
  moveSlToBreakeven?: boolean;
  /** Riesgo por trade como % del capital (ej: 1) */
  riskPercent: number;

  // ── Expiración de zona ───────────────────────────────────────────────────
  /**
   * Tiempo máximo que vive una zona de proyección antes de invalidarse.
   * Formatos: '4h', '240m', '2d'. Si se omite, las zonas no expiran.
   */
  zoneExpiry?: string;

  // ── Filtros de indicadores ───────────────────────────────────────────────
  filters?: {
    rsi?: {
      period?: number;
      overbought?: number;
      oversold?: number;
    };
    macd?: {
      fastPeriod?: number;
      slowPeriod?: number;
      signalPeriod?: number;
      mode?: 'histogram' | 'signal';
      histogramThreshold?: number;
    };
  };

  /**
   * Días de la semana en los que se permite operar.
   * 0 = domingo, 1 = lunes, ..., 6 = sábado. Vacío = todos.
   */
  tradingDays?: number[];
}

// ---------------------------------------------------------------------------
// Estado interno
// ---------------------------------------------------------------------------

interface ProjectionZone {
  lower:     number;
  upper:     number;
  direction: 'LONG' | 'SHORT';
  label:     string;
  fired:     boolean;
}

interface ActiveWhipsaw {
  event:    WhipsawEvent;
  range:    number;
  zones:    ProjectionZone[];
  armedAt:  number;
}

// ---------------------------------------------------------------------------
// Estrategia
// ---------------------------------------------------------------------------

class WhipsawReversionStrategy extends StrategyBase {
  private _config:            WhipsawReversionConfig;
  private _detectorCfg:       WhipsawConfig;
  private _detectorState:     WhipsawState;
  private _activeWhipsaw:     ActiveWhipsaw | null = null;
  private _lastAggCandleTime: number = 0;

  constructor(config: WhipsawReversionConfig) {
    super();
    this._validateConfig(config);
    this._config      = config;
    this._detectorCfg = createWhipsawConfig({
      volatilityMultiplier:  config.volatilityMultiplier,
      smaPeriod:             config.smaPeriod,
      displacementThreshold: config.displacementThreshold,
      minBars:               config.minBars,
      maxBars:               config.maxBars,
    });
    this._detectorState = createWhipsawState();
  }

  get id(): string {
    const interval = this._config.candleInterval ?? 1;
    return `whipsaw-reversion-${interval}m`;
  }

  get requiredTimeframes(): string[] {
    return ['1m'];
  }

  async evaluate(state: MarketState): Promise<TradePlan | null> {
    const candles1m = state.candles['1m'];
    if (!candles1m || candles1m.length === 0) return null;

    const interval = this._config.candleInterval ?? 1;

    // Agregar velas 1m al timeframe configurado
    const aggregated = interval === 1
      ? candles1m
      : aggregateCandles(candles1m, interval);
    if (aggregated.length === 0) return null;

    // Alimentar el detector solo cuando cierra una vela nueva del TF configurado
    const lastAgg = aggregated[aggregated.length - 1]!;
    if (lastAgg.openTime > this._lastAggCandleTime) {
      this._lastAggCandleTime = lastAgg.openTime;
      const result = processWhipsawCandle(lastAgg, this._detectorState, this._detectorCfg);
      this._detectorState = result.state;

      // Si se detectó un nuevo whipsaw, armar las zonas de proyección
      if (result.events.length > 0) {
        const event = result.events[result.events.length - 1]!;
        if (!this._activeWhipsaw || this._shouldReplace(event)) {
          this._activeWhipsaw = this._buildActiveWhipsaw(event);
        }
      }
    }

    if (!this._activeWhipsaw) return null;

    // Verificar expiración
    if (this._config.zoneExpiry) {
      const expiryMs = this._parseDuration(this._config.zoneExpiry);
      if (state.timestamp - this._activeWhipsaw.armedAt >= expiryMs) {
        this._activeWhipsaw = null;
        return null;
      }
    }

    // Solo operar en días permitidos
    if (!this._isAllowedDay(state.timestamp)) return null;

    // Verificar si la vela 1m actual toca alguna zona (resolución fina)
    const latest1m = candles1m[candles1m.length - 1]!;
    const plan = this._checkZones(latest1m, state);
    if (!plan) return null;
    return this._applyIndicatorFilters(plan, candles1m);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private _shouldReplace(newEvent: WhipsawEvent): boolean {
    if (!this._activeWhipsaw) return true;
    // Reemplazar si el nuevo whipsaw tiene mayor rango (más significativo)
    return newEvent.peakRange > this._activeWhipsaw.range;
  }

  private _buildActiveWhipsaw(event: WhipsawEvent): ActiveWhipsaw {
    const { spikeHigh, spikeLow, confirmationTime } = event;
    const range  = spikeHigh - spikeLow;
    const { projMin, projMax } = this._config;

    // UP zone (SHORT): precio sube por encima del spikeHigh hasta la zona proyectada
    // DOWN zone (LONG): precio baja por debajo del spikeLow hasta la zona proyectada
    const zones: ProjectionZone[] = [
      {
        lower:     spikeLow + range * projMin,
        upper:     spikeLow + range * projMax,
        direction: 'SHORT',
        label:     'WS_UP',
        fired:     false,
      },
      {
        lower:     spikeHigh - range * projMax,
        upper:     spikeHigh - range * projMin,
        direction: 'LONG',
        label:     'WS_DOWN',
        fired:     false,
      },
    ];

    return { event, range, zones, armedAt: confirmationTime };
  }

  private _checkZones(candle: Candle, state: MarketState): TradePlan | null {
    if (!this._activeWhipsaw) return null;

    for (const zone of this._activeWhipsaw.zones) {
      if (zone.fired) continue;

      const touched =
        zone.direction === 'SHORT'
          ? candle.high >= zone.lower
          : candle.low  <= zone.upper;

      if (touched) {
        zone.fired = true;
        return this._buildTradePlan(zone, state);
      }
    }

    return null;
  }

  private _buildTradePlan(zone: ProjectionZone, state: MarketState): TradePlan {
    const ws   = this._activeWhipsaw!;
    const risk = zone.upper - zone.lower;

    const {
      tp1SizePercent,
      riskPercent,
      tp1RR            = 1.0,
      tp2RR            = null,
      moveSlToBreakeven = true,
    } = this._config;

    const tp2SizePercent = 100 - tp1SizePercent;

    const metadata = {
      zoneLabel:        zone.label,
      spikeHigh:        ws.event.spikeHigh,
      spikeLow:         ws.event.spikeLow,
      whipsawRange:     ws.range,
      spikeStartTime:   ws.event.spikeStartTime,
      confirmationTime: ws.event.confirmationTime,
      spikeBars:        ws.event.spikeBars,
      displacementRatio: ws.event.displacementRatio,
      zoneArmedAt:      ws.armedAt,
    };

    if (zone.direction === 'SHORT') {
      const entryPrice = zone.lower;
      const stopLoss   = zone.upper;
      const tp1Price   = entryPrice - risk * tp1RR;
      const tp2Price   = tp2RR !== null && tp2RR !== undefined
        ? entryPrice - risk * tp2RR
        : ws.event.spikeHigh;  // reversión completa al spikeHigh del whipsaw

      const takeProfits = tp2SizePercent > 0
        ? [{ price: tp1Price, sizePercent: tp1SizePercent }, { price: tp2Price, sizePercent: tp2SizePercent }]
        : [{ price: tp1Price, sizePercent: tp1SizePercent }];

      return {
        strategyId: this.id, symbol: state.symbol, direction: 'SHORT',
        entryPrice, stopLoss, takeProfits, riskPercent, moveSlToBreakeven, metadata,
      };
    } else {
      const entryPrice = zone.upper;
      const stopLoss   = zone.lower;
      const tp1Price   = entryPrice + risk * tp1RR;
      const tp2Price   = tp2RR !== null && tp2RR !== undefined
        ? entryPrice + risk * tp2RR
        : ws.event.spikeLow;  // reversión completa al spikeLow del whipsaw

      const takeProfits = tp2SizePercent > 0
        ? [{ price: tp1Price, sizePercent: tp1SizePercent }, { price: tp2Price, sizePercent: tp2SizePercent }]
        : [{ price: tp1Price, sizePercent: tp1SizePercent }];

      return {
        strategyId: this.id, symbol: state.symbol, direction: 'LONG',
        entryPrice, stopLoss, takeProfits, riskPercent, moveSlToBreakeven, metadata,
      };
    }
  }

  private _applyIndicatorFilters(plan: TradePlan, candles: Candle[]): TradePlan | null {
    const { filters } = this._config;
    if (!filters) return plan;

    const closes = candles.map(c => c.close);

    if (filters.rsi) {
      const { period = 14, overbought = 70, oversold = 30 } = filters.rsi;
      const rsiValue = rsi(closes, period);
      if (rsiValue !== null) {
        if (plan.direction === 'SHORT' && rsiValue < overbought) return null;
        if (plan.direction === 'LONG'  && rsiValue > oversold)   return null;
      }
    }

    if (filters.macd) {
      const {
        fastPeriod = 12, slowPeriod = 26, signalPeriod = 9,
        mode = 'histogram', histogramThreshold = 0,
      } = filters.macd;
      const macdValue = macd(closes, { fastPeriod, slowPeriod, signalPeriod });
      if (macdValue !== null) {
        if (mode === 'histogram') {
          if (plan.direction === 'SHORT' && macdValue.histogram <  histogramThreshold)  return null;
          if (plan.direction === 'LONG'  && macdValue.histogram > -histogramThreshold)  return null;
        } else {
          if (plan.direction === 'SHORT' && macdValue.macd <= macdValue.signal) return null;
          if (plan.direction === 'LONG'  && macdValue.macd >= macdValue.signal) return null;
        }
      }
    }

    return plan;
  }

  private _isAllowedDay(timestampMs: number): boolean {
    const { tradingDays } = this._config;
    if (!tradingDays || tradingDays.length === 0) return true;
    const dayOfWeek = new Date(timestampMs).getUTCDay();
    return tradingDays.includes(dayOfWeek);
  }

  private _parseDuration(str: string): number {
    const match = str.trim().match(/^(\d+(?:\.\d+)?)(m|h|d)$/i);
    if (!match) throw new Error(`WhipsawReversionStrategy: formato de zoneExpiry inválido: "${str}". Use '4h', '240m' o '2d'`);
    const value = parseFloat(match[1]!);
    const unit  = match[2]!.toLowerCase();
    const multipliers: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
    return value * multipliers[unit]!;
  }

  private _validateConfig(config: WhipsawReversionConfig): void {
    if (config.projMin <= 0)
      throw new Error('WhipsawReversionStrategy: projMin debe ser positivo');
    if (config.projMax <= config.projMin)
      throw new Error('WhipsawReversionStrategy: projMax debe ser mayor que projMin');
    if (config.projMin <= 1.0)
      throw new Error('WhipsawReversionStrategy: projMin debe ser > 1.0 (la zona debe estar fuera del rango del whipsaw)');
    if (config.tp1SizePercent <= 0 || config.tp1SizePercent > 100)
      throw new Error('WhipsawReversionStrategy: tp1SizePercent debe estar entre 0 y 100');
    if (config.riskPercent <= 0)
      throw new Error('WhipsawReversionStrategy: riskPercent debe ser positivo');
    if (config.zoneExpiry !== undefined)
      this._parseDuration(config.zoneExpiry); // valida el formato
    if (config.minBars !== undefined && config.maxBars !== undefined) {
      if (config.minBars < 1)
        throw new Error('WhipsawReversionStrategy: minBars debe ser >= 1');
      if (config.maxBars <= config.minBars)
        throw new Error('WhipsawReversionStrategy: maxBars debe ser mayor que minBars');
    }
  }
}

export default WhipsawReversionStrategy;
