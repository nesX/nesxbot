/**
 * scripts/hammer-forward.ts
 *
 * Fase 2 del experimento hammer-1s: mide QUÉ PASA DESPUÉS de cada martillo de
 * volumen anormal, separando dos fenómenos que observamos:
 *   - ABSORCIÓN: volumen altísimo, rango chico (mucho volumen, poco movimiento).
 *   - BARRIDO:   rango grande, volumen moderado (el volumen mueve el precio).
 *
 * Para cada evento mide el retorno forward (bps) a varios horizontes y lo agrega
 * por tipo (hammer/inverted) × fenómeno × contexto. Responde: ¿hay reversión o
 * continuación explotable? (retorno bruto — el costo se evalúa después).
 *
 * Uso:
 *   npx tsx scripts/hammer-forward.ts --symbol BTCUSDT --from 2025-01-01 --to 2025-12-31 \
 *       --vol-mult 5 --horizons 30,60,300,900
 */

import { loadEnv }    from './lib/env.js';
import { createPool } from './lib/db.js';
import CandleRepository from '../src/data/CandleRepository.js';
import type { Candle } from '../src/types.js';

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (f: string, d = '') => { const i = a.indexOf(f); return i !== -1 && a[i + 1] ? a[i + 1]! : d; };
  return {
    symbol:    get('--symbol', 'BTCUSDT'),
    from:      Date.parse(`${get('--from', '2025-01-01')}T00:00:00Z`),
    to:        Date.parse(`${get('--to', '2025-12-31')}T23:59:59Z`),
    volWindow: parseInt(get('--vol-window', '60'), 10),
    volMult:   parseFloat(get('--vol-mult', '5')),
    wickFrac:  parseFloat(get('--wick-frac', '0.6')),
    maxOpp:    parseFloat(get('--max-opp', '0.15')),
    minRangeBps: parseFloat(get('--min-range-bps', '2')),
    horizons:  get('--horizons', '30,60,300,900').split(',').map(s => parseInt(s, 10)),
    // Segmentación de fenómenos:
    absVol:    parseFloat(get('--abs-vol', '20')),     // absorción: vol >= absVol
    absRange:  parseFloat(get('--abs-range', '15')),   // y rango <= absRange bps
    sweepRange: parseFloat(get('--sweep-range', '50')),// barrido: rango >= sweepRange bps
  };
}

type HType = 'hammer' | 'inverted';
interface Event { ms: number; type: HType; vr: number; rangeBps: number; close: number; fwd: number[]; }

function classify(c: Candle, cfg: ReturnType<typeof parseArgs>): { type: HType | null; rangeBps: number } {
  const range = c.high - c.low;
  const rangeBps = c.close > 0 ? (range / c.close) * 1e4 : 0;
  if (range <= 0 || rangeBps < cfg.minRangeBps) return { type: null, rangeBps };
  const bodyTop = Math.max(c.open, c.close), bodyBot = Math.min(c.open, c.close);
  const lowerPct = (bodyBot - c.low) / range, upperPct = (c.high - bodyTop) / range;
  if (lowerPct >= cfg.wickFrac && upperPct <= cfg.maxOpp) return { type: 'hammer', rangeBps };
  if (upperPct >= cfg.wickFrac && lowerPct <= cfg.maxOpp) return { type: 'inverted', rangeBps };
  return { type: null, rangeBps };
}

/** Stats de retorno forward de un grupo de eventos para un índice de horizonte. */
function agg(events: Event[], hi: number): { n: number; meanBps: number; pctUp: number } {
  const vals = events.map(e => e.fwd[hi]!).filter(v => !Number.isNaN(v));
  if (vals.length === 0) return { n: 0, meanBps: 0, pctUp: 0 };
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const up = vals.filter(v => v > 0).length;
  return { n: vals.length, meanBps: mean, pctUp: (up / vals.length) * 100 };
}

