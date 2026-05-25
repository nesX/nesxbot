import { sma } from './sma.js';

export function emaStep(prevEma: number, newValue: number, period: number): number {
  const multiplier = 2 / (period + 1);
  return (newValue - prevEma) * multiplier + prevEma;
}

export function emaArray(values: number[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return result;

  const seed = sma(values.slice(0, period), period);
  if (seed === null) return result;

  result[period - 1] = seed;
  for (let i = period; i < values.length; i++) {
    result[i] = emaStep(result[i - 1] as number, values[i]!, period);
  }
  return result;
}

export function ema(values: number[], period: number): number | null {
  const arr = emaArray(values, period);
  const last = arr[arr.length - 1];
  return last ?? null;
}
