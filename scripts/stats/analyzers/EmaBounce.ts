import type { Analyzer, AnalyzerResult, CandleWindow } from '../types.js';
import { ema as calcEma, emaStep } from '../../../src/indicators/index.js';

/**
 * EmaBounce
 *
 * Mide la hipótesis: en tendencia alcista (EMA_fast > EMA_slow), cuando el precio
 * retrocede y TOCA la EMA_fast (puede perforarla un poco), ¿rebota hacia arriba?
 *
 * Responde:
 *  - tasa de rebote (TP antes que SL) por NÚMERO DE TOQUE dentro de la misma tendencia
 *    (1er toque, 2º, 3º, 4º+), porque la validez suele decaer con cada toque.
 *  - filtro de SEPARACIÓN: un toque solo cuenta si, desde el toque anterior, el precio
 *    se separó al menos `minSeparationPct` por encima de la EMA (toques distintos, no roces).
 *
 * Trigger LONG: EMA_fast > EMA_slow (uptrend) · vela previa cerró > EMA_fast · low actual <= EMA_fast.
 * Entry = close del toque. TP = +tpPct%, SL = -slPct%. Resuelve en `lookahead` (SL primero/pesimista).
 *
 * EMAs mantenidas incrementalmente (sembradas del lookback en la primera vela).
 * Usa la EMA PREVIA como nivel de soporte (la que el trader ve al abrir la vela; sin lookahead).
 */

export interface EmaBounceConfig {
  emaFast:           number;  // default 200
  emaSlow:           number;  // default 365
  tpPct:             number;  // objetivo de rebote en % del precio. default 0.5
  slPct:             number;  // stop en % del precio. default 0.5
  lookahead:         number;  // velas para resolver TP/SL. default 48
  minSeparationPct:  number;  // % que el precio debe separarse de la EMA entre toques. default 0.3
  touchEma:          'fast' | 'slow';  // cuál EMA se toca. 'slow' = pullback profundo. default 'fast'
  minTrendSepPct:    number;  // separación mínima fast-slow para "tendencia fuerte" (%). default 0
}

type Bucket = { tp: number; sl: number; unresolved: number };
const emptyBucket = (): Bucket => ({ tp: 0, sl: 0, unresolved: 0 });

export class EmaBounce implements Analyzer {
  readonly name        = 'ema-bounce';
  readonly description = 'Rebote LONG al tocar la EMA en tendencia, por número de toque';
  readonly lookahead:  number;

  private readonly _cfg: EmaBounceConfig;

  private _emaFast: number | null = null;
  private _emaSlow: number | null = null;
  private _prevClose = 0;
  private _touchNum  = 0;      // toque dentro de la tendencia actual
  private _separated = true;   // ¿el precio se separó desde el último toque?
  private _buckets: Record<string, Bucket> = { '1': emptyBucket(), '2': emptyBucket(), '3': emptyBucket(), '4+': emptyBucket() };

  constructor(config: Partial<EmaBounceConfig> = {}) {
    this._cfg = {
      emaFast:          config.emaFast          ?? 200,
      emaSlow:          config.emaSlow          ?? 365,
      tpPct:            config.tpPct            ?? 0.5,
      slPct:            config.slPct            ?? 0.5,
      lookahead:        config.lookahead        ?? 48,
      minSeparationPct: config.minSeparationPct ?? 0.3,
      touchEma:         config.touchEma         ?? 'fast',
      minTrendSepPct:   config.minTrendSepPct   ?? 0,
    };
    this.lookahead = this._cfg.lookahead;
  }

  get lookback(): number {
    return this._cfg.emaSlow * 3;   // suficiente para que la EMA lenta converja al sembrar
  }

