/**
 * SpinningTopFibStrategy.ts
 *
 * Detecta velas tipo "trompo" (spinning top) y calcula zonas de proyección
 * Fibonacci arriba y abajo de la vela. Cuando el precio llega a una zona,
 * genera una señal de reversión.
 *
 * Detección del trompo:
 *   - body/range < maxBodyPercent   (cuerpo pequeño relativo al rango)
 *   - range/close > minRangePercent (vela con rango mínimo significativo)
 *
 * Zonas de proyección (range = high - low):
 *   Fórmula estándar Fibonacci — ancla opuesta a la dirección de la proyección:
 *     UP   ancla en LOW:   low  + range × multiplier
 *     DOWN ancla en HIGH:  high − range × multiplier
 *
 *   Zona 1 UP:   [low  + range * zone1.min, low  + range * zone1.max]  → SHORT
 *   Zona 2 UP:   [low  + range * zone2.min, low  + range * zone2.max]  → SHORT
 *   Zona 1 DOWN: [high - range * zone1.max, high - range * zone1.min]  → LONG
 *   Zona 2 DOWN: [high - range * zone2.max, high - range * zone2.min]  → LONG
 *
 * Trade generado al tocar una zona:
 *   Entrada:  borde interior de la zona (más cercano al trompo)
 *   SL:       borde exterior de la zona
 *   TP1:      1:1 (reduce riesgo parcialmente)
 *   TP2:      high/low del trompo (reversión completa)
 */

import StrategyBase from '../StrategyBase.js';
import { aggregateCandles } from '../CandleAggregator.js';
import type { Candle, MarketState, TradePlan } from '../../types.js';
import { rsi } from '../../indicators/rsi.js';
import { macd } from '../../indicators/macd.js';
import { sma } from '../../indicators/sma.js';
import { ema } from '../../indicators/ema.js';

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

export interface SpinningTopFibConfig {
  /** Timeframe en minutos para detectar trompos (1 = usar 1m directamente) */
  candleInterval: number;

  /** Porcentaje máximo body/range para considerar vela como trompo (ej: 30 = 30%) */
  maxBodyPercent: number;

  /** Porcentaje mínimo range/close para filtrar velas insignificantes (ej: 0.3 = 0.3%) */
  minRangePercent: number;

  /**
   * Volumen mínimo en unidades base para considerar la vela como trompo válido.
   * Filtra trompos en velas de bajo volumen (ruido). Opcional.
   */
  minVolume?: number;

  /**
   * Filtro de volumen relativo: la vela debe tener volumen >= MA(period) * multiplier.
   * Selecciona solo trompos con volumen significativo respecto a las velas anteriores.
   *
   * Ejemplo: { type: 'sma', period: 20, multiplier: 2 }
   *   → la vela debe tener el doble del volumen promedio de las últimas 20 velas.
   */
  volumeFilter?: {
    type: 'sma' | 'ema';
    period: number;
    /** Multiplicador sobre la media. Ej: 1.5 = 50% más que la media, 2 = el doble. @default 1 */
    multiplier?: number;
  };

  /** Zona 1: multiplicadores del rango (ej: { min: 1.8, max: 2.1 }) */
  zone1: { min: number; max: number };

  /**
   * Zona 2: multiplicadores del rango (ej: { min: 2.618, max: 3.0 }).
   * Si es null o undefined, la zona 2 queda deshabilitada.
   */
  zone2?: { min: number; max: number } | null;

  /**
   * Cómo manejar múltiples trompos detectados:
   *   SINGLE_LAST: el trompo más reciente reemplaza al anterior
   *   SINGLE_BEST: el trompo con mayor rango reemplaza al anterior
   */
  spinningTopMode: 'SINGLE_LAST' | 'SINGLE_BEST';

  /**
   * Tiempo máximo que vive una zona de proyección antes de invalidarse.
   * Si el precio no llega a la zona en este tiempo, se descarta.
   *
   * Formatos: '4h', '240m', '2d', '90m'
   * Si se omite o es undefined, las zonas no expiran.
   */
  zoneExpiry?: string;

  /** Porcentaje de la posición a cerrar en TP1 (ej: 50) */
  tp1SizePercent: number;

  /**
   * Risk:Reward del TP1 respecto al ancho de la zona.
   * Ej: 1.0 = 1:1 (igual al riesgo), 1.5 = 1:1.5, 2.0 = 1:2
   * @default 1.0
   */
  tp1RR?: number;

