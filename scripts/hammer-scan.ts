/**
 * scripts/hammer-scan.ts
 *
 * Cataloga velas de 1 segundo que son MARTILLOS (o martillos invertidos) con
 * VOLUMEN ANORMAL en BTC (u otro símbolo). No busca patrones todavía — solo
 * encuentra y guarda los timestamps exactos para estudiarlos después.
 *
 * Martillo (bullish):   mecha inferior larga, cuerpo arriba, mecha superior pequeña.
 * Martillo invertido:   mecha superior larga, cuerpo abajo, mecha inferior pequeña.
 * Volumen anormal:      volumen >= volMult × promedio de las últimas volWindow velas.
 * Contexto:             'consecutivo' (otro evento del mismo tipo en ±consecSec) o 'aislado'.
 *
 * Escanea día por día (memoria acotada). Guarda CSV en results/hammer-scan/.
 *
 * Uso:
 *   npx tsx scripts/hammer-scan.ts --symbol BTCUSDT --from 2025-01-01 --to 2025-03-31 \
 *       --vol-mult 5 --vol-window 60
 */

import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
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
    to:        Date.parse(`${get('--to', '2025-03-31')}T23:59:59Z`),
    volWindow: parseInt(get('--vol-window', '60'), 10),   // velas previas para el promedio de volumen
    volMult:   parseFloat(get('--vol-mult', '5')),         // volumen >= volMult × promedio = anormal
    wickFrac:  parseFloat(get('--wick-frac', '0.6')),      // mecha dominante >= wickFrac × rango
    maxOpp:    parseFloat(get('--max-opp', '0.15')),       // mecha opuesta <= maxOpp × rango
    minRangeBps: parseFloat(get('--min-range-bps', '2')),  // rango mínimo (bps del precio) para filtrar velas planas
    consecSec: parseInt(get('--consec-sec', '5'), 10),     // ventana para marcar 'consecutivo'
  };
}

type HType = 'hammer' | 'inverted';
interface Event {
  ms: number; type: HType; close: number; volume: number; volRatio: number;
  rangeBps: number; lowerPct: number; upperPct: number; bodyPct: number; context: string;
}

/** Clasifica geometría de la vela: martillo, invertido o ninguno. */
function classifyShape(c: Candle, cfg: ReturnType<typeof parseArgs>): { type: HType | null; lowerPct: number; upperPct: number; bodyPct: number; rangeBps: number } {
  const range = c.high - c.low;
  const rangeBps = c.close > 0 ? (range / c.close) * 1e4 : 0;
  if (range <= 0 || rangeBps < cfg.minRangeBps) return { type: null, lowerPct: 0, upperPct: 0, bodyPct: 0, rangeBps };

  const bodyTop = Math.max(c.open, c.close);
  const bodyBot = Math.min(c.open, c.close);
  const lowerWick = bodyBot - c.low;
  const upperWick = c.high - bodyTop;
  const body      = bodyTop - bodyBot;

  const lowerPct = lowerWick / range;
  const upperPct = upperWick / range;
  const bodyPct  = body / range;

  let type: HType | null = null;
  if (lowerPct >= cfg.wickFrac && upperPct <= cfg.maxOpp) type = 'hammer';
  else if (upperPct >= cfg.wickFrac && lowerPct <= cfg.maxOpp) type = 'inverted';

  return { type, lowerPct, upperPct, bodyPct, rangeBps };
}

