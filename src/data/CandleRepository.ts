/**
 * CandleRepository.ts
 *
 * Acceso de solo lectura a las tablas de velas en TimescaleDB.
 * Las escrituras son responsabilidad del proceso market-tracker (separado).
 *
 * Tablas que lee:
 *   candles_1s  — velas de 1 segundo (resolución máxima para FillSimulator)
 *   candles_1m  — velas de 1 minuto
 *   candles_1h  — velas de 1 hora
 *
 * Todas las tablas tienen el mismo esquema:
 *   symbol TEXT, open_time TIMESTAMPTZ (PK), open, high, low, close, volume NUMERIC
 */

import type { Candle, GranularDataInfo } from '../types.js';

interface DbClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const VALID_TIMEFRAMES: Record<string, string> = {
  '1s': 'candles_1s',
  '1m': 'candles_1m',
  '1h': 'candles_1h',
};

class CandleRepository {
  private _db: DbClient;

  /**
   * @param deps.db - Cliente pg (Pool o Client) con método query()
   */
  constructor({ db }: { db: DbClient }) {
    if (!db || typeof db.query !== 'function') {
      throw new Error('CandleRepository: se requiere un cliente de base de datos con método query()');
    }
    this._db = db;
  }

  /**
   * Devuelve el nombre de tabla para un timeframe dado.
   * Lanza error descriptivo si el timeframe no existe.
   */
  _tableFor(timeframe: string): string {
    const table = VALID_TIMEFRAMES[timeframe];
    if (!table) {
      throw new Error(
        `CandleRepository: timeframe '${timeframe}' no existe. ` +
        `Timeframes válidos: ${Object.keys(VALID_TIMEFRAMES).join(', ')}`
      );
    }
    return table;
  }

  /**
   * Convierte una fila de la base de datos al formato interno Candle.
   */
  _rowToCandle(row: Record<string, unknown>, timeframe: string): Candle {
    return {
      symbol:    String(row['symbol']),
      timeframe,
      openTime:  new Date(row['open_time'] as string).getTime(),
      open:      parseFloat(String(row['open'])),
      high:      parseFloat(String(row['high'])),
      low:       parseFloat(String(row['low'])),
      close:     parseFloat(String(row['close'])),
      volume:    parseFloat(String(row['volume'])),
      isClosed:  true, // los datos en BD son siempre velas cerradas
    };
  }

  /**
   * Obtiene velas de un rango de tiempo para un símbolo y timeframe.
   *
   * @param symbol    - Par de trading (ej. 'BTCUSDT')
   * @param timeframe - Intervalo ('1s', '1m', '1h')
   * @param from      - Timestamp de inicio en ms (inclusive)
   * @param to        - Timestamp de fin en ms (inclusive)
   * @returns Array ordenado por openTime ASC
   */
  async getCandles(symbol: string, timeframe: string, from: number, to: number): Promise<Candle[]> {
    const table = this._tableFor(timeframe);

    const query = `
      SELECT symbol, open_time, open, high, low, close, volume
      FROM ${table}
      WHERE symbol = $1
        AND open_time >= to_timestamp($2 / 1000.0)
        AND open_time <= to_timestamp($3 / 1000.0)
      ORDER BY open_time ASC
    `;

    const result = await this._db.query(query, [symbol, from, to]);
    return result.rows.map(row => this._rowToCandle(row, timeframe));
  }

  /**
   * Obtiene las últimas N velas cerradas para un símbolo y timeframe.
   *
   * @param symbol
   * @param timeframe
   * @param n - Cantidad de velas a retornar
   * @returns Array ordenado por openTime ASC (las más antiguas primero)
   */
  async getLastN(symbol: string, timeframe: string, n: number): Promise<Candle[]> {
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`CandleRepository.getLastN: n debe ser un entero positivo, recibido: ${n}`);
    }

    const table = this._tableFor(timeframe);

    // Subquery para tomar las últimas N y reordenar ASC para consumo normal
    const query = `
      SELECT symbol, open_time, open, high, low, close, volume
      FROM (
        SELECT symbol, open_time, open, high, low, close, volume
        FROM ${table}
        WHERE symbol = $1
        ORDER BY open_time DESC
        LIMIT $2
      ) sub
      ORDER BY open_time ASC
    `;

    const result = await this._db.query(query, [symbol, n]);
    return result.rows.map(row => this._rowToCandle(row, timeframe));
  }

  /**
   * Verifica si existen datos granulares (1s y/o 1m) para un símbolo y rango de tiempo.
   * El FillSimulator usa este método para decidir el modo de resolución adaptativa.
   *
   * @param symbol
   * @param from - Timestamp de inicio en ms
   * @param to   - Timestamp de fin en ms
   */
  async hasGranularData(symbol: string, from: number, to: number): Promise<GranularDataInfo> {
    const check = async (table: string): Promise<boolean> => {
      const query = `
        SELECT EXISTS (
          SELECT 1
          FROM ${table}
          WHERE symbol = $1
            AND open_time >= to_timestamp($2 / 1000.0)
            AND open_time <= to_timestamp($3 / 1000.0)
          LIMIT 1
        ) AS exists
      `;
      const result = await this._db.query(query, [symbol, from, to]);
      return result.rows[0]['exists'] === true;
    };

    const [has1s, has1m] = await Promise.all([
      check('candles_1s'),
      check('candles_1m'),
    ]);

    return { has1s, has1m };
  }
}

export default CandleRepository;