  /**
   * Risk:Reward del TP2 respecto al ancho de la zona.
   * Si es null, TP2 apunta al high/low del trompo (reversión completa).
   * Ej: 2.0 = 1:2, 3.0 = 1:3
   * @default null (usa el high/low del trompo)
   */
  tp2RR?: number | null;

  /**
   * Si true, el SL se mueve a breakeven al tocar TP1.
   * Si false, el SL original permanece mientras se busca TP2.
   * @default true
   */
  moveSlToBreakeven?: boolean;

  /** Riesgo por trade como % del capital (ej: 1) */
  riskPercent: number;

  /** Filtros opcionales de indicadores. Si undefined, no se aplican. */
  filters?: {
    rsi?: {
      period?: number;
      /** SHORT solo si RSI >= este valor */
      overbought?: number;
      /** LONG solo si RSI <= este valor */
      oversold?: number;
    };
    macd?: {
      fastPeriod?: number;
      slowPeriod?: number;
      signalPeriod?: number;
      /**
       * 'histogram': usa el histograma (MACD - signal). 'signal': usa cruce MACD vs signal.
       * @default 'histogram'
       */
      mode?: 'histogram' | 'signal';
      /**
       * Umbral del histograma. SHORT solo si histogram >= threshold, LONG si histogram <= -threshold.
       * Si es 0 (default), basta con que el histograma sea positivo/negativo.
       * @default 0
       */
      histogramThreshold?: number;
    };
  };

  /**
   * Días de la semana en los que se permite operar.
   * 0 = domingo, 1 = lunes, ..., 5 = viernes, 6 = sábado.
   * Undefined o array vacío = todos los días.
   *
   * Ejemplos:
   *   [1, 2, 3, 4, 5]  → solo días hábiles (lun–vie)
   *   [0, 6]           → solo fines de semana (sáb–dom)
   *   [1, 3, 5]        → lunes, miércoles y viernes
   */
  tradingDays?: number[];
}

// ---------------------------------------------------------------------------
// Estado interno
// ---------------------------------------------------------------------------

interface Zone {
  lower: number;
  upper: number;
  direction: 'LONG' | 'SHORT';
  label: string;
  fired: boolean;
}

interface ActiveSpinningTop {
  candle: Candle;
  range: number;
  zones: Zone[];
  /** Timestamp (ms) en el que se armó la zona */
  armedAt: number;
}

// ---------------------------------------------------------------------------
// Estrategia
// ---------------------------------------------------------------------------

class SpinningTopFibStrategy extends StrategyBase {
  private _config: SpinningTopFibConfig;
  private _activeTop: ActiveSpinningTop | null = null;
  /** openTime del último N-minute candle procesado para evitar re-detección */
  private _lastAggCandleTime: number = 0;

  constructor(config: SpinningTopFibConfig) {
    super();
    this._validateConfig(config);
    this._config = config;
  }

  get id(): string {
    return `spinning-top-fib-${this._config.candleInterval}m`;
  }

  get requiredTimeframes(): string[] {
    return ['1m'];
  }

