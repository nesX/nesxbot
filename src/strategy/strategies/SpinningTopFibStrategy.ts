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
 *   Zona 1 UP:   [high + range * zone1.min, high + range * zone1.max]  → SHORT
 *   Zona 2 UP:   [high + range * zone2.min, high + range * zone2.max]  → SHORT
 *   Zona 1 DOWN: [low  - range * zone1.max, low  - range * zone1.min]  → LONG
 *   Zona 2 DOWN: [low  - range * zone2.max, low  - range * zone2.min]  → LONG
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

  /** Zona 1: multiplicadores del rango (ej: { min: 1.8, max: 2.1 }) */
  zone1: { min: number; max: number };

  /** Zona 2: multiplicadores del rango (ej: { min: 2.618, max: 3.0 }) */
  zone2: { min: number; max: number };

  /**
   * Cómo manejar múltiples trompos detectados:
   *   SINGLE_LAST: el trompo más reciente reemplaza al anterior
   *   SINGLE_BEST: el trompo con mayor rango reemplaza al anterior
   */
  spinningTopMode: 'SINGLE_LAST' | 'SINGLE_BEST';

  /**
   * Cuántos N-minute candles viven las zonas activas.
   * Infinity = sin expiración.
   */
  zoneLifetime: number;

  /** Porcentaje de la posición a cerrar en TP1 (ej: 50) */
  tp1SizePercent: number;

  /** Riesgo por trade como % del capital (ej: 1) */
  riskPercent: number;
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
  /** Número de N-minute candles transcurridos desde la detección */
  candlesAlive: number;
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
      this._processNewAggCandle(lastAgg);
    }

    if (!this._activeTop) return null;

    // Verificar si las zonas expiraron
    if (
      this._config.zoneLifetime !== Infinity &&
      this._activeTop.candlesAlive > this._config.zoneLifetime
    ) {
      this._activeTop = null;
      return null;
    }

    // Buscar si la vela 1m actual toca alguna zona activa
    const currentCandle = candles1m[candles1m.length - 1];
    return this._checkZones(currentCandle, state);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private _processNewAggCandle(candle: Candle): void {
    // Incrementar el contador de vida ANTES de verificar expiración
    if (this._activeTop) {
      this._activeTop.candlesAlive += 1;
    }

    if (!this._isSpinningTop(candle)) return;

    // Decidir si reemplazar el trompo activo
    if (!this._activeTop || this._shouldReplace(candle)) {
      this._activeTop = this._buildActiveTop(candle);
    }
  }

  private _isSpinningTop(candle: Candle): boolean {
    const range = candle.high - candle.low;
    if (range === 0) return false;

    const body = Math.abs(candle.close - candle.open);
    const bodyPercent = (body / range) * 100;
    const rangePercent = (range / candle.close) * 100;

    return (
      bodyPercent <= this._config.maxBodyPercent &&
      rangePercent >= this._config.minRangePercent
    );
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

    return {
      candle,
      range,
      candlesAlive: 0,
      zones: [
        {
          lower: candle.high + range * zone1.min,
          upper: candle.high + range * zone1.max,
          direction: 'SHORT',
          label: 'Z1_UP',
          fired: false,
        },
        {
          lower: candle.high + range * zone2.min,
          upper: candle.high + range * zone2.max,
          direction: 'SHORT',
          label: 'Z2_UP',
          fired: false,
        },
        {
          lower: candle.low - range * zone1.max,
          upper: candle.low - range * zone1.min,
          direction: 'LONG',
          label: 'Z1_DOWN',
          fired: false,
        },
        {
          lower: candle.low - range * zone2.max,
          upper: candle.low - range * zone2.min,
          direction: 'LONG',
          label: 'Z2_DOWN',
          fired: false,
        },
      ],
    };
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
    const top = this._activeTop!;
    const risk = zone.upper - zone.lower;
    const { tp1SizePercent, riskPercent } = this._config;
    const tp2SizePercent = 100 - tp1SizePercent;

    if (zone.direction === 'SHORT') {
      const entryPrice = zone.lower;                  // borde interior (más cercano al trompo)
      const stopLoss   = zone.upper;                  // borde exterior
      const tp1Price   = entryPrice - risk;            // 1:1
      const tp2Price   = top.candle.high;              // reversión al trompo

      return {
        strategyId: this.id,
        symbol:     state.symbol,
        direction:  'SHORT',
        entryPrice,
        stopLoss,
        takeProfits: [
          { price: tp1Price, sizePercent: tp1SizePercent },
          { price: tp2Price, sizePercent: tp2SizePercent },
        ],
        riskPercent,
        metadata: {
          zoneLabel:         zone.label,
          spinningTopTime:   top.candle.openTime,
          spinningTopHigh:   top.candle.high,
          spinningTopLow:    top.candle.low,
          spinningTopRange:  top.range,
          candlesAlive:      top.candlesAlive,
        },
      };
    } else {
      const entryPrice = zone.upper;                  // borde interior
      const stopLoss   = zone.lower;                  // borde exterior
      const tp1Price   = entryPrice + risk;            // 1:1
      const tp2Price   = top.candle.low;               // reversión al trompo

      return {
        strategyId: this.id,
        symbol:     state.symbol,
        direction:  'LONG',
        entryPrice,
        stopLoss,
        takeProfits: [
          { price: tp1Price, sizePercent: tp1SizePercent },
          { price: tp2Price, sizePercent: tp2SizePercent },
        ],
        riskPercent,
        metadata: {
          zoneLabel:         zone.label,
          spinningTopTime:   top.candle.openTime,
          spinningTopHigh:   top.candle.high,
          spinningTopLow:    top.candle.low,
          spinningTopRange:  top.range,
          candlesAlive:      top.candlesAlive,
        },
      };
    }
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
    if (config.zone1.min >= config.zone1.max) {
      throw new Error('SpinningTopFibStrategy: zone1.min debe ser menor que zone1.max');
    }
    if (config.zone2.min >= config.zone2.max) {
      throw new Error('SpinningTopFibStrategy: zone2.min debe ser menor que zone2.max');
    }
    if (config.zone1.max >= config.zone2.min) {
      throw new Error('SpinningTopFibStrategy: zone1 y zone2 no pueden superponerse (zone1.max debe ser < zone2.min)');
    }
    if (config.tp1SizePercent <= 0 || config.tp1SizePercent >= 100) {
      throw new Error('SpinningTopFibStrategy: tp1SizePercent debe estar entre 0 y 100');
    }
    if (config.riskPercent <= 0) {
      throw new Error('SpinningTopFibStrategy: riskPercent debe ser positivo');
    }
  }
}

export default SpinningTopFibStrategy;
