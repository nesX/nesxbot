import type { Position } from '../types.js';

/**
 * PositionRepository.ts
 *
 * Acceso a la base de datos para persistir y consultar posiciones (trades) abiertas.
 *
 * Tabla que escribe/lee (propia de NesxTrader):
 *   trades → Estado de cada trade abierto o cerrado
 *
 * Schema esperado:
 *
 *   CREATE TABLE IF NOT EXISTS trades (
 *     trade_id      TEXT        PRIMARY KEY,
 *     strategy_id   TEXT        NOT NULL,
 *     symbol        TEXT        NOT NULL,
 *     direction     TEXT        NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
 *     entry_price   NUMERIC     NOT NULL,
 *     entry_time    BIGINT      NOT NULL,
 *     stop_loss     NUMERIC     NOT NULL,
 *     take_profits  JSONB       NOT NULL,
 *     size          NUMERIC     NOT NULL,
 *     status        TEXT        NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
 *     exit_price    NUMERIC,
 *     exit_time     BIGINT,
 *     exit_type     TEXT,
 *     pnl           NUMERIC,
 *     created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
 *     updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
 *   );
 *
 * NO hace:
 *   - Mantener estado en memoria — PositionManager
 *   - Emitir eventos — PositionManager
 */

export interface DbClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
}

export interface PositionChanges {
  stopLoss?: number;
  status?: string;
  exitPrice?: number | null;
  exitTime?: number | null;
  exitType?: string | null;
  pnl?: number | null;
}

class PositionRepository {
  private _db: DbClient;

  constructor({ db }: { db: DbClient }) {
    if (!db || typeof db.query !== 'function') {
      throw new Error(
        'PositionRepository: se requiere un cliente de base de datos con método query()'
      );
    }
    this._db = db;
  }

  // ---------------------------------------------------------------------------
  // Escritura
  // ---------------------------------------------------------------------------

  /**
   * Persiste una posición nueva en la base de datos.
   */
  async save(position: Position): Promise<void> {
    const {
      tradeId,
      strategyId,
      symbol,
      direction,
      entryPrice,
      entryTime,
      stopLoss,
      takeProfits,
      size,
      status = 'OPEN',
    } = position;

    await this._db.query(
      `INSERT INTO trades (
        trade_id, strategy_id, symbol, direction,
        entry_price, entry_time, stop_loss, take_profits,
        size, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        tradeId,
        strategyId,
        symbol,
        direction,
        entryPrice,
        entryTime,
        stopLoss,
        JSON.stringify(takeProfits),
        size,
        status,
      ]
    );
  }

  /**
   * Actualiza campos de una posición existente.
   * Solo se actualizan los campos presentes en el objeto `changes`.
   *
   * Campos actualizables:
   *   - stopLoss    → stop_loss
   *   - status      → status
   *   - exitPrice   → exit_price
   *   - exitTime    → exit_time
   *   - exitType    → exit_type
   *   - pnl         → pnl
   *
   * @returns true si se actualizó, false si no existe
   */
  async update(tradeId: string, changes: PositionChanges): Promise<boolean> {
    const fieldMap: Record<keyof PositionChanges, string> = {
      stopLoss:   'stop_loss',
      status:     'status',
      exitPrice:  'exit_price',
      exitTime:   'exit_time',
      exitType:   'exit_type',
      pnl:        'pnl',
    };

    const setClauses: string[] = [];
    const values: unknown[]    = [];
    let   paramIndex           = 1;

    for (const [jsKey, sqlCol] of Object.entries(fieldMap) as [keyof PositionChanges, string][]) {
      if (changes[jsKey] !== undefined) {
        setClauses.push(`${sqlCol} = $${paramIndex}`);
        values.push(changes[jsKey]);
        paramIndex++;
      }
    }

    if (setClauses.length === 0) return false;

    // Actualizar updated_at siempre
    setClauses.push(`updated_at = now()`);
    values.push(tradeId);

    const result = await this._db.query(
      `UPDATE trades SET ${setClauses.join(', ')} WHERE trade_id = $${paramIndex}`,
      values
    );

    return result.rowCount > 0;
  }

  // ---------------------------------------------------------------------------
  // Lectura
  // ---------------------------------------------------------------------------

  /**
   * Retorna todas las posiciones con status OPEN o PARTIAL.
   * Usado por PositionManager al iniciar para reconstruir el estado en memoria.
   */
  async findOpen(): Promise<Position[]> {
    const result = await this._db.query(
      `SELECT * FROM trades
       WHERE status IN ('OPEN', 'PARTIAL')
       ORDER BY entry_time ASC`
    );

    return result.rows.map(row => this._rowToPosition(row));
  }

  /**
   * Retorna una posición por su tradeId.
   */
  async findById(tradeId: string): Promise<Position | null> {
    const result = await this._db.query(
      'SELECT * FROM trades WHERE trade_id = $1',
      [tradeId]
    );

    if (result.rows.length === 0) return null;

    return this._rowToPosition(result.rows[0]);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private _rowToPosition(row: Record<string, unknown>): Position {
    return {
      tradeId:     row.trade_id as string,
      strategyId:  row.strategy_id as string,
      symbol:      row.symbol as string,
      direction:   row.direction as 'LONG' | 'SHORT',
      entryPrice:  parseFloat(row.entry_price as string),
      entryTime:   Number(row.entry_time),
      stopLoss:    parseFloat(row.stop_loss as string),
      takeProfits: Array.isArray(row.take_profits)
        ? row.take_profits as { price: number; sizePercent: number }[]
        : JSON.parse(row.take_profits as string) as { price: number; sizePercent: number }[],
      size:        parseFloat(row.size as string),
      status:      row.status as 'OPEN' | 'PARTIAL' | 'CLOSED',
      exitPrice:   row.exit_price  != null ? parseFloat(row.exit_price as string)  : null,
      exitTime:    row.exit_time   != null ? Number(row.exit_time)                 : null,
      exitType:    (row.exit_type as 'TP' | 'SL' | 'MANUAL' | null) || null,
      pnl:         row.pnl         != null ? parseFloat(row.pnl as string)         : null,
    };
  }
}

export default PositionRepository;
