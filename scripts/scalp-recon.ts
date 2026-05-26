/**
 * scripts/scalp-recon.ts
 *
 * Caracterización estadística de muy corto plazo (velas 1s) para responder, ANTES
 * de construir nada de scalping: ¿hay estructura explotable a horizonte de segundos,
 * neta de un costo realista (fee + spread)?
 *
 * Mide:
 *  - Autocorrelación de los retornos 1s a lags 1..N (momentum>0 / reversión<0 / ruido≈0).
 *  - Variance-ratio a varios horizontes (VR<1 reversión, >1 tendencia, =1 random walk).
 *  - Tamaño típico del movimiento 1s (bps) vs costo round-trip → ¿captura un taker algo?
 *
 * Solo OHLCV 1s — NO microestructura (libro/flujo). Es el techo de lo que se puede
 * decir con nuestros datos; el edge real de scalping requiere order book (feature aparte).
 *
 * Uso:
 *   npx tsx scripts/scalp-recon.ts --symbol BTCUSDT --from 2025-03-01 --to 2025-03-08 --cost-bps 9
 */

import { loadEnv }    from './lib/env.js';
import { createPool } from './lib/db.js';
import CandleRepository from '../src/data/CandleRepository.js';

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (f: string, d = '') => { const i = a.indexOf(f); return i !== -1 && a[i + 1] ? a[i + 1]! : d; };
  return {
    symbol:  get('--symbol', 'BTCUSDT'),
    from:    Date.parse(`${get('--from', '2025-03-01')}T00:00:00Z`),
    to:      Date.parse(`${get('--to', '2025-03-08')}T23:59:59Z`),
    maxLag:  parseInt(get('--max-lag', '10'), 10),
    costBps: parseFloat(get('--cost-bps', '9')),   // costo round-trip: ~8bp fee taker + ~1bp spread
  };
}

function mean(x: number[]): number { return x.reduce((s, v) => s + v, 0) / x.length; }
function variance(x: number[], m = mean(x)): number { return x.reduce((s, v) => s + (v - m) ** 2, 0) / x.length; }

/** Autocorrelación de la serie x al lag k. */
function autocorr(x: number[], k: number): number {
  const n = x.length;
  const m = mean(x);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) den += (x[i]! - m) ** 2;
  for (let i = k; i < n; i++) num += (x[i]! - m) * (x[i - k]! - m);
  return den > 0 ? num / den : 0;
}

/** Variance ratio VR(k) con retornos k-periodo solapados. <1 reversión, >1 tendencia. */
function varianceRatio(r: number[], k: number): number {
  const var1 = variance(r);
  if (var1 === 0) return 1;
  const rk: number[] = [];
  for (let i = k; i < r.length; i++) {
    let s = 0;
    for (let j = 0; j < k; j++) s += r[i - j]!;
    rk.push(s);
  }
  return variance(rk) / (k * var1);
}

async function main(): Promise<void> {
  const cfg = parseArgs();
  loadEnv();
  const pool = createPool();
  try {
    const repo = new CandleRepository({ db: pool });
    const candles = await repo.getCandles(cfg.symbol, '1s', cfg.from, cfg.to);
    if (candles.length < 1000) { console.log(`Pocas velas 1s (${candles.length})`); return; }

    // Retornos 1s solo entre velas contiguas (gap exacto de 1s); BTC 1s es denso.
    const r: number[] = [];
    let gaps = 0;
    for (let i = 1; i < candles.length; i++) {
      if (candles[i]!.openTime - candles[i - 1]!.openTime === 1000 && candles[i - 1]!.close > 0) {
        r.push(candles[i]!.close / candles[i - 1]!.close - 1);
      } else { gaps++; }
    }

    const stdBps = Math.sqrt(variance(r)) * 1e4;
    const absMeanBps = mean(r.map(Math.abs)) * 1e4;

    console.log(`\nScalp recon ${cfg.symbol} 1s · ${new Date(cfg.from).toISOString().slice(0,10)}→${new Date(cfg.to).toISOString().slice(0,10)}`);
    console.log(`Velas 1s: ${candles.length} · retornos: ${r.length} · gaps: ${gaps}`);
    console.log(`Movimiento típico 1s: std ${stdBps.toFixed(2)} bps · |media| ${absMeanBps.toFixed(2)} bps`);
    console.log(`Costo round-trip asumido: ${cfg.costBps} bps (fee taker + spread)\n`);

    console.log(`Autocorrelación de retornos 1s (signo: + momentum, - reversión):`);
    for (let k = 1; k <= cfg.maxLag; k++) {
      const ac = autocorr(r, k);
      const bar = '█'.repeat(Math.min(40, Math.round(Math.abs(ac) * 400)));
      console.log(`  lag ${String(k).padStart(2)}s: ${ac >= 0 ? ' ' : '-'}${Math.abs(ac).toFixed(4)} ${bar}`);
    }

    console.log(`\nVariance ratio (VR<1 reversión, >1 tendencia, ≈1 random walk):`);
    for (const k of [2, 5, 10, 30, 60]) {
      console.log(`  VR(${String(k).padStart(2)}s): ${varianceRatio(r, k).toFixed(3)}`);
    }

    // ¿Hay edge capturable por un taker? El edge por trade ≈ |ACF(1)| * std (muy aprox).
    const edge1Bps = Math.abs(autocorr(r, 1)) * stdBps;
    console.log(`\nVeredicto (taker):`);
    console.log(`  Edge aproximado de 1 paso ≈ |ACF(1)|·std ≈ ${edge1Bps.toFixed(2)} bps`);
    console.log(`  vs costo round-trip ${cfg.costBps} bps → ${edge1Bps > cfg.costBps ? 'POSIBLE (revisar)' : 'NO capturable (costo > edge)'}`);
    console.log();
  } finally {
    await pool.end();
  }
}

main().catch(err => { console.error('Error:', (err as Error).message); process.exit(1); });
