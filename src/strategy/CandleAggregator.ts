import type { Candle } from '../types.js';

/**
 * Agrega velas de 1 minuto en velas de N minutos.
 *
 * Las velas de entrada deben estar ordenadas por openTime ASC y ser
 * de timeframe 1m. El resultado son velas completas (grupos de exactamente
 * N velas de entrada). Las velas sobrantes al final que no completan un
 * grupo se descartan.
 *
 * @param candles        - Velas de 1m ordenadas ASC
 * @param intervalMinutes - Tamaño del grupo (2, 5, 15, 100, 131, cualquier entero > 0)
 * @returns Velas agregadas ordenadas ASC
 */
export function aggregateCandles(candles: Candle[], intervalMinutes: number): Candle[] {
  if (!Number.isInteger(intervalMinutes) || intervalMinutes <= 0) {
    throw new Error(`CandleAggregator: intervalMinutes debe ser un entero positivo, recibido: ${intervalMinutes}`);
  }
  if (candles.length === 0) return [];
  if (intervalMinutes === 1) return candles.slice();

  const result: Candle[] = [];
  const totalGroups = Math.floor(candles.length / intervalMinutes);

  for (let g = 0; g < totalGroups; g++) {
    const start = g * intervalMinutes;
    const group = candles.slice(start, start + intervalMinutes);
    result.push(_mergeGroup(group, intervalMinutes));
  }

  return result;
}

/**
 * Combina un grupo de velas 1m en una sola vela agregada.
 */
function _mergeGroup(group: Candle[], intervalMinutes: number): Candle {
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
    openTime:  first.openTime,
    open:      first.open,
    high,
    low,
    close:     last.close,
    volume,
    isClosed:  true,
  };
}