  async evaluate(state: MarketState): Promise<TradePlan | null> {
    const candles1m = state.candles['1m'];
    if (!candles1m || candles1m.length < this._config.candleInterval) return null;

    const aggregated = aggregateCandles(candles1m, this._config.candleInterval);
    if (aggregated.length === 0) return null;

    const lastAgg = aggregated[aggregated.length - 1];

    // Procesar nuevo N-minute candle cuando aparece uno nuevo
    if (lastAgg.openTime > this._lastAggCandleTime) {
      this._lastAggCandleTime = lastAgg.openTime;
      // Solo detectar trompos en días permitidos
      if (this._isAllowedDay(lastAgg.openTime)) {
        this._processNewAggCandle(lastAgg, aggregated);
      }
    }

    if (!this._activeTop) return null;

    // Verificar si la zona expiró por tiempo
    if (this._config.zoneExpiry) {
      const expiryMs = this._parseDuration(this._config.zoneExpiry);
      if (state.timestamp - this._activeTop.armedAt >= expiryMs) {
        this._activeTop = null;
        return null;
      }
    }

    // Solo entrar trades en días permitidos
    if (!this._isAllowedDay(state.timestamp)) return null;

    // Buscar si la vela 1m actual toca alguna zona activa
    const currentCandle = candles1m[candles1m.length - 1];
    const plan = this._checkZones(currentCandle, state);
    if (!plan) return null;
    return this._applyIndicatorFilters(plan, candles1m);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Retorna true si el timestamp corresponde a un día de la semana permitido.
   * Si no hay filtro configurado (tradingDays vacío o undefined), siempre retorna true.
   */
  private _isAllowedDay(timestampMs: number): boolean {
    const { tradingDays } = this._config;
    if (!tradingDays || tradingDays.length === 0) return true;
    const dayOfWeek = new Date(timestampMs).getUTCDay(); // 0=dom ... 6=sáb
    return tradingDays.includes(dayOfWeek);
  }

  private _processNewAggCandle(candle: Candle, allAgg: Candle[]): void {
    if (!this._isSpinningTop(candle, allAgg)) return;

    // Decidir si reemplazar el trompo activo
    if (!this._activeTop || this._shouldReplace(candle)) {
      this._activeTop = this._buildActiveTop(candle);
    }
  }

  private _isSpinningTop(candle: Candle, allAgg: Candle[]): boolean {
    const range = candle.high - candle.low;
    if (range === 0) return false;

    const body = Math.abs(candle.close - candle.open);
    const bodyPercent = (body / range) * 100;
    const rangePercent = (range / candle.close) * 100;

    // if (bodyPercent > this._config.maxBodyPercent) return false;
    if (rangePercent < this._config.minRangePercent) return false;
    if (this._config.minVolume !== undefined && candle.volume < this._config.minVolume) return false;

    if (this._config.volumeFilter) {
      const { type, period, multiplier = 1 } = this._config.volumeFilter;
      // Excluir la vela actual para comparar contra el histórico previo
      const candleIdx = allAgg.findIndex(c => c.openTime === candle.openTime);
      const prevCandles = candleIdx > 0 ? allAgg.slice(0, candleIdx) : [];
      const prevVolumes = prevCandles.map(c => c.volume);
      const avgVol = type === 'sma' ? sma(prevVolumes, period) : ema(prevVolumes, period);
      if (avgVol === null) return false; // no hay suficientes velas previas
      if (candle.volume < avgVol * multiplier) return false;
    }

    return true;
  }

  private _shouldReplace(newCandle: Candle): boolean {
    if (!this._activeTop) return true;
    if (this._config.spinningTopMode === 'SINGLE_LAST') return true;
    // SINGLE_BEST: reemplazar solo si el nuevo trompo tiene mayor rango
    return (newCandle.high - newCandle.low) > this._activeTop.range;
  }

  private _buildActiveTop(candle: Candle): ActiveSpinningTop {
    const range = candle.high - candle.low;
    const { zone1, zone2 } = this._config;

    const zones: Zone[] = [
      {
        lower: candle.low + range * zone1.min,
        upper: candle.low + range * zone1.max,
        direction: 'SHORT',
        label: 'Z1_UP',
        fired: false,
      },
      {
        lower: candle.high - range * zone1.max,
        upper: candle.high - range * zone1.min,
        direction: 'LONG',
        label: 'Z1_DOWN',
        fired: false,
      },
    ];

    if (zone2) {
      zones.push(
        {
          lower: candle.low + range * zone2.min,
          upper: candle.low + range * zone2.max,
          direction: 'SHORT',
          label: 'Z2_UP',
          fired: false,
        },
        {
          lower: candle.high - range * zone2.max,
          upper: candle.high - range * zone2.min,
          direction: 'LONG',
          label: 'Z2_DOWN',
          fired: false,
        },
      );
    }

    return { candle, range, armedAt: candle.openTime, zones };
  }

  private _checkZones(candle: Candle, state: MarketState): TradePlan | null {
    if (!this._activeTop) return null;

    for (const zone of this._activeTop.zones) {
      if (zone.fired) continue;

      const touched =
        zone.direction === 'SHORT'
          ? candle.high >= zone.lower   // precio subió hasta la zona
          : candle.low  <= zone.upper;  // precio bajó hasta la zona

      if (touched) {
        zone.fired = true;
        return this._buildTradePlan(zone, state);
      }
    }

    return null;
  }

  private _buildTradePlan(zone: Zone, state: MarketState): TradePlan {
    const top  = this._activeTop!;
    const risk = zone.upper - zone.lower;

    const {
      tp1SizePercent,
      riskPercent,
      tp1RR           = 1.0,
      tp2RR           = null,
      moveSlToBreakeven = true,
    } = this._config;

    const tp2SizePercent = 100 - tp1SizePercent;

    const metadata = {
      zoneLabel:        zone.label,
      spinningTopTime:  top.candle.openTime,
      spinningTopHigh:  top.candle.high,
      spinningTopLow:   top.candle.low,
      spinningTopRange: top.range,
      zoneArmedAt:      top.armedAt,
    };

    if (zone.direction === 'SHORT') {
      const entryPrice = zone.lower;
      const stopLoss   = zone.upper;
      const tp1Price   = entryPrice - risk * tp1RR;
      const tp2Price   = tp2RR !== null && tp2RR !== undefined
        ? entryPrice - risk * tp2RR
        : top.candle.high;

      const takeProfits = tp2SizePercent > 0
        ? [{ price: tp1Price, sizePercent: tp1SizePercent }, { price: tp2Price, sizePercent: tp2SizePercent }]
        : [{ price: tp1Price, sizePercent: tp1SizePercent }];

      return { strategyId: this.id, symbol: state.symbol, direction: 'SHORT', entryPrice, stopLoss, takeProfits, riskPercent, moveSlToBreakeven, metadata };
    } else {
      const entryPrice = zone.upper;
      const stopLoss   = zone.lower;
      const tp1Price   = entryPrice + risk * tp1RR;
      const tp2Price   = tp2RR !== null && tp2RR !== undefined
        ? entryPrice + risk * tp2RR
        : top.candle.low;

      const takeProfits = tp2SizePercent > 0
        ? [{ price: tp1Price, sizePercent: tp1SizePercent }, { price: tp2Price, sizePercent: tp2SizePercent }]
        : [{ price: tp1Price, sizePercent: tp1SizePercent }];

      return { strategyId: this.id, symbol: state.symbol, direction: 'LONG', entryPrice, stopLoss, takeProfits, riskPercent, moveSlToBreakeven, metadata };
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
      const { fastPeriod = 12, slowPeriod = 26, signalPeriod = 9, mode = 'histogram', histogramThreshold = 0 } = filters.macd;
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

  /**
   * Convierte una cadena de duración a milisegundos.
   * Formatos soportados: '4h', '240m', '2d'
   */
  private _parseDuration(str: string): number {
    const match = str.trim().match(/^(\d+(?:\.\d+)?)(m|h|d)$/i);
    if (!match) throw new Error(`SpinningTopFibStrategy: formato de zoneExpiry inválido: "${str}". Use '4h', '240m' o '2d'`);
    const value = parseFloat(match[1]!);
    const unit  = match[2]!.toLowerCase();
    const multipliers: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
    return value * multipliers[unit]!;
  }

  private _validateConfig(config: SpinningTopFibConfig): void {
    if (!Number.isInteger(config.candleInterval) || config.candleInterval <= 0) {
      throw new Error('SpinningTopFibStrategy: candleInterval debe ser un entero positivo');
    }
    if (config.maxBodyPercent <= 0 || config.maxBodyPercent >= 100) {
      throw new Error('SpinningTopFibStrategy: maxBodyPercent debe estar entre 0 y 100');
    }
    if (config.minRangePercent <= 0) {
      throw new Error('SpinningTopFibStrategy: minRangePercent debe ser positivo');
    }
    if (config.minVolume !== undefined && config.minVolume < 0) {
      throw new Error('SpinningTopFibStrategy: minVolume no puede ser negativo');
    }
    if (config.volumeFilter) {
      if (!Number.isInteger(config.volumeFilter.period) || config.volumeFilter.period < 2) {
        throw new Error('SpinningTopFibStrategy: volumeFilter.period debe ser un entero >= 2');
      }
      const mult = config.volumeFilter.multiplier ?? 1;
      if (mult <= 0) {
        throw new Error('SpinningTopFibStrategy: volumeFilter.multiplier debe ser positivo');
      }
    }
    if (config.zoneExpiry !== undefined) {
      this._parseDuration(config.zoneExpiry); // lanza si el formato es inválido
    }
    if (config.zone1.min >= config.zone1.max) {
      throw new Error('SpinningTopFibStrategy: zone1.min debe ser menor que zone1.max');
    }
    if (config.zone2) {
      if (config.zone2.min >= config.zone2.max) {
        throw new Error('SpinningTopFibStrategy: zone2.min debe ser menor que zone2.max');
      }
      if (config.zone1.max >= config.zone2.min) {
        throw new Error('SpinningTopFibStrategy: zone1 y zone2 no pueden superponerse (zone1.max debe ser < zone2.min)');
      }
    }
    if (config.tp1SizePercent <= 0 || config.tp1SizePercent > 100) {
      throw new Error('SpinningTopFibStrategy: tp1SizePercent debe estar entre 0 y 100 (inclusive)');
    }
    if (config.riskPercent <= 0) {
      throw new Error('SpinningTopFibStrategy: riskPercent debe ser positivo');
    }
  }
}

export default SpinningTopFibStrategy;