async function main(): Promise<void> {
  const cfg = parseArgs();
  loadEnv();
  const pool = createPool();
  try {
    const repo = new CandleRepository({ db: pool });
    const maxH = Math.max(...cfg.horizons);
    const events: Event[] = [];
    const DAY = 24 * 60 * 60 * 1000;
    let prevTail: Candle[] = [];
    let days = 0;

    for (let dayStart = cfg.from; dayStart <= cfg.to; dayStart += DAY) {
      const dayEnd = Math.min(dayStart + DAY - 1, cfg.to);
      // Cargar el día + buffer del horizonte máximo (para el retorno forward).
      const loaded = await repo.getCandles(cfg.symbol, '1s', dayStart, dayEnd + maxH * 1000);
      days++;
      if (loaded.length === 0) { prevTail = []; continue; }

      const series = [...prevTail, ...loaded];
      const offset = prevTail.length;

      for (let i = offset; i < series.length; i++) {
        const c = series[i]!;
        if (c.openTime > dayEnd) break;        // solo eventos dentro del día
        if (i < cfg.volWindow) continue;
        const k = classify(c, cfg);
        if (!k.type) continue;
        let sum = 0; for (let j = i - cfg.volWindow; j < i; j++) sum += series[j]!.volume;
        const avg = sum / cfg.volWindow;
        if (avg <= 0) continue;
        const vr = c.volume / avg;
        if (vr < cfg.volMult) continue;

        // Retornos forward por horizonte.
        const fwd: number[] = cfg.horizons.map(h => {
          const target = c.openTime + h * 1000;
          let p = -1;
          for (let j = i + 1; j < series.length; j++) { if (series[j]!.openTime >= target) { p = j; break; } }
          if (p === -1) return NaN;
          return (series[p]!.close / c.close - 1) * 1e4;  // bps
        });

        events.push({ ms: c.openTime, type: k.type, vr, rangeBps: k.rangeBps, close: c.close, fwd });
      }
      prevTail = loaded.filter(x => x.openTime <= dayEnd).slice(-cfg.volWindow);
      if (days % 60 === 0) process.stderr.write(`  ...${days} días, ${events.length} eventos\n`);
    }

    // Segmentar
    const isAbs   = (e: Event) => e.vr >= cfg.absVol && e.rangeBps <= cfg.absRange;
    const isSweep = (e: Event) => e.rangeBps >= cfg.sweepRange;
    const groups: { label: string; ev: Event[] }[] = [
      { label: 'ABSORCIÓN hammer',   ev: events.filter(e => e.type === 'hammer'   && isAbs(e)) },
      { label: 'ABSORCIÓN inverted', ev: events.filter(e => e.type === 'inverted' && isAbs(e)) },
      { label: 'BARRIDO hammer',     ev: events.filter(e => e.type === 'hammer'   && isSweep(e)) },
      { label: 'BARRIDO inverted',   ev: events.filter(e => e.type === 'inverted' && isSweep(e)) },
      { label: 'TODOS hammer (≥5×)', ev: events.filter(e => e.type === 'hammer') },
      { label: 'TODOS inverted (≥5×)', ev: events.filter(e => e.type === 'inverted') },
    ];

    console.log(`\nHammer forward ${cfg.symbol} 1s · ${new Date(cfg.from).toISOString().slice(0,10)}→${new Date(cfg.to).toISOString().slice(0,10)}`);
    console.log(`Eventos ≥${cfg.volMult}×: ${events.length} · horizontes (s): ${cfg.horizons.join(', ')}`);
    console.log(`Absorción = vol≥${cfg.absVol}× y rango≤${cfg.absRange}bps · Barrido = rango≥${cfg.sweepRange}bps`);
    console.log(`(retorno forward en bps; + = precio sube. Referencia de costo taker ≈ 9 bps round-trip)\n`);

    const hdr = 'Grupo'.padEnd(24) + 'n'.padStart(7) + cfg.horizons.map(h => `+${h}s`.padStart(18)).join('');
    console.log(hdr);
    console.log('─'.repeat(hdr.length));
    for (const g of groups) {
      let line = g.label.padEnd(24) + String(g.ev.length).padStart(7);
      for (let hi = 0; hi < cfg.horizons.length; hi++) {
        const a = agg(g.ev, hi);
        line += `${a.meanBps >= 0 ? '+' : ''}${a.meanBps.toFixed(1)}bps/${a.pctUp.toFixed(0)}%↑`.padStart(18);
      }
      console.log(line);
    }
    console.log();
  } finally {
    await pool.end();
  }
}

main().catch(err => { console.error('Error:', (err as Error).message); process.exit(1); });