async function main(): Promise<void> {
  const cfg = parseArgs();
  loadEnv();
  const pool = createPool();
  try {
    const repo = new CandleRepository({ db: pool });
    const events: Event[] = [];

    const DAY = 24 * 60 * 60 * 1000;
    let prevTail: Candle[] = [];   // últimas volWindow velas del día anterior (para el promedio rodante)
    let totalCandles = 0, scannedDays = 0;

    for (let dayStart = cfg.from; dayStart <= cfg.to; dayStart += DAY) {
      const dayEnd = Math.min(dayStart + DAY - 1, cfg.to);
      const dayCandles = await repo.getCandles(cfg.symbol, '1s', dayStart, dayEnd);
      scannedDays++;
      if (dayCandles.length === 0) { prevTail = []; continue; }
      totalCandles += dayCandles.length;

      const series = [...prevTail, ...dayCandles];
      const offset = prevTail.length;

      for (let i = offset; i < series.length; i++) {
        if (i < cfg.volWindow) continue;
        const c = series[i]!;
        const shape = classifyShape(c, cfg);
        if (!shape.type) continue;

        // Volumen promedio de las volWindow velas previas.
        let sum = 0;
        for (let j = i - cfg.volWindow; j < i; j++) sum += series[j]!.volume;
        const avg = sum / cfg.volWindow;
        if (avg <= 0) continue;
        const volRatio = c.volume / avg;
        if (volRatio < cfg.volMult) continue;

        events.push({
          ms: c.openTime, type: shape.type, close: c.close, volume: c.volume, volRatio,
          rangeBps: shape.rangeBps, lowerPct: shape.lowerPct, upperPct: shape.upperPct,
          bodyPct: shape.bodyPct, context: '',
        });
      }

      prevTail = dayCandles.slice(-cfg.volWindow);
      if (scannedDays % 30 === 0) process.stderr.write(`  ...escaneados ${scannedDays} días, ${events.length} eventos\n`);
    }

    // Clasificar contexto: consecutivo (otro evento del mismo tipo en ±consecSec) vs aislado.
    const consecMs = cfg.consecSec * 1000;
    for (let i = 0; i < events.length; i++) {
      const e = events[i]!;
      const prev = events[i - 1];
      const next = events[i + 1];
      const near = (o?: Event) => o && o.type === e.type && Math.abs(o.ms - e.ms) <= consecMs;
      e.context = (near(prev) || near(next)) ? 'consecutivo' : 'aislado';
    }

    // Resumen
    const byType = (t: HType) => events.filter(e => e.type === t);
    const ham = byType('hammer'), inv = byType('inverted');
    console.log(`\nHammer scan ${cfg.symbol} 1s · ${new Date(cfg.from).toISOString().slice(0,10)}→${new Date(cfg.to).toISOString().slice(0,10)}`);
    console.log(`Días: ${scannedDays} · velas: ${totalCandles.toLocaleString()} · criterio: vol>=${cfg.volMult}×prom(${cfg.volWindow}), mecha>=${cfg.wickFrac}, opp<=${cfg.maxOpp}, rango>=${cfg.minRangeBps}bps`);
    console.log(`Eventos: ${events.length}  (martillos ${ham.length}, invertidos ${inv.length})`);
    console.log(`  consecutivos: ${events.filter(e=>e.context==='consecutivo').length} · aislados: ${events.filter(e=>e.context==='aislado').length}`);

    // Top por volumen anormal (los más extremos)
    const top = [...events].sort((a,b)=>b.volRatio-a.volRatio).slice(0, 15);
    console.log(`\nTop 15 por volumen anormal:`);
    for (const e of top) {
      console.log(`  ${new Date(e.ms).toISOString().replace('T',' ').slice(0,19)}  ${e.type.padEnd(8)} vol×${e.volRatio.toFixed(1).padStart(6)}  rango ${e.rangeBps.toFixed(1)}bps  ${e.context}`);
    }

    // Guardar CSV
    const dir = resolve(process.cwd(), 'results/hammer-scan');
    mkdirSync(dir, { recursive: true });
    const path = resolve(dir, `${cfg.symbol}_1s_hammers_${new Date(cfg.from).toISOString().slice(0,10)}_${new Date(cfg.to).toISOString().slice(0,10)}.csv`);
    const headers = ['timestamp_iso','timestamp_ms','type','context','volume','vol_ratio','range_bps','lower_pct','upper_pct','body_pct','close'];
    const rows = events.map(e => [
      new Date(e.ms).toISOString(), e.ms, e.type, e.context,
      e.volume, e.volRatio.toFixed(2), e.rangeBps.toFixed(2),
      e.lowerPct.toFixed(3), e.upperPct.toFixed(3), e.bodyPct.toFixed(3), e.close,
    ].join(','));
    writeFileSync(path, [headers.join(','), ...rows].join('\n'), 'utf-8');
    console.log(`\nCatálogo guardado → results/hammer-scan/${path.split('/').pop()}  (${events.length} filas)\n`);
  } finally {
    await pool.end();
  }
}

main().catch(err => { console.error('Error:', (err as Error).message); process.exit(1); });
