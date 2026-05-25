export interface RSIResult {
  rsi: number;
  avgGain: number;
  avgLoss: number;
}

export function rsiStep(prev: RSIResult, change: number, period: number = 14): RSIResult {
  const gain = Math.max(change, 0);
  const loss = Math.max(-change, 0);
  const avgGain = (prev.avgGain * (period - 1) + gain) / period;
  const avgLoss = (prev.avgLoss * (period - 1) + loss) / period;
  const rsiValue = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  return { rsi: rsiValue, avgGain, avgLoss };
}

function _seed(closes: number[], period: number): RSIResult | null {
  // Need period+1 closes to compute the first period changes
  if (closes.length < period + 1) return null;

  let totalGain = 0;
  let totalLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i]! - closes[i - 1]!;
    totalGain += Math.max(change, 0);
    totalLoss += Math.max(-change, 0);
  }
  const avgGain = totalGain / period;
  const avgLoss = totalLoss / period;
  const rsiValue = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  return { rsi: rsiValue, avgGain, avgLoss };
}

export function rsiArray(closes: number[], period: number = 14): (number | null)[] {
  const result: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return result;

  const seedState = _seed(closes, period);
  if (seedState === null) return result;

  result[period] = seedState.rsi;
  let state = seedState;

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i]! - closes[i - 1]!;
    state = rsiStep(state, change, period);
    result[i] = state.rsi;
  }
  return result;
}

export function rsi(closes: number[], period: number = 14): number | null {
  const arr = rsiArray(closes, period);
  const last = arr[arr.length - 1];
  return last ?? null;
}
