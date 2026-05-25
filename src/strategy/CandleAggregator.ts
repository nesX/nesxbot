import type { Candle } from '../types.js';

/**
 * Agrega velas de 1 minuto en velas de N minutos, ALINEADAS al reloj.
 *
 * Cada vela agregada cubre el bucket [k·N, (k+1)·N) minutos desde epoch, de modo
 * que coincide con las velas del exchange/TradingView (p.ej. 15m → :00, :15, :30, :45).
 * El `openTime` resultante es el inicio del bucket, no el de la primera vela.
 *
 * Solo se emiten buckets COMPLETOS (con N velas de 1m). El bucket en progreso al
 * final, o cualquier bucket con huecos, se descarta — los consumidores pueden
 * confiar en que cada vela devuelta es un período cerrado.
 *
 * Las velas de entrada deben estar ordenadas por openTime ASC y ser de 1m.
 *
 * @param candles        - Velas de 1m ordenadas ASC
 * @param intervalMinutes - Tamaño del bucket (entero > 0)
 * @returns Velas agregadas alineadas al reloj, ASC
 */
export function aggregateCandles(candles: Candle[], intervalMinutes: number): Candle[] {
  if (!Number.isInteger(intervalMinutes) || intervalMinutes <= 0) {
    throw new Error(`CandleAggregator: intervalMinutes debe ser un entero positivo, recibido: ${intervalMinutes}`);
  }
  if (candles.length === 0) return [];
  if (intervalMinutes === 1) return candles.slice();

  const bucketMs = intervalMinutes * 60_000;

  // Agrupar por bucket de reloj. El input está ordenado ASC, así que el orden de
  // inserción del Map ya es cronológico.
  const buckets = new Map<number, Candle[]>();
  for (const c of candles) {
    const bucketStart = Math.floor(c.openTime / bucketMs) * bucketMs;
    const group = buckets.get(bucketStart);
    if (group) group.push(c);
    else buckets.set(bucketStart, [c]);
  }

  const result: Candle[] = [];
  for (const [bucketStart, group] of buckets) {
    if (group.length === intervalMinutes) {   // solo buckets completos
      result.push(_mergeGroup(group, bucketStart, intervalMinutes));
    }
  }
  return result;
}

/**
 * Combina un grupo de velas 1m en una sola vela agregada con openTime alineado.
 */
function _mergeGroup(group: Candle[], bucketStart: number, intervalMinutes: number): Candle {
  const first = group[0];
  const last  = group[group.length - 1];

  let high   = first.high;
  let low    = first.low;
  let volume = 0;

  for (const c of group) {
    if (c.high > high) high = c.high;
    if (c.low  < low)  low  = c.low;
    volume += c.volume;
  }

  return {
    symbol:    first.symbol,
    timeframe: `${intervalMinutes}m`,
    openTime:  bucketStart,
    open:      first.open,
    high,
    low,
    close:     last.close,
    volume,
    isClosed:  true,
  };
}
