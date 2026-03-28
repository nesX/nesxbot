/**
 * CandleRepository.ts
 *
 * Acceso de solo lectura a las tablas de velas en TimescaleDB.
 * Las escrituras son responsabilidad del proceso market-tracker (separado).
 *
 * Tablas reales:
 *   binance_candles       — velas 1m y 1h (timeframe column)
 *                           timestamp: integer (Unix segundos)
 *                           columnas: open, high, low, close, volume
 *
 *   public.binance_klines_1s — velas 1s
 *                           open_time: bigint (Unix milisegundos)
 *                           columnas: open_price, high_price, low_price, close_price, volume
 */

import type { Candle, GranularDataInfo } from '../types.js';

interface DbClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

// Timeframes soportados y la tabla/esquema que los sirve
const SUPPORTED_TIMEFRAMES = new Set(['1s', '1m', '1h']);

class CandleRepository {
  private _db: DbClient;

  constructor({ db }: { db: DbClient }) {
    if (!db || typeof db.query !== 'function') {
      throw new Error('CandleRepository: se requiere un cliente de base de datos con método query()');
    }
    this._db = db;
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
    this._assertTimeframe(timeframe);

    if (timeframe === '1s') {
      return this._getCandles1s(symbol, from, to);
    }
    return this._getCandlesFromBinanceCandles(symbol, timeframe, from, to);
  }

