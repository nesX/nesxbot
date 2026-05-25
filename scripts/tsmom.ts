/**
 * scripts/tsmom.ts
 *
 * Backtest VECTORIZADO de time-series momentum (TSMOM) en un activo.
 * No usa el FillSimulator (que es de trades discretos): TSMOM es una estrategia de
 * RÉGIMEN — long mientras el momentum de N días es positivo, fuera si no. Se evalúa
 * con la serie de retornos: posición(t-1) · retorno(t), con fee por rebalanceo.
 *
 * Respaldo: Liu & Tsyvinski (RFS 2021) — el retorno predice retornos hasta ~8 semanas.
 *
 * Uso:
 *   npx tsx scripts/tsmom.ts --symbol BTCUSDT --from 2018-01-01 --to 2025-12-31 \
 *       --is-end 2022-12-31 --lookbacks 10,20,30,50,100 --fee 0.04 --mode long-flat
 */

import { loadEnv }    from './lib/env.js';
import { createPool } from './lib/db.js';
import CandleRepository from '../src/data/CandleRepository.js';

const YEAR = 365; // cripto opera todos los días

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (f: string, d = '') => { const i = a.indexOf(f); return i !== -1 && a[i + 1] ? a[i + 1]! : d; };
  return {
    symbol:    get('--symbol', 'BTCUSDT'),
    timeframe: get('--timeframe', '1d'),
    from:      Date.parse(`${get('--from', '2018-01-01')}T00:00:00Z`),
    to:        Date.parse(`${get('--to', '2025-12-31')}T23:59:59Z`),
    isEnd:     Date.parse(`${get('--is-end', '2022-12-31')}T23:59:59Z`),
    lookbacks: get('--lookbacks', '10,20,30,50,100').split(',').map(s => parseInt(s, 10)),
    feeFrac:   parseFloat(get('--fee', '0.04')) / 100,
    mode:      get('--mode', 'long-flat') as 'long-flat' | 'long-short',
    targetVol: parseFloat(get('--target-vol', '0.5')),   // vol anualizada objetivo (0.5 = 50%)
    volWindow: parseInt(get('--vol-window', '30'), 10),   // ventana de vol realizada (días)
    maxLev:    parseFloat(get('--max-lev', '1.5')),       // apalancamiento máximo del vol-targeting
  };
}

/** Retornos diarios de la estrategia: pos(t-1)·ret(t) menos fee por cambio de posición. */
function stratReturns(pos: number[], ret: number[], feeFrac: number): number[] {
  return ret.map((r, i) => {
    if (i === 0) return 0;
    const p = pos[i - 1]!;
    const change = Math.abs((pos[i - 1] ?? 0) - (pos[i - 2] ?? 0));
    return p * r - change * feeFrac;
  });
}

interface Metrics { ret: number; cagr: number; sharpe: number; maxDD: number; expoPct: number; trades: number; days: number; }

/** Métricas de una serie de retornos diarios de estrategia sobre [i0, i1]. */
function metricsOf(stratRet: number[], i0: number, i1: number, signals: number[]): Metrics {
  let equity = 1, peak = 1, maxDD = 0;
  const rets: number[] = [];
  let inMarket = 0, trades = 0;
  for (let i = i0; i <= i1; i++) {
    const r = stratRet[i] ?? 0;
    rets.push(r);
    equity *= (1 + r);
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
    // Exposición y "trades" por cambio de RÉGIMEN (signo), no por ajuste de tamaño.
    if (Math.sign(signals[i - 1] ?? 0) !== 0) inMarket++;
    if (Math.sign(signals[i] ?? 0) !== Math.sign(signals[i - 1] ?? 0)) trades++;
  }
  const n = rets.length;
  const mean = rets.reduce((s, x) => s + x, 0) / n;
  const variance = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  const cagr = Math.pow(equity, YEAR / n) - 1;
  return {
    ret: equity - 1,
    cagr,
    sharpe: std > 0 ? (mean / std) * Math.sqrt(YEAR) : 0,
    maxDD,
    expoPct: (inMarket / n) * 100,
    trades,
    days: n,
  };
}

