import StrategyBase from '../StrategyBase.js';
import type { MarketState, TradePlan, Candle, TakeProfit } from '../../types.js';

/**
 * MarubozuLongStrategy
 *
 * Hipótesis (experimento marubozu-long): una vela alcista fuerte ("marubozu" —
 * cuerpo grande, mechas pequeñas) en BTCUSDT 1m tiene una leve continuación
 * alcista. El reconocimiento sobre 2024 midió ~52.5% de aciertos a 1:1.
 *
 * Señal: la última vela cerrada es un marubozu alcista (rango >= minRangePercent%
 * del precio, cada mecha <= maxWickPercent% del rango). Entra LONG al cierre de
 * esa vela; el riesgo es el rango de la vela.
 *
 * Solo LONG. Pensada para iterar la GESTIÓN del trade (TP/SL/breakeven), que es
 * donde un edge delgado puede volverse rentable... o no.
 */

export interface MarubozuLongConfig {
  /** Rango mínimo (high-low) como % del precio para considerar la vela significativa. */
  minRangePercent: number;
  /** Mecha máxima (cada una) como % del rango. Marubozu = mechas pequeñas. */
  maxWickPercent: number;
  /** Distancia del SL como múltiplo del rango de la vela. SL = close - rango*slMult. */
  slMult: number;
  /** Risk:Reward del TP1 respecto al riesgo. TP1 = close + (rango*slMult)*tp1RR. */
  tp1RR: number;
  /** % de la posición a cerrar en TP1 (100 = todo en TP1). */
  tp1SizePercent: number;
  /** Risk:Reward del TP2 sobre el resto. null = sin TP2. */
  tp2RR: number | null;
  /** Mover SL a breakeven al tocar TP1. */
  moveSlToBreakeven: boolean;
  /** Riesgo por trade en % del capital. */
  riskPercent: number;
}

const DEFAULTS: MarubozuLongConfig = {
  minRangePercent:   0.3,
  maxWickPercent:    15,
  slMult:            1.0,
  tp1RR:             1.0,
  tp1SizePercent:    100,
  tp2RR:             null,
  moveSlToBreakeven: false,
  riskPercent:       1,
};

class MarubozuLongStrategy extends StrategyBase {
  private _cfg: MarubozuLongConfig;
  /** openTime de la última vela que disparó señal — evita re-disparar sobre la misma. */
  private _lastSignalTime = 0;

  constructor(config: Partial<MarubozuLongConfig> = {}) {
    super();
    this._cfg = { ...DEFAULTS, ...config };
    this._validate();
  }

  get id(): string {
    return 'marubozu-long-1m';
  }

  get requiredTimeframes(): string[] {
    return ['1m'];
  }

  async evaluate(state: MarketState): Promise<TradePlan | null> {
    const candles = state.candles['1m'];
    if (!candles || candles.length === 0) return null;

    const c = candles[candles.length - 1]!;       // última vela cerrada
    if (c.openTime <= this._lastSignalTime) return null;

    if (!this._isBullishMarubozu(c)) return null;

    this._lastSignalTime = c.openTime;

    const range = c.high - c.low;
    const risk  = range * this._cfg.slMult;
    if (risk <= 0) return null;

    const entryPrice = c.close;                    // entrada al cierre (≈ apertura siguiente)
    const stopLoss   = entryPrice - risk;

    const takeProfits: TakeProfit[] = [
      { price: entryPrice + risk * this._cfg.tp1RR, sizePercent: this._cfg.tp1SizePercent },
    ];
    if (this._cfg.tp2RR !== null && this._cfg.tp1SizePercent < 100) {
      takeProfits.push({
        price:       entryPrice + risk * this._cfg.tp2RR,
        sizePercent: 100 - this._cfg.tp1SizePercent,
      });
    }

    return {
      strategyId:        this.id,
      symbol:            state.symbol,
      direction:         'LONG',
      entryPrice,
      stopLoss,
      takeProfits,
      riskPercent:       this._cfg.riskPercent,
      moveSlToBreakeven: this._cfg.moveSlToBreakeven,
      metadata: {
        marubozuTime:  c.openTime,
        marubozuRange: range,
        rangePercent:  (range / c.close) * 100,
      },
    };
  }

  // ---------------------------------------------------------------------------

  private _isBullishMarubozu(c: Candle): boolean {
    if (c.close <= c.open) return false;           // debe ser alcista

    const range = c.high - c.low;
    if (range <= 0) return false;

    const rangePct = (range / c.close) * 100;
    if (rangePct < this._cfg.minRangePercent) return false;

    const upperWick = c.high - c.close;
    const lowerWick = c.open - c.low;
    const maxWick   = (this._cfg.maxWickPercent / 100) * range;

    return upperWick <= maxWick && lowerWick <= maxWick;
  }

  private _validate(): void {
    const { minRangePercent, maxWickPercent, slMult, tp1RR, tp1SizePercent, tp2RR } = this._cfg;
    if (minRangePercent <= 0) throw new Error('MarubozuLong: minRangePercent debe ser > 0');
    if (maxWickPercent < 0 || maxWickPercent > 50) throw new Error('MarubozuLong: maxWickPercent fuera de [0,50]');
    if (slMult <= 0) throw new Error('MarubozuLong: slMult debe ser > 0');
    if (tp1RR <= 0) throw new Error('MarubozuLong: tp1RR debe ser > 0');
    if (tp1SizePercent <= 0 || tp1SizePercent > 100) throw new Error('MarubozuLong: tp1SizePercent fuera de (0,100]');
    if (tp2RR !== null && tp2RR <= tp1RR) throw new Error('MarubozuLong: tp2RR debe ser > tp1RR');
  }
}

export default MarubozuLongStrategy;
