/**
 * scripts/lib/InMemoryCandleRepository.ts
 *
 * Repositorio con caché en memoria para velas 1m.
 * Diseñado para grid search: pre-carga el rango completo una sola vez
 * y sirve todos los getCandles('1m') desde memoria, eliminando queries
 * repetidas a PG durante el loop de combinaciones.
 *
 * Las queries 1s y hasGranularData se delegan al repositorio real.
 */

import type { Candle, GranularDataInfo } from '../../src/types.js';
import CandleRepository from '../../src/data/CandleRepository.js';

/**
 * Búsqueda binaria sobre un array de velas ordenado por openTime ASC.
 * Retorna el slice [from, to] sin recorrer todo el array (O(log n) vs O(n)).
 *
 * @param candles - Array ordenado por openTime ASC
 * @param from    - openTime mínimo inclusivo (ms)
 * @param to      - openTime máximo inclusivo (ms)
 */
function sliceByOpenTime(candles: Candle[], from: number, to: number): Candle[] {
  if (candles.length === 0) return [];

  // Primer índice con openTime >= from
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((candles[mid] as Candle).openTime < from) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  const startIdx = lo;

  // Primer índice con openTime > to  (exclusivo)
  lo = startIdx;
  hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((candles[mid] as Candle).openTime <= to) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  const endIdx = lo; // exclusive

  return candles.slice(startIdx, endIdx);
}

class InMemoryCandleRepository {
  private _real: CandleRepository;
  private _candles1m = new Map<string, Candle[]>(); // key: symbol

  /** Cache de resultados de hasGranularData para evitar queries repetidas. */
  private _granularCache = new Map<string, GranularDataInfo>(); // key: `symbol:from:to`

  constructor(real: CandleRepository) {
    this._real = real;
  }

  /**
   * Pre-carga velas 1m para un símbolo y rango en memoria.
   * Llamar una sola vez antes del loop de backtests.
   */
  async preload(symbol: string, from: number, to: number): Promise<void> {
    const candles = await this._real.getCandles(symbol, '1m', from, to);
    this._candles1m.set(symbol, candles);
    console.error(`  [InMemoryRepo] Pre-cargadas ${candles.length} velas 1m para ${symbol}`);
  }

  /**
   * Carga velas 1m directamente desde un array (sin consultar la BD).
   * Usado por workers que reciben las velas pre-cargadas del proceso principal.
   */
  loadFromData(symbol: string, candles: Candle[]): void {
    this._candles1m.set(symbol, candles);
  }

  async getCandles(symbol: string, timeframe: string, from: number, to: number): Promise<Candle[]> {
    if (timeframe === '1m') {
      const all = this._candles1m.get(symbol);
      if (all) {
        return sliceByOpenTime(all, from, to);
      }
    }
    return this._real.getCandles(symbol, timeframe, from, to);
  }

  async hasGranularData(symbol: string, from: number, to: number): Promise<GranularDataInfo> {
    const key = `${symbol}:${from}:${to}`;
    const cached = this._granularCache.get(key);
    if (cached !== undefined) return cached;

    const result = await this._real.hasGranularData(symbol, from, to);
    this._granularCache.set(key, result);
    return result;
  }
}

export default InMemoryCandleRepository;
