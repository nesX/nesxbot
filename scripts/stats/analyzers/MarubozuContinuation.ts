import type { Analyzer, AnalyzerResult, CandleWindow } from '../types.js';
import { macd as calcMacd } from '../../../src/indicators/index.js';

export interface MarubozuConfig {
  minRangePct:      number;             // default 0.5
  maxWickPct:       number;             // default 10
  lookahead:        number;             // default 20
  direction:        'both' | 'bullish' | 'bearish';
  macdEnabled:      boolean;            // default false
  macdFast:         number;             // default 12
  macdSlow:         number;             // default 26
  macdSignal:       number;             // default 9
  macdFilterSource: 'line' | 'histogram'; // default 'line'
  macdThreshold?:   number;              // default 0
  macdOp?:          'lt' | 'gt';        // default 'lt' (macdValue < threshold)
}

type Resolution = 'tp' | 'sl' | 'unresolved';

interface TriggerRecord {
  resolution:   Resolution;
  candlesToEnd: number;   // 0 si sin resolución
  rangePct:     number;   // rango de la vela trigger como % del close
}

interface DirectionStats {
  triggerCount:  number;
  tpCount:       number;
  slCount:       number;
  unresolvedCount: number;
  tpCandlesSum:  number;
  slCandlesSum:  number;
  rangePctSum:   number;
}

function emptyStats(): DirectionStats {
  return {
    triggerCount:    0,
    tpCount:         0,
    slCount:         0,
    unresolvedCount: 0,
    tpCandlesSum:    0,
    slCandlesSum:    0,
    rangePctSum:     0,
  };
}

/**
 * MarubozuContinuation
 *
 * Busca velas "sin mecha" (marubozu o casi marubozu) con rango significativo
 * y mide cuántas veces el precio continuó la tendencia hasta un objetivo 1:1
 * sin romper el stop.
 *
 * Alcista: entry = close, SL = low, TP = close + (close - low)
 * Bajista: entry = close, SL = high, TP = close - (high - close)
 *
 * lookback = 0 por defecto; cuando macdEnabled=true, se calcula dinámicamente.
 * lookahead = parámetro configurable (velas para verificar TP/SL)
 */
export class MarubozuContinuation implements Analyzer {
  readonly name        = 'marubozu-continuation';
  readonly description = 'Mide la continuación de velas marubozu hacia un objetivo 1:1 sin romper el stop';
  readonly lookahead:  number;

  private readonly _cfg: MarubozuConfig;
  private _bullish: DirectionStats = emptyStats();
  private _bearish: DirectionStats = emptyStats();

  constructor(config: Partial<MarubozuConfig> = {}) {
    this._cfg = {
      minRangePct:      config.minRangePct      ?? 0.5,
      maxWickPct:       config.maxWickPct        ?? 10,
      lookahead:        config.lookahead         ?? 20,
      direction:        config.direction         ?? 'both',
      macdEnabled:      config.macdEnabled       ?? false,
      macdFast:         config.macdFast          ?? 12,
      macdSlow:         config.macdSlow          ?? 26,
      macdSignal:       config.macdSignal        ?? 9,
      macdFilterSource: config.macdFilterSource  ?? 'line',
      macdThreshold:    config.macdThreshold     ?? 0,
      macdOp:           config.macdOp            ?? 'lt',
    };
    this.lookahead = this._cfg.lookahead;
  }

  get lookback(): number {
    if (!this._cfg.macdEnabled) return 0;
    return (this._cfg.macdSlow + this._cfg.macdSignal - 1) * 2;
  }

  process(window: CandleWindow): void {
    const { candle, lookahead } = window;
    const { open, high, low, close } = candle;

    const range = high - low;
    if (range <= 0) return;

    // Filtro de rango mínimo
    const rangePct = (range / close) * 100;
    if (rangePct < this._cfg.minRangePct) return;

    const maxWickAbs = (this._cfg.maxWickPct / 100) * range;

    if (close > open) {
      // Vela alcista
      if (this._cfg.direction === 'bearish') return;

      const upperWick = high - close;
      const lowerWick = open - low;
      if (upperWick > maxWickAbs || lowerWick > maxWickAbs) return;

      // Filtro MACD: alcista solo válido si macdValue < threshold
      if (this._cfg.macdEnabled) {
        const macdValue = this._getMacdValue(window);
        if (macdValue === null) return;
        const threshold = this._cfg.macdThreshold ?? 0;
        const op        = this._cfg.macdOp ?? 'lt';
        const passes    = op === 'gt' ? macdValue > threshold : macdValue < threshold;
        if (!passes) return;
      }

      const entry = close;
      const sl    = low;
      const tp    = close + (close - low);

      void entry; // entry calculado para documentar la lógica, no se usa directamente
      const record = this._resolve(lookahead, 'bullish', sl, tp);
      this._accumulate(this._bullish, record, rangePct);

    } else if (close < open) {
      // Vela bajista
      if (this._cfg.direction === 'bullish') return;

      const upperWick = high - open;
      const lowerWick = close - low;
      if (upperWick > maxWickAbs || lowerWick > maxWickAbs) return;

      // Filtro MACD: bajista solo válido si macdValue < threshold
      if (this._cfg.macdEnabled) {
        const macdValue = this._getMacdValue(window);
        if (macdValue === null) return;
        const threshold = this._cfg.macdThreshold ?? 0;
        const op        = this._cfg.macdOp ?? 'lt';
        const passes    = op === 'gt' ? macdValue > threshold : macdValue < threshold;
        if (!passes) return;
      }

      const sl = high;
      const tp = close - (high - close);

      const record = this._resolve(lookahead, 'bearish', sl, tp);
      this._accumulate(this._bearish, record, rangePct);
    }
    // Doji (close === open): ignorar
  }