  /**
   * Obtiene las últimas N velas cerradas para un símbolo y timeframe.
   */
  async getLastN(symbol: string, timeframe: string, n: number): Promise<Candle[]> {
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`CandleRepository.getLastN: n debe ser un entero positivo, recibido: ${n}`);
    }
    this._assertTimeframe(timeframe);

    if (timeframe === '1s') {
      return this._getLastN1s(symbol, n);
    }
    return this._getLastNFromBinanceCandles(symbol, timeframe, n);
  }

  /**
   * Verifica si existen datos granulares (1s y/o 1m) para un símbolo y rango.
   * El FillSimulator usa este método para decidir el modo de resolución adaptativa.
   */
  async hasGranularData(symbol: string, from: number, to: number): Promise<GranularDataInfo> {
    const [has1s, has1m] = await Promise.all([
      this._hasData1s(symbol, from, to),
      this._hasDataBinanceCandles(symbol, '1m', from, to),
    ]);
    return { has1s, has1m };
  }

  // ---------------------------------------------------------------------------
  // binance_candles (1m, 1h)
  //   timestamp: integer en segundos
  // ---------------------------------------------------------------------------

  private async _getCandlesFromBinanceCandles(
    symbol: string,
    timeframe: string,
    from: number,
    to: number,
  ): Promise<Candle[]> {
    const fromSec = Math.floor(from / 1000);
    const toSec   = Math.floor(to   / 1000);

    const sql = `
      SELECT symbol, timeframe, timestamp, open, high, low, close, volume
      FROM binance_candles
      WHERE symbol    = $1
        AND timeframe = $2
        AND timestamp >= $3
        AND timestamp <= $4
      ORDER BY timestamp ASC
    `;

    const result = await this._db.query(sql, [symbol, timeframe, fromSec, toSec]);
    return result.rows.map(row => this._rowToCandle(row, timeframe));
  }

  private async _getLastNFromBinanceCandles(
    symbol: string,
    timeframe: string,
    n: number,
  ): Promise<Candle[]> {
    const sql = `
      SELECT symbol, timeframe, timestamp, open, high, low, close, volume
      FROM (
        SELECT symbol, timeframe, timestamp, open, high, low, close, volume
        FROM binance_candles
        WHERE symbol    = $1
          AND timeframe = $2
        ORDER BY timestamp DESC
        LIMIT $3
      ) sub
      ORDER BY timestamp ASC
    `;

    const result = await this._db.query(sql, [symbol, timeframe, n]);
    return result.rows.map(row => this._rowToCandle(row, timeframe));
  }

  private async _hasDataBinanceCandles(
    symbol: string,
    timeframe: string,
    from: number,
    to: number,
  ): Promise<boolean> {
    const fromSec = Math.floor(from / 1000);
    const toSec   = Math.floor(to   / 1000);

    const sql = `
      SELECT EXISTS (
        SELECT 1 FROM binance_candles
        WHERE symbol    = $1
          AND timeframe = $2
          AND timestamp >= $3
          AND timestamp <= $4
        LIMIT 1
      ) AS exists
    `;

    const result = await this._db.query(sql, [symbol, timeframe, fromSec, toSec]);
    return result.rows[0]['exists'] === true;
  }

  /**
   * Convierte una fila de binance_candles al formato interno Candle.
   * timestamp está en segundos → convertir a ms.
   */
  private _rowToCandle(row: Record<string, unknown>, timeframe: string): Candle {
    return {
      symbol:   String(row['symbol']),
      timeframe,
      openTime: Number(row['timestamp']) * 1000,
      open:     parseFloat(String(row['open'])),
      high:     parseFloat(String(row['high'])),
      low:      parseFloat(String(row['low'])),
      close:    parseFloat(String(row['close'])),
      volume:   parseFloat(String(row['volume'])),
      isClosed: true,
    };
  }

  // ---------------------------------------------------------------------------
  // binance_klines_1s (1s)
  //   open_time: bigint en milisegundos
  //   columnas: open_price, high_price, low_price, close_price
  // ---------------------------------------------------------------------------

  private async _getCandles1s(symbol: string, from: number, to: number): Promise<Candle[]> {
    const sql = `
      SELECT symbol, open_time, open_price, high_price, low_price, close_price, volume
      FROM binance_klines_1s
      WHERE symbol    = $1
        AND open_time >= $2
        AND open_time <= $3
      ORDER BY open_time ASC
    `;

    const result = await this._db.query(sql, [symbol, from, to]);
    return result.rows.map(row => this._rowToCandle1s(row));
  }

  private async _getLastN1s(symbol: string, n: number): Promise<Candle[]> {
    const sql = `
      SELECT symbol, open_time, open_price, high_price, low_price, close_price, volume
      FROM (
        SELECT symbol, open_time, open_price, high_price, low_price, close_price, volume
        FROM binance_klines_1s
        WHERE symbol = $1
        ORDER BY open_time DESC
        LIMIT $2
      ) sub
      ORDER BY open_time ASC
    `;

    const result = await this._db.query(sql, [symbol, n]);
    return result.rows.map(row => this._rowToCandle1s(row));
  }

  private async _hasData1s(symbol: string, from: number, to: number): Promise<boolean> {
    const sql = `
      SELECT EXISTS (
        SELECT 1 FROM binance_klines_1s
        WHERE symbol    = $1
          AND open_time >= $2
          AND open_time <= $3
        LIMIT 1
      ) AS exists
    `;

    const result = await this._db.query(sql, [symbol, from, to]);
    return result.rows[0]['exists'] === true;
  }

  /**
   * Convierte una fila de binance_klines_1s al formato interno Candle.
   * open_time ya está en ms.
   */
  private _rowToCandle1s(row: Record<string, unknown>): Candle {
    return {
      symbol:   String(row['symbol']),
      timeframe: '1s',
      openTime: Number(row['open_time']),
      open:     parseFloat(String(row['open_price'])),
      high:     parseFloat(String(row['high_price'])),
      low:      parseFloat(String(row['low_price'])),
      close:    parseFloat(String(row['close_price'])),
      volume:   parseFloat(String(row['volume'])),
      isClosed: true,
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private _assertTimeframe(timeframe: string): void {
    if (!SUPPORTED_TIMEFRAMES.has(timeframe)) {
      throw new Error(
        `CandleRepository: timeframe '${timeframe}' no soportado. ` +
        `Válidos: ${[...SUPPORTED_TIMEFRAMES].join(', ')}`
      );
    }
  }
}

export default CandleRepository;