function fmt(m: Metrics): string {
  return `ret ${(m.ret * 100).toFixed(0).padStart(5)}% | CAGR ${(m.cagr * 100).toFixed(1).padStart(6)}% | ` +
         `Sharpe ${m.sharpe.toFixed(2).padStart(5)} | maxDD ${(m.maxDD * 100).toFixed(0).padStart(3)}% | ` +
         `expo ${m.expoPct.toFixed(0).padStart(3)}% | trades ${String(m.trades).padStart(4)}`;
}

async function main(): Promise<void> {
  const cfg = parseArgs();
  loadEnv();
  const pool = createPool();
  try {
    const repo = new CandleRepository({ db: pool });
    const candles = await repo.getCandles(cfg.symbol, cfg.timeframe, cfg.from, cfg.to);
    if (candles.length < 200) { console.log(`Pocas velas (${candles.length})`); return; }

    const closes = candles.map(c => c.close);
    const times  = candles.map(c => c.openTime);
    const isEndIdx = times.findIndex(t => t > cfg.isEnd);
    const splitIdx = isEndIdx === -1 ? closes.length : isEndIdx;

    // Retornos diarios.
    const ret: number[] = closes.map((c, i) => i === 0 ? 0 : c / closes[i - 1]! - 1);

    // Buy & hold (referencia), señal = 1 siempre.
    const bhSignals = closes.map(() => 1);
    const bhStrat   = ret.slice();
    console.log(`\nTSMOM ${cfg.symbol} ${cfg.timeframe} · ${new Date(cfg.from).toISOString().slice(0,10)}→${new Date(cfg.to).toISOString().slice(0,10)} · fee ${(cfg.feeFrac*100).toFixed(2)}%/lado · modo ${cfg.mode}`);
    console.log(`Velas: ${closes.length} · split IS/OOS en ${new Date(cfg.isEnd).toISOString().slice(0,10)} (IS=${splitIdx}, OOS=${closes.length-splitIdx})\n`);
    console.log(`Buy & Hold:`);
    console.log(`  IS : ${fmt(metricsOf(bhStrat, 1, splitIdx - 1, bhSignals))}`);
    console.log(`  OOS: ${fmt(metricsOf(bhStrat, splitIdx, closes.length - 1, bhSignals))}\n`);

    // Volatilidad realizada anualizada (std de retornos de las últimas volWindow velas).
    const realVol: number[] = ret.map((_, i) => {
      if (i < cfg.volWindow) return NaN;
      const w = ret.slice(i - cfg.volWindow, i);
      const m = w.reduce((s, x) => s + x, 0) / w.length;
      const v = w.reduce((s, x) => s + (x - m) ** 2, 0) / w.length;
      return Math.sqrt(v) * Math.sqrt(YEAR);
    });

    console.log(`TSMOM por lookback — plain vs vol-targeted (objetivo ${(cfg.targetVol*100).toFixed(0)}% vol, vol-window ${cfg.volWindow}d, maxLev ${cfg.maxLev}):`);
    for (const N of cfg.lookbacks) {
      const signal: number[] = closes.map((c, i) => {
        if (i < N) return 0;
        const mom = c / closes[i - N]! - 1;
        return mom > 0 ? 1 : (cfg.mode === 'long-short' ? -1 : 0);
      });

      // Vol-targeting: escalar la posición por vol inversa (cap en maxLev).
      const volPos: number[] = signal.map((s, i) => {
        const rv = realVol[i];
        if (!rv || !isFinite(rv) || rv <= 0) return 0;
        return s * Math.min(cfg.targetVol / rv, cfg.maxLev);
      });

      const plain = stratReturns(signal, ret, cfg.feeFrac);
      const vt    = stratReturns(volPos, ret, cfg.feeFrac);

      console.log(`  N=${String(N).padStart(3)}d`);
      console.log(`    plain  IS : ${fmt(metricsOf(plain, 1, splitIdx - 1, signal))}`);
      console.log(`    plain  OOS: ${fmt(metricsOf(plain, splitIdx, closes.length - 1, signal))}`);
      console.log(`    volTgt IS : ${fmt(metricsOf(vt, 1, splitIdx - 1, volPos))}`);
      console.log(`    volTgt OOS: ${fmt(metricsOf(vt, splitIdx, closes.length - 1, volPos))}`);
    }
    console.log();
  } finally {
    await pool.end();
  }
}

main().catch(err => { console.error('Error:', (err as Error).message); process.exit(1); });