  result(): AnalyzerResult {
    const rows: Record<string, unknown>[] = [];

    let configStr = `rango >= ${this._cfg.minRangePct}% | mecha <= ${this._cfg.maxWickPct}% del rango | lookahead ${this._cfg.lookahead} velas`;
    if (this._cfg.macdEnabled) {
      const threshold = this._cfg.macdThreshold ?? 0;
      const op = this._cfg.macdOp ?? 'lt';
      configStr += ` | MACD(${this._cfg.macdFast},${this._cfg.macdSlow},${this._cfg.macdSignal}) ${this._cfg.macdFilterSource} ${op === 'gt' ? '>' : '<'} ${threshold}`;
    }

    const summary: Record<string, unknown> = { config: configStr };

    if (this._cfg.direction === 'both' || this._cfg.direction === 'bullish') {
      summary['triggers_alcistas'] = this._bullish.triggerCount;
      const bullishRows = this._buildRows(this._bullish, 'ALCISTA');
      rows.push(...bullishRows);
      rows.push(this._buildMetricsRow(this._bullish, 'ALCISTA'));
    }

    if (this._cfg.direction === 'both' || this._cfg.direction === 'bearish') {
      summary['triggers_bajistas'] = this._bearish.triggerCount;
      const bearishRows = this._buildRows(this._bearish, 'BAJISTA');
      rows.push(...bearishRows);
      rows.push(this._buildMetricsRow(this._bearish, 'BAJISTA'));
    }

    return { name: this.name, rows, summary };
  }

  reset(): void {
    this._bullish = emptyStats();
    this._bearish = emptyStats();
  }

  // ---------------------------------------------------------------------------
  // Helpers privados
  // ---------------------------------------------------------------------------

  /**
   * Calcula el valor MACD (línea o histograma) para la vela actual
   * combinando lookback + candle actual.
   * Retorna null si no hay suficientes datos.
   */
  private _getMacdValue(window: CandleWindow): number | null {
    const closes = [...window.lookback.map(c => c.close), window.candle.close];
    const macdResult = calcMacd(closes, {
      fastPeriod:   this._cfg.macdFast,
      slowPeriod:   this._cfg.macdSlow,
      signalPeriod: this._cfg.macdSignal,
    });
    if (macdResult === null) return null;
    return this._cfg.macdFilterSource === 'histogram'
      ? macdResult.histogram
      : macdResult.macd;
  }

  /**
   * Itera el lookahead vela a vela y determina si se tocó TP, SL o ninguno.
   * Para alcistas: SL si low <= sl, TP si high >= tp (en ese orden por vela).
   * Para bajistas: SL si high >= sl, TP si low <= tp (en ese orden por vela).
   */
  private _resolve(
    lookahead: CandleWindow['lookahead'],
    dir: 'bullish' | 'bearish',
    sl: number,
    tp: number,
  ): TriggerRecord {
    for (let i = 0; i < lookahead.length; i++) {
      const c = lookahead[i]!;
      if (dir === 'bullish') {
        if (c.low <= sl)  return { resolution: 'sl', candlesToEnd: i + 1, rangePct: 0 };
        if (c.high >= tp) return { resolution: 'tp', candlesToEnd: i + 1, rangePct: 0 };
      } else {
        if (c.high >= sl) return { resolution: 'sl', candlesToEnd: i + 1, rangePct: 0 };
        if (c.low <= tp)  return { resolution: 'tp', candlesToEnd: i + 1, rangePct: 0 };
      }
    }
    return { resolution: 'unresolved', candlesToEnd: 0, rangePct: 0 };
  }

  private _accumulate(stats: DirectionStats, record: TriggerRecord, rangePct: number): void {
    stats.triggerCount++;
    stats.rangePctSum += rangePct;

    switch (record.resolution) {
      case 'tp':
        stats.tpCount++;
        stats.tpCandlesSum += record.candlesToEnd;
        break;
      case 'sl':
        stats.slCount++;
        stats.slCandlesSum += record.candlesToEnd;
        break;
      case 'unresolved':
        stats.unresolvedCount++;
        break;
    }
  }

  private _buildRows(stats: DirectionStats, label: string): Record<string, unknown>[] {
    const total  = stats.triggerCount || 1;

    const tpPct  = ((stats.tpCount        / total) * 100).toFixed(1);
    const slPct  = ((stats.slCount        / total) * 100).toFixed(1);
    const nrPct  = ((stats.unresolvedCount / total) * 100).toFixed(1);

    return [
      { 'Seccion': `--- ${label} ---`, 'Count': '',           '%': '' },
      { 'Seccion': 'TP 1:1 hit',       'Count': stats.tpCount,         '%': `${tpPct}%` },
      { 'Seccion': 'SL hit',           'Count': stats.slCount,         '%': `${slPct}%` },
      { 'Seccion': 'Sin resolucion',   'Count': stats.unresolvedCount,  '%': `${nrPct}%` },
    ];
  }

  private _buildMetricsRow(stats: DirectionStats, label: string): Record<string, unknown> {
    const avgTpCandles = stats.tpCount > 0
      ? (stats.tpCandlesSum / stats.tpCount).toFixed(1)
      : 'N/A';
    const avgSlCandles = stats.slCount > 0
      ? (stats.slCandlesSum / stats.slCount).toFixed(1)
      : 'N/A';
    const avgRange = stats.triggerCount > 0
      ? (stats.rangePctSum / stats.triggerCount).toFixed(2)
      : 'N/A';

    return {
      'Seccion': `Metricas ${label}`,
      'Count':   `velas_tp:${avgTpCandles} velas_sl:${avgSlCandles} rango_avg:${avgRange}%`,
      '%':       '',
    };
  }
}
