import type { Analyzer, AnalyzerResult, CandleWindow } from '../types.js';

export interface WicklessRangeDistConfig {
  maxWickClosePct: number;  // mecha en el lado del cierre como % del rango (default 1)
  maxWickOpenPct:  number;  // mecha en el lado de la apertura como % del rango (default 5)
  bucketSize:      number;  // tamaño del bucket en % (default 0.1)
  maxRange:        number;  // hasta qué % reportar (default 2)
  direction:       'both' | 'bullish' | 'bearish';
}

/**
 * Para vela alcista:
 *   - mecha cierre  = high - close  (debe ser ≤ maxWickClosePct)
 *   - mecha apertura = open - low   (puede ser hasta maxWickOpenPct)
 *
 * Para vela bajista:
 *   - mecha cierre  = close - low   (debe ser ≤ maxWickClosePct)
 *   - mecha apertura = high - open  (puede ser hasta maxWickOpenPct)
 */
export class WicklessRangeDist implements Analyzer {
  readonly name        = 'wickless-range-dist';
  readonly description = 'Distribución de rangos de velas marubozu agrupadas en buckets';
  readonly lookback    = 0;
  readonly lookahead   = 0;

  private readonly _cfg: WicklessRangeDistConfig;
  private _counts: Map<number, number> = new Map();
  private _totalMatched = 0;
  private _totalCandles = 0;

  constructor(config: Partial<WicklessRangeDistConfig> = {}) {
    this._cfg = {
      maxWickClosePct: config.maxWickClosePct ?? 1,
      maxWickOpenPct:  config.maxWickOpenPct  ?? 5,
      bucketSize:      config.bucketSize      ?? 0.1,
      maxRange:        config.maxRange        ?? 2,
      direction:       config.direction       ?? 'both',
    };
  }

  process(window: CandleWindow): void {
    const { open, high, low, close } = window.candle;
    this._totalCandles++;

    const range = high - low;
    if (range <= 0) return;

    const isBullish = close >= open;
    if (this._cfg.direction === 'bullish' && !isBullish) return;
    if (this._cfg.direction === 'bearish' &&  isBullish) return;

    const maxCloseAbs = (this._cfg.maxWickClosePct / 100) * range;
    const maxOpenAbs  = (this._cfg.maxWickOpenPct  / 100) * range;

    let wickClose: number;
    let wickOpen:  number;

    if (isBullish) {
      wickClose = high - close;   // mecha superior: qué tan lejos está el cierre del máximo
      wickOpen  = open - low;     // mecha inferior: qué tan lejos está la apertura del mínimo
    } else {
      wickClose = close - low;    // mecha inferior: qué tan lejos está el cierre del mínimo
      wickOpen  = high - open;    // mecha superior: qué tan lejos está la apertura del máximo
    }

    if (wickClose > maxCloseAbs || wickOpen > maxOpenAbs) return;

    this._totalMatched++;
    const rangePct    = (range / close) * 100;
    const bucketIndex = Math.floor(rangePct / this._cfg.bucketSize);
    this._counts.set(bucketIndex, (this._counts.get(bucketIndex) ?? 0) + 1);
  }

  result(): AnalyzerResult {
    const { bucketSize, maxRange } = this._cfg;
    const numBuckets = Math.ceil(maxRange / bucketSize);
    const rows: Record<string, unknown>[] = [];

    for (let i = 0; i < numBuckets; i++) {
      const count = this._counts.get(i) ?? 0;
      if (count === 0) continue;
      const lo  = (i * bucketSize).toFixed(2);
      const hi  = ((i + 1) * bucketSize).toFixed(2);
      const pct = ((count / this._totalMatched) * 100).toFixed(1);
      rows.push({ rango: `${lo}% – ${hi}%`, count, pct_del_total: `${pct}%` });
    }

    let overflow = 0;
    for (const [idx, cnt] of this._counts) {
      if (idx >= numBuckets) overflow += cnt;
    }
    if (overflow > 0) {
      const pct = ((overflow / this._totalMatched) * 100).toFixed(1);
      rows.push({ rango: `> ${maxRange.toFixed(2)}%`, count: overflow, pct_del_total: `${pct}%` });
    }

    return {
      name: this.name,
      rows,
      summary: {
        config:          `mecha-cierre <= ${this._cfg.maxWickClosePct}% | mecha-apertura <= ${this._cfg.maxWickOpenPct}% | buckets ${bucketSize}% | dir: ${this._cfg.direction}`,
        total_velas:     this._totalCandles,
        velas_matching:  this._totalMatched,
        pct_matching:    this._totalCandles > 0
          ? `${((this._totalMatched / this._totalCandles) * 100).toFixed(2)}%`
          : '0%',
      },
    };
  }

  reset(): void {
    this._counts.clear();
    this._totalMatched = 0;
    this._totalCandles = 0;
  }
}
