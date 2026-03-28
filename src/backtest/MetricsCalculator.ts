import type { FillResult, Metrics, TPBreakdownLevel, ResolutionConfidence } from '../types.js';

interface TpAccumulator {
  hits: number;
  winRate: number;
  _wins: number;
}

class MetricsCalculator {
  /**
   * Calcula las métricas de un backtest.
   */
  calculate(fills: FillResult[], initialCapital: number): Metrics {
    if (!Array.isArray(fills)) {
      throw new Error('MetricsCalculator.calculate: fills debe ser un array');
    }
    if (typeof initialCapital !== 'number' || initialCapital <= 0) {
      throw new Error('MetricsCalculator.calculate: initialCapital debe ser un número positivo');
    }

    if (fills.length === 0) {
      return this._emptyMetrics(initialCapital);
    }

    const equityCurve = this._buildEquityCurve(fills, initialCapital);
    const pnlSeries   = fills.map(f => f.pnl);
    const winners     = fills.filter(f => f.pnl > 0);
    const losers      = fills.filter(f => f.pnl < 0);

    const finalCapital  = equityCurve[equityCurve.length - 1];
    const totalTrades   = fills.length;
    const winRate       = totalTrades > 0 ? (winners.length / totalTrades) * 100 : 0;
    const profitFactor  = this._profitFactor(winners, losers);
    const maxDrawdown   = this._maxDrawdown(equityCurve);
    const sharpeRatio   = this._sharpeRatio(pnlSeries);
    const sortinoRatio  = this._sortinoRatio(pnlSeries);
    const expectancy    = pnlSeries.reduce((a, b) => a + b, 0) / totalTrades;
    const tpBreakdown   = this._tpBreakdown(fills);
    const resConf       = this._resolutionConfidence(fills);
    const pessimisticP  = fills.filter(f => f.had_ambiguity).length;

    return {
      finalCapital,
      totalTrades,
      winRate,
      profitFactor,
      maxDrawdown,
      sharpeRatio,
      sortinoRatio,
      expectancy,
      tpBreakdown,
      resolution_confidence: resConf,
      pessimistic_penalties: pessimisticP,
    };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private _buildEquityCurve(fills: FillResult[], initialCapital: number): number[] {
    const curve = [initialCapital];
    let current = initialCapital;

    for (const fill of fills) {
      current = current * (1 + fill.pnl / 100);
      curve.push(current);
    }

    return curve;
  }

  private _profitFactor(winners: FillResult[], losers: FillResult[]): number {
    const grossProfit = winners.reduce((acc, f) => acc + f.pnl, 0);
    const grossLoss   = losers.reduce((acc, f)  => acc + Math.abs(f.pnl), 0);

    if (grossLoss === 0 && grossProfit > 0) return Infinity;
    if (grossLoss === 0) return 0;
    return grossProfit / grossLoss;
  }

  private _maxDrawdown(equityCurve: number[]): number {
    let peak  = equityCurve[0];
    let maxDD = 0;

    for (const value of equityCurve) {
      if (value > peak) {
        peak = value;
      }
      const drawdown = peak > 0 ? ((peak - value) / peak) * 100 : 0;
      if (drawdown > maxDD) {
        maxDD = drawdown;
      }
    }

    return maxDD;
  }

  private _sharpeRatio(pnlSeries: number[]): number {
    if (pnlSeries.length < 2) return 0;

    const mean     = pnlSeries.reduce((a, b) => a + b, 0) / pnlSeries.length;
    const variance = pnlSeries.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / pnlSeries.length;
    const stdDev   = Math.sqrt(variance);

    if (stdDev === 0) return 0;
    return mean / stdDev;
  }

  private _sortinoRatio(pnlSeries: number[]): number {
    if (pnlSeries.length < 2) return 0;

    const mean     = pnlSeries.reduce((a, b) => a + b, 0) / pnlSeries.length;
    const downside = pnlSeries.filter(v => v < 0);

    if (downside.length === 0) return 0;

    const downsideVariance = downside.reduce((acc, v) => acc + Math.pow(v, 2), 0) / pnlSeries.length;
    const downsideStdDev   = Math.sqrt(downsideVariance);

    if (downsideStdDev === 0) return 0;
    return mean / downsideStdDev;
  }

  private _tpBreakdown(fills: FillResult[]): { tp1: TPBreakdownLevel; tp2: TPBreakdownLevel; tp3: TPBreakdownLevel } {
    const breakdown: Record<string, TpAccumulator> = {};

    for (const fill of fills) {
      const exitType = fill.exitFill && fill.exitFill.type;
      if (!exitType || !exitType.startsWith('TP')) continue;

      if (!breakdown[exitType]) {
        breakdown[exitType] = { hits: 0, winRate: 0, _wins: 0 };
      }

      breakdown[exitType].hits += 1;
      if (fill.pnl > 0) {
        breakdown[exitType]._wins += 1;
      }
    }

    for (const level of Object.keys(breakdown)) {
      const { hits, _wins } = breakdown[level];
      breakdown[level].winRate = hits > 0 ? (_wins / hits) * 100 : 0;
      delete (breakdown[level] as Partial<TpAccumulator>)._wins;
    }

    for (const level of ['TP1', 'TP2', 'TP3']) {
      if (!breakdown[level]) {
        breakdown[level] = { hits: 0, winRate: 0, _wins: 0 };
      }
    }

    return {
      tp1: { hits: breakdown['TP1'].hits, winRate: breakdown['TP1'].winRate },
      tp2: { hits: breakdown['TP2'].hits, winRate: breakdown['TP2'].winRate },
      tp3: { hits: breakdown['TP3'].hits, winRate: breakdown['TP3'].winRate },
    };
  }

  private _resolutionConfidence(fills: FillResult[]): ResolutionConfidence {
    const counts = {
      PRECISE_1S:  0,
      PRECISE_1M:  0,
      PESSIMISTIC: 0,
    };

    for (const fill of fills) {
      if (fill.resolution_mode in counts) {
        counts[fill.resolution_mode] += 1;
      }
    }

    const total = fills.length;
    if (total === 0) {
      return { PRECISE_1S: 0, PRECISE_1M: 0, PESSIMISTIC: 0 };
    }

    return {
      PRECISE_1S:  (counts.PRECISE_1S  / total) * 100,
      PRECISE_1M:  (counts.PRECISE_1M  / total) * 100,
      PESSIMISTIC: (counts.PESSIMISTIC / total) * 100,
    };
  }

  private _emptyMetrics(initialCapital: number): Metrics {
    return {
      finalCapital:   initialCapital,
      totalTrades:    0,
      winRate:        0,
      profitFactor:   0,
      maxDrawdown:    0,
      sharpeRatio:    0,
      sortinoRatio:   0,
      expectancy:     0,
      tpBreakdown: {
        tp1: { hits: 0, winRate: 0 },
        tp2: { hits: 0, winRate: 0 },
        tp3: { hits: 0, winRate: 0 },
      },
      resolution_confidence: {
        PRECISE_1S:  0,
        PRECISE_1M:  0,
        PESSIMISTIC: 0,
      },
      pessimistic_penalties: 0,
    };
  }
}

export default MetricsCalculator;
