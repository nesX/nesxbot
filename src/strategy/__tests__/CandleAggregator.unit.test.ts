import { aggregateCandles } from '../CandleAggregator.js';
import type { Candle } from '../../types.js';

const MIN = 60_000;
const BASE = Date.UTC(2024, 0, 1, 10, 0, 0); // 2024-01-01 10:00:00 UTC (alineado)

function mk(openTime: number, o: number, h: number, l: number, c: number, v = 1): Candle {
  return { symbol: 'BTCUSDT', timeframe: '1m', openTime, open: o, high: h, low: l, close: c, volume: v, isClosed: true };
}

/** Serie de n velas 1m consecutivas desde `start`. */
function series(start: number, n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => mk(start + i * MIN, 100 + i, 100 + i + 1, 100 + i - 1, 100 + i));
}

describe('aggregateCandles', () => {
  test('vacío → []', () => {
    expect(aggregateCandles([], 5)).toEqual([]);
  });

  test('intervalo 1 → copia', () => {
    const c = series(BASE, 3);
    const out = aggregateCandles(c, 1);
    expect(out).toEqual(c);
    expect(out).not.toBe(c); // copia, no la misma referencia
  });

  test('lanza si intervalo no es entero positivo', () => {
    expect(() => aggregateCandles(series(BASE, 5), 0)).toThrow();
    expect(() => aggregateCandles(series(BASE, 5), 1.5)).toThrow();
  });

  test('alinea al reloj y descarta buckets incompletos (5m desde :03)', () => {
    // velas 10:03 .. 10:20 (18 velas)
    const start = BASE + 3 * MIN;
    const out = aggregateCandles(series(start, 18), 5);
    // buckets completos: [10:05,10:10), [10:10,10:15), [10:15,10:20)
    expect(out.map(c => c.openTime)).toEqual([
      BASE + 5 * MIN, BASE + 10 * MIN, BASE + 15 * MIN,
    ]);
    expect(out.every(c => c.timeframe === '5m')).toBe(true);
    expect(out.every(c => c.openTime % (5 * MIN) === 0)).toBe(true); // alineado
  });

  test('OHLCV correcto en un bucket completo', () => {
    // bucket [10:00,10:05): 5 velas con O=100..104
    const out = aggregateCandles(series(BASE, 5), 5);
    expect(out).toHaveLength(1);
    const agg = out[0]!;
    expect(agg.openTime).toBe(BASE);
    expect(agg.open).toBe(100);          // open de la primera
    expect(agg.close).toBe(104);         // close de la última
    expect(agg.high).toBe(105);          // max high (104+1)
    expect(agg.low).toBe(99);            // min low (100-1)
    expect(agg.volume).toBe(5);          // suma
  });

  test('bucket en progreso al final se descarta', () => {
    // 7 velas alineadas desde :00, interval 5 → un bucket completo [00,05), y [05,10) incompleto (2 velas)
    const out = aggregateCandles(series(BASE, 7), 5);
    expect(out).toHaveLength(1);
    expect(out[0]!.openTime).toBe(BASE);
  });
});