  process(window: CandleWindow): void {
    const { candle, lookback, lookahead } = window;

    // EMA previa (nivel que el trader ve al inicio de la vela) — antes de incorporar el close actual.
    const fastPrev = this._emaFast;
    const slowPrev = this._emaSlow;

    // Sembrar / actualizar EMAs incrementalmente.
    if (this._emaFast === null || this._emaSlow === null) {
      const closes = lookback.map(c => c.close);
      const seedFast = calcEma(closes, this._cfg.emaFast);
      const seedSlow = calcEma(closes, this._cfg.emaSlow);
      if (seedFast === null || seedSlow === null) { this._prevClose = candle.close; return; }
      this._emaFast = emaStep(seedFast, candle.close, this._cfg.emaFast);
      this._emaSlow = emaStep(seedSlow, candle.close, this._cfg.emaSlow);
      this._prevClose = candle.close;
      return; // primera vela: solo siembra
    }

    // fastPrev/slowPrev son las EMAs de la vela anterior (no null aquí).
    const fast = fastPrev as number;
    const slow = slowPrev as number;

    // Nivel a tocar: la EMA fast, o la slow (pullback profundo).
    const touchLevel = this._cfg.touchEma === 'slow' ? slow : fast;

    // Tendencia: fast por encima de slow, con separación mínima (tendencia fuerte).
    const isUptrend = fast > slow * (1 + this._cfg.minTrendSepPct / 100);

    // Reset del conteo si se rompió la tendencia.
    if (!isUptrend) {
      this._touchNum = 0;
      this._separated = true;
    } else {
      // ¿el precio se separó hacia arriba desde el último toque?
      if (this._prevClose >= touchLevel * (1 + this._cfg.minSeparationPct / 100)) {
        this._separated = true;
      }
    }

    // Detección de toque: en uptrend, vela previa cerró sobre el nivel y la actual lo toca.
    const freshFromAbove = this._prevClose > touchLevel;
    const touched        = candle.low <= touchLevel;

    if (isUptrend && freshFromAbove && touched && this._separated) {
      this._touchNum++;
      this._separated = false;

      // Entrada en el NIVEL de la EMA tocada (compra a la media con orden límite).
      const entry = touchLevel;
      const tp    = entry * (1 + this._cfg.tpPct / 100);
      const sl    = entry * (1 - this._cfg.slPct / 100);
      const res   = this._resolve(lookahead, sl, tp);

      const key = this._touchNum >= 4 ? '4+' : String(this._touchNum);
      const b   = this._buckets[key]!;
      if (res === 'tp') b.tp++; else if (res === 'sl') b.sl++; else b.unresolved++;
    }

    // Avanzar estado para la próxima vela.
    this._emaFast = emaStep(fast, candle.close, this._cfg.emaFast);
    this._emaSlow = emaStep(slow, candle.close, this._cfg.emaSlow);
    this._prevClose = candle.close;
  }

  result(): AnalyzerResult {
    const summary: Record<string, unknown> = {
      config: `EMA(${this._cfg.emaFast})>EMA(${this._cfg.emaSlow})` +
              (this._cfg.minTrendSepPct > 0 ? `·sep>=${this._cfg.minTrendSepPct}%` : '') +
              ` | toque EMA(${this._cfg.touchEma === 'slow' ? this._cfg.emaSlow : this._cfg.emaFast}) | ` +
              `TP +${this._cfg.tpPct}% SL -${this._cfg.slPct}% | lookahead ${this._cfg.lookahead} | sep>=${this._cfg.minSeparationPct}%`,
    };

    const rows: Record<string, unknown>[] = [];
    let totT = 0, totTp = 0, totSl = 0;
    for (const key of ['1', '2', '3', '4+']) {
      const b = this._buckets[key]!;
      const n = b.tp + b.sl + b.unresolved;
      totT += n; totTp += b.tp; totSl += b.sl;
      const resolved = b.tp + b.sl;
      const winRate = resolved > 0 ? ((b.tp / resolved) * 100).toFixed(1) + '%' : 'N/A';
      rows.push({
        'Toque #': key, 'n': n, 'TP': b.tp, 'SL': b.sl, 'NoRes': b.unresolved,
        'WinRate(resueltos)': winRate,
      });
    }
    const totResolved = totTp + totSl;
    summary['toques_totales'] = totT;
    summary['winRate_global_resueltos'] = totResolved > 0 ? ((totTp / totResolved) * 100).toFixed(1) + '%' : 'N/A';

    return { name: this.name, rows, summary };
  }

  reset(): void {
    this._emaFast = this._emaSlow = null;
    this._prevClose = 0;
    this._touchNum = 0;
    this._separated = true;
    this._buckets = { '1': emptyBucket(), '2': emptyBucket(), '3': emptyBucket(), '4+': emptyBucket() };
  }

  private _resolve(lookahead: CandleWindow['lookahead'], sl: number, tp: number): 'tp' | 'sl' | 'unresolved' {
    for (const c of lookahead) {
      if (c.low  <= sl) return 'sl';
      if (c.high >= tp) return 'tp';
    }
    return 'unresolved';
  }
}
