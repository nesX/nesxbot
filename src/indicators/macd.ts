import { emaArray, emaStep } from './ema.js';

export interface MACDResult {
  macd: number;
  signal: number;
  histogram: number;
}

export interface MACDConfig {
  fastPeriod?: number;
  slowPeriod?: number;
  signalPeriod?: number;
}

export function macdArray(closes: number[], config?: MACDConfig): (MACDResult | null)[] {
  const fastPeriod   = config?.fastPeriod   ?? 12;
  const slowPeriod   = config?.slowPeriod   ?? 26;
  const signalPeriod = config?.signalPeriod ?? 9;

  const result: (MACDResult | null)[] = new Array(closes.length).fill(null);

  const fastEmas = emaArray(closes, fastPeriod);
  const slowEmas = emaArray(closes, slowPeriod);

  // MACD line: only valid where both EMAs are available (slowPeriod - 1 is the first valid index)
  const macdLine: (number | null)[] = closes.map((_, i) => {
    const f = fastEmas[i];
    const s = slowEmas[i];
    return f !== null && s !== null ? f - s : null;
  });

  // Signal: EMA of the MACD line — seed from the first signalPeriod valid MACD values
  const firstValidMacd = macdLine.findIndex(v => v !== null);
  if (firstValidMacd === -1) return result;

  // Collect valid MACD values from firstValidMacd onward for seeding
  const validMacdValues: number[] = [];
  const validMacdIndices: number[] = [];
  for (let i = firstValidMacd; i < macdLine.length; i++) {
    const v = macdLine[i];
    if (v !== null) {
      validMacdValues.push(v);
      validMacdIndices.push(i);
    }
  }

  if (validMacdValues.length < signalPeriod) return result;

  // Seed: SMA of first signalPeriod MACD values
  const seedSignal = validMacdValues.slice(0, signalPeriod).reduce((s, v) => s + v, 0) / signalPeriod;
  const seedIdx    = validMacdIndices[signalPeriod - 1]!;

  const macdAtSeed = macdLine[seedIdx]!;
  result[seedIdx]  = { macd: macdAtSeed, signal: seedSignal, histogram: macdAtSeed - seedSignal };

  let prevSignal = seedSignal;
  for (let k = signalPeriod; k < validMacdValues.length; k++) {
    const idx         = validMacdIndices[k]!;
    const macdVal     = validMacdValues[k]!;
    const signalVal   = emaStep(prevSignal, macdVal, signalPeriod);
    result[idx]       = { macd: macdVal, signal: signalVal, histogram: macdVal - signalVal };
    prevSignal        = signalVal;
  }

  return result;
}

export function macd(closes: number[], config?: MACDConfig): MACDResult | null {
  const arr  = macdArray(closes, config);
  const last = arr[arr.length - 1];
  return last ?? null;
}
