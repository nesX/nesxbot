/**
 * scripts/lib/fingerprint.ts
 *
 * Huella única de una corrida de backtest, para deduplicar: no re-correr algo
 * que ya se corrió con el mismo motor.
 *
 * fingerprint = sha1( engineVersion + strategyType + params + symbol + from + to )
 *
 * Los params se serializan con claves ordenadas recursivamente para que el mismo
 * conjunto de params produzca siempre la misma huella, sin importar el orden.
 */

import { createHash } from 'crypto';

/** JSON con claves ordenadas recursivamente (determinista). */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

export interface FingerprintInput {
  engineVersion: string;
  strategyType: string;
  params: Record<string, unknown>;
  symbol: string;
  from: number;
  to: number;
}

export function computeFingerprint(input: FingerprintInput): string {
  const canonical = [
    input.engineVersion,
    input.strategyType,
    stableStringify(input.params),
    input.symbol,
    String(input.from),
    String(input.to),
  ].join('|');
  return createHash('sha1').update(canonical).digest('hex');
}
