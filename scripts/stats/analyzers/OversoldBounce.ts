import type { Analyzer, AnalyzerResult, CandleWindow } from '../types.js';
import { rsi as calcRsi, sma as calcSma } from '../../../src/indicators/index.js';

/**
 * OversoldBounce
 *
 * Mide el edge de REVERSIÓN A LA MEDIA en LONG: cuando el RSI cruza a sobreventa
 * (RSI < osLevel), ¿el precio rebota hacia arriba?
 *
 * Trigger: RSI cruza por debajo de osLevel (de >= a <). Entry LONG = close.
 * SL = close - stopPct%; TP = close + stopPct%*rr. Resuelve en lookahead velas
 * (SL primero por vela = pesimista, igual que el FillSimulator en ambigüedad).
 */

export interface OversoldBounceConfig {
  rsiPeriod:    number;   // default 14
  osLevel:      number;   // default 30
  stopPct:      number;   // distancia del SL como % del precio. default 0.5
  rr:           number;   // TP = stop * rr. default 1.0
  lookahead:    number;   // velas para verificar TP/SL. default 30
  requireCross: boolean;  // true = solo en el cruce fresco a sobreventa. default true
  trendSma:     number;   // si > 0, solo dispara si close > SMA(trendSma) (uptrend). default 0
}

type Resolution = 'tp' | 'sl' | 'unresolved';

export class OversoldBounce implements Analyzer {
  readonly name        = 'oversold-bounce';
  readonly description = 'Reversión a la media LONG: rebote tras RSI en sobreventa';
  readonly lookahead:  number;

  private readonly _cfg: OversoldBounceConfig;
  private _triggers = 0;
  private _tp = 0;
  private _sl = 0;
  private _unresolved = 0;
  private _tpCandlesSum = 0;
  private _slCandlesSum = 0;
  private _rsiSum = 0;

  constructor(config: Partial<OversoldBounceConfig> = {}) {
    this._cfg = {
      rsiPeriod:    config.rsiPeriod    ?? 14,
      osLevel:      config.osLevel      ?? 30,
      stopPct:      config.stopPct      ?? 0.5,
      rr:           config.rr           ?? 1.0,
      lookahead:    config.lookahead    ?? 30,
      requireCross: config.requireCross ?? true,
      trendSma:     config.trendSma     ?? 0,
    };
    this.lookahead = this._cfg.lookahead;
  }

  get lookback(): number {
    // Suficiente para RSI (actual y previo) y, si aplica, la SMA de tendencia.
    return Math.max(this._cfg.rsiPeriod + 1, this._cfg.trendSma);
  }

  process(window: CandleWindow): void {
    const { candle, lookback, lookahead } = window;

    const closesWithCurrent = [...lookback.map(c => c.close), candle.close];
    const rsiNow = calcRsi(closesWithCurrent, this._cfg.rsiPeriod);
    if (rsiNow === null) return;

    if (rsiNow >= this._cfg.osLevel) return;   // no está en sobreventa

    // Filtro de tendencia: solo comprar la caída si estamos en uptrend (close > SMA).
    if (this._cfg.trendSma > 0) {
      const smaVal = calcSma(closesWithCurrent, this._cfg.trendSma);
      if (smaVal === null || candle.close <= smaVal) return;
    }

    if (this._cfg.requireCross) {
      const rsiPrev = calcRsi(lookback.map(c => c.close), this._cfg.rsiPeriod);
      if (rsiPrev === null || rsiPrev < this._cfg.osLevel) return;  // ya estaba en sobreventa → no es cruce fresco
    }

    // Trigger válido — simular LONG
    const entry    = candle.close;
    const stopDist = entry * (this._cfg.stopPct / 100);
    const sl       = entry - stopDist;
    const tp       = entry + stopDist * this._cfg.rr;

    const { resolution, candles } = this._resolve(lookahead, sl, tp);

    this._triggers++;
    this._rsiSum += rsiNow;
    if (resolution === 'tp')      { this._tp++; this._tpCandlesSum += candles; }
    else if (resolution === 'sl') { this._sl++; this._slCandlesSum += candles; }
    else                           { this._unresolved++; }
  }

  result(): AnalyzerResult {
    const total = this._triggers || 1;
    const pct   = (n: number) => ((n / total) * 100).toFixed(1) + '%';

    const summary: Record<string, unknown> = {
      config:    `RSI(${this._cfg.rsiPeriod}) < ${this._cfg.osLevel} | SL ${this._cfg.stopPct}% | TP ${this._cfg.rr}:1 | lookahead ${this._cfg.lookahead}` +
                 (this._cfg.requireCross ? ' | solo cruce' : '') +
                 (this._cfg.trendSma > 0 ? ` | uptrend close>SMA(${this._cfg.trendSma})` : ''),
      triggers:  this._triggers,
      rsi_promedio_trigger: this._triggers > 0 ? (this._rsiSum / this._triggers).toFixed(1) : 'N/A',
    };

    const rows: Record<string, unknown>[] = [
      { 'Seccion': `TP ${this._cfg.rr}:1 hit (rebote)`, 'Count': this._tp,         '%': pct(this._tp) },
      { 'Seccion': 'SL hit (sigue cayendo)',            'Count': this._sl,         '%': pct(this._sl) },
      { 'Seccion': 'Sin resolucion',                    'Count': this._unresolved, '%': pct(this._unresolved) },
      {
        'Seccion': 'Metricas',
        'Count':   `velas_tp:${this._tp > 0 ? (this._tpCandlesSum / this._tp).toFixed(1) : 'N/A'} ` +
                   `velas_sl:${this._sl > 0 ? (this._slCandlesSum / this._sl).toFixed(1) : 'N/A'}`,
        '%':       '',
      },
    ];

    return { name: this.name, rows, summary };
  }

  reset(): void {
    this._triggers = this._tp = this._sl = this._unresolved = 0;
    this._tpCandlesSum = this._slCandlesSum = this._rsiSum = 0;
  }

  // LONG: por vela, SL primero (low<=sl), luego TP (high>=tp).
  private _resolve(
    lookahead: CandleWindow['lookahead'],
    sl: number,
    tp: number,
  ): { resolution: Resolution; candles: number } {
    for (let i = 0; i < lookahead.length; i++) {
      const c = lookahead[i]!;
      if (c.low  <= sl) return { resolution: 'sl', candles: i + 1 };
      if (c.high >= tp) return { resolution: 'tp', candles: i + 1 };
    }
    return { resolution: 'unresolved', candles: 0 };
  }
}
