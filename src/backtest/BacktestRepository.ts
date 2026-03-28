import type { FillResult, BacktestReport, BacktestConfig, Metrics } from '../types.js';

interface DbClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
  connect(): Promise<DbClientConnection>;
}

interface DbClientConnection {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}

interface BacktestRunSummary {
  id: string;
  strategyId: string;
  symbol: string;
  timeframe: string;
  from: number;
  to: number;
  initialCapital: number;
  finalCapital: number;
  totalTrades: number;
  winRate: number;
  profitFactor: number | null;
  maxDrawdown: number;
  sharpeRatio: number | null;
  sortinoRatio: number | null;
  expectancy: number | null;
  createdAt: Date;
}

class BacktestRepository {
  private _db: DbClient;

  constructor({ db }: { db: DbClient }) {
    if (!db || typeof db.query !== 'function') {
      throw new Error('BacktestRepository: se requiere un cliente de base de datos con método query()');
    }
    this._db = db;
  }

  /**
   * Guarda una corrida completa de backtest (run + trades individuales).
   * Opera en una única transacción.
   */
  async saveRun(report: BacktestReport): Promise<string> {
    const { config, metrics, trades } = report;

    const client = await this._db.connect();
    try {
      await client.query('BEGIN');

      const runResult = await client.query(
        `INSERT INTO backtest_runs (
          strategy_id, symbol, timeframe, from_ts, to_ts,
          initial_capital, final_capital, total_trades, win_rate,
          profit_factor, max_drawdown, sharpe_ratio, sortino_ratio,
          expectancy, metrics
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        RETURNING id`,
        [
          config.strategyId,
          config.symbol,
          config.timeframe,
          config.from,
          config.to,
          config.initialCapital,
          metrics.finalCapital,
          metrics.totalTrades,
          metrics.winRate,
          isFinite(metrics.profitFactor) ? metrics.profitFactor : null,
          metrics.maxDrawdown,
          metrics.sharpeRatio,
          metrics.sortinoRatio,
          metrics.expectancy,
          JSON.stringify(metrics),
        ]
      );

      const runId = runResult.rows[0]['id'] as string;

      for (const fill of trades) {
        await client.query(
          `INSERT INTO backtest_trades (
            run_id, trade_id, strategy_id, symbol, direction,
            entry_price, entry_ts, exit_price, exit_ts, exit_type,
            tp_level, pnl, pnl_percent, slippage,
            resolution_mode, had_ambiguity
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
          [
            runId,
            fill.tradeId,
            config.strategyId,
            config.symbol,
            (config as BacktestConfig & { direction?: string }).direction || null,
            fill.entryFill.price,
            fill.entryFill.timestamp,
            fill.exitFill.price,
            fill.exitFill.timestamp,
            fill.exitFill.type,
            fill.exitFill.tpLevel || null,
            fill.pnl,
            fill.pnlPercent,
            fill.entryFill.slippage,
            fill.resolution_mode,
            fill.had_ambiguity,
          ]
        );
      }

      await client.query('COMMIT');
      return runId;

    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`BacktestRepository.saveRun: error al guardar corrida — ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }

  /**
   * Obtiene una corrida por su ID, incluyendo sus trades.
   */
  async getRunById(runId: string): Promise<BacktestReport | null> {
    const runResult = await this._db.query(
      'SELECT * FROM backtest_runs WHERE id = $1',
      [runId]
    );

    if (runResult.rows.length === 0) return null;

    const row = runResult.rows[0];

    const tradesResult = await this._db.query(
      'SELECT * FROM backtest_trades WHERE run_id = $1 ORDER BY entry_ts ASC',
      [runId]
    );

    const trades = tradesResult.rows.map(t => this._rowToFillResult(t));

    return {
      id: row['id'] as string,
      config: {
        strategyId:     row['strategy_id'] as string,
        symbol:         row['symbol'] as string,
        timeframe:      row['timeframe'] as string,
        from:           Number(row['from_ts']),
        to:             Number(row['to_ts']),
        initialCapital: parseFloat(row['initial_capital'] as string),
      },
      metrics: row['metrics'] as Metrics,
      trades,
      createdAt: row['created_at'] as Date,
    };
  }

  /**
   * Lista todas las corridas de una estrategia, ordenadas por fecha descendente.
   */
  async listRunsByStrategy(strategyId: string, limit = 20): Promise<BacktestRunSummary[]> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('BacktestRepository.listRunsByStrategy: limit debe ser un entero positivo');
    }

    const result = await this._db.query(
      `SELECT id, strategy_id, symbol, timeframe, from_ts, to_ts,
              initial_capital, final_capital, total_trades, win_rate,
              profit_factor, max_drawdown, sharpe_ratio, sortino_ratio,
              expectancy, created_at
       FROM backtest_runs
       WHERE strategy_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [strategyId, limit]
    );

    return result.rows.map(row => ({
      id:             row['id'] as string,
      strategyId:     row['strategy_id'] as string,
      symbol:         row['symbol'] as string,
      timeframe:      row['timeframe'] as string,
      from:           Number(row['from_ts']),
      to:             Number(row['to_ts']),
      initialCapital: parseFloat(row['initial_capital'] as string),
      finalCapital:   parseFloat(row['final_capital'] as string),
      totalTrades:    Number(row['total_trades']),
      winRate:        parseFloat(row['win_rate'] as string),
      profitFactor:   row['profit_factor'] ? parseFloat(row['profit_factor'] as string) : null,
      maxDrawdown:    parseFloat(row['max_drawdown'] as string),
      sharpeRatio:    row['sharpe_ratio'] ? parseFloat(row['sharpe_ratio'] as string) : null,
      sortinoRatio:   row['sortino_ratio'] ? parseFloat(row['sortino_ratio'] as string) : null,
      expectancy:     row['expectancy'] ? parseFloat(row['expectancy'] as string) : null,
      createdAt:      row['created_at'] as Date,
    }));
  }

  /**
   * Elimina una corrida y sus trades asociados (CASCADE en BD).
   */
  async deleteRun(runId: string): Promise<boolean> {
    const result = await this._db.query(
      'DELETE FROM backtest_runs WHERE id = $1',
      [runId]
    );
    return result.rowCount > 0;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private _rowToFillResult(row: Record<string, unknown>): FillResult {
    return {
      tradeId: row['trade_id'] as string,
      entryFill: {
        price:     parseFloat(row['entry_price'] as string),
        timestamp: Number(row['entry_ts']),
        slippage:  parseFloat(row['slippage'] as string),
      },
      exitFill: {
        price:     parseFloat(row['exit_price'] as string),
        timestamp: Number(row['exit_ts']),
        type:      row['exit_type'] as string,
        tpLevel:   row['tp_level'] ? Number(row['tp_level']) : null,
      },
      pnl:             parseFloat(row['pnl'] as string),
      pnlPercent:      parseFloat(row['pnl_percent'] as string),
      resolution_mode: row['resolution_mode'] as 'PRECISE_1S' | 'PRECISE_1M' | 'PESSIMISTIC',
      had_ambiguity:   row['had_ambiguity'] as boolean,
    };
  }
}

export default BacktestRepository;
