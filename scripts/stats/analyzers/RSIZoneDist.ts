import type { Analyzer, AnalyzerResult, CandleWindow } from '../types.js';
import { rsi as calcRSI } from '../../../src/indicators/index.js';

export interface RSIZoneDistConfig {
  rsiPeriod: number;   // default 14
  obLevel:   number;   // umbral sobrecompra (default 70)
  osLevel:   number;   // umbral sobreventa (default 30)
  zoneSize:  number;   // tamaño de cada bucket en puntos RSI (default 5)
}

export class RSIZoneDist implements Analyzer {
  readonly name        = 'rsi-zone-dist';
  readonly description = 'Distribución del tiempo en zonas de sobrecompra y sobreventa por RSI';
  readonly lookahead   = 0;

  private readonly _cfg: RSIZoneDistConfig;

  // RSI necesita period+1 closes para el seed + margen de calentamiento
  get lookback(): number {
    return this._cfg.rsiPeriod * 3;
  }

  // buckets: clave = límite inferior del bucket (ej. 70 para 70-75)
  private _obCounts: Map<number, number> = new Map();
  private _osCounts: Map<number, number> = new Map();
  private _totalCandles  = 0;
  private _totalOB       = 0;
  private _totalOS       = 0;

  constructor(config: Partial<RSIZoneDistConfig> = {}) {
    this._cfg = {
      rsiPeriod: config.rsiPeriod ?? 14,
      obLevel:   config.obLevel   ?? 70,
      osLevel:   config.osLevel   ?? 30,
      zoneSize:  config.zoneSize  ?? 5,
    };
  }

  process(window: CandleWindow): void {
    this._totalCandles++;

    const closes = [...window.lookback.map(c => c.close), window.candle.close];
    const rsiVal = calcRSI(closes, this._cfg.rsiPeriod);
    if (rsiVal === null) return;

    if (rsiVal >= this._cfg.obLevel) {
      const bucket = Math.floor(rsiVal / this._cfg.zoneSize) * this._cfg.zoneSize;
      this._obCounts.set(bucket, (this._obCounts.get(bucket) ?? 0) + 1);
      this._totalOB++;
    } else if (rsiVal <= this._cfg.osLevel) {
      const bucket = Math.floor(rsiVal / this._cfg.zoneSize) * this._cfg.zoneSize;
      this._osCounts.set(bucket, (this._osCounts.get(bucket) ?? 0) + 1);
      this._totalOS++;
    }
  }

  result(): AnalyzerResult {
    const { obLevel, osLevel, zoneSize } = this._cfg;
    const rows: Record<string, unknown>[] = [];
    const total = this._totalCandles;

    const pct = (n: number) => total > 0 ? `${((n / total) * 100).toFixed(2)}%` : '0.00%';

    // --- SOBRECOMPRA ---
    rows.push({ zona: '--- SOBRECOMPRA ---', velas: '', pct_del_total: '' });

    // Buckets de obLevel a 100, ordenados de menor a mayor
    const obBuckets: number[] = [];
    for (let lo = obLevel; lo < 100; lo += zoneSize) obBuckets.push(lo);

    for (const lo of obBuckets) {
      const hi    = lo + zoneSize;
      const count = this._obCounts.get(lo) ?? 0;
      rows.push({
        zona:          `${lo} – ${hi > 100 ? 100 : hi}`,
        velas:         count,
        pct_del_total: pct(count),
      });
    }

    rows.push({
      zona:          `Total OB (>= ${obLevel})`,
      velas:         this._totalOB,
      pct_del_total: pct(this._totalOB),
    });

    rows.push({ zona: '', velas: '', pct_del_total: '' });

    // --- SOBREVENTA ---
    rows.push({ zona: '--- SOBREVENTA ---', velas: '', pct_del_total: '' });

    // Buckets de osLevel a 0, ordenados de mayor a menor
    const osBuckets: number[] = [];
    for (let hi = osLevel; hi > 0; hi -= zoneSize) osBuckets.push(hi);

    for (const hi of osBuckets) {
      const lo    = Math.max(hi - zoneSize, 0);
      const count = this._osCounts.get(lo) ?? 0;
      rows.push({
        zona:          `${lo} – ${hi}`,
        velas:         count,
        pct_del_total: pct(count),
      });
    }

    rows.push({
      zona:          `Total OS (<= ${osLevel})`,
      velas:         this._totalOS,
      pct_del_total: pct(this._totalOS),
    });

    const summary: Record<string, unknown> = {
      config:        `RSI(${this._cfg.rsiPeriod}) | OB >= ${obLevel} | OS <= ${osLevel} | buckets de ${zoneSize} puntos`,
      total_velas:   total,
      tiempo_en_OB:  pct(this._totalOB),
      tiempo_en_OS:  pct(this._totalOS),
      tiempo_neutro: total > 0
        ? `${(((total - this._totalOB - this._totalOS) / total) * 100).toFixed(2)}%`
        : '0.00%',
    };

    return { name: this.name, rows, summary };
  }

  reset(): void {
    this._obCounts.clear();
    this._osCounts.clear();
    this._totalCandles = 0;
    this._totalOB      = 0;
    this._totalOS      = 0;
  }
}
