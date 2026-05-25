/**
 * scripts/grid-search.ts
 *
 * Búsqueda exhaustiva de la mejor combinación de parámetros para SpinningTopFibStrategy.
 * Corre N workers en paralelo, cada uno con un subconjunto de combinaciones.
 *
 * Uso:
 *   npm run grid-search
 *   npm run grid-search -- --symbol BTCUSDT --from 2025-01-01 --to 2025-03-31
 *   npm run grid-search -- --workers 6 --top 20 --sort expectancy
 *   npm run grid-search -- --min-trades 50 --min-winrate 55 --max-dd 15
 */

import { spawn }       from 'child_process';
import { writeFileSync } from 'fs';
import { resolve }     from 'path';
import os              from 'os';
import { fileURLToPath } from 'url';

import { loadEnv }               from './lib/env.js';
import { createPool }            from './lib/db.js';
import CandleRepository          from '../src/data/CandleRepository.js';
import InMemoryCandleRepository  from './lib/InMemoryCandleRepository.js';
import type { ComboParams, ComboResult } from './grid-search-worker.js';

// ---------------------------------------------------------------------------
// Grid de parámetros
// ---------------------------------------------------------------------------

const GRID = {
  candleInterval:    [1],
  tp1RR:             [1.0],
  tp2RR:             [null, 2.0, 2.5, 3.0, 3.5, 4.0] as (number | null)[],
  z1min:             [1.80],
  z1max:             [2.07],
  tp1SizePercent:    [50, 75, 100],
  moveSlToBreakeven: [true, false],
  maxBodyPercent:    [60, 70, 80],
  minRangePercent:   [0.45, 0.50, 0.55],
  minVolume:         [400],
} as const;

const FIXED = {
  z2min: 2.618,
  z2max: 3.06,
} as const;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

type SortKey = 'profitFactor' | 'expectancy' | 'finalCapital' | 'winRate';

function parseArgs() {
  const args = process.argv.slice(2);
  const get  = (flag: string, fallback: string) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
  };

  return {
    symbol:     get('--symbol',      'BTCUSDT'),
    from:       Date.parse(`${get('--from', '2025-01-01')}T00:00:00Z`),
    to:         Date.parse(`${get('--to',   '2025-03-31')}T23:59:59Z`),
    topN:       parseInt(get('--top',          '20')),
    sortBy:     get('--sort', 'profitFactor') as SortKey,
    workers:    parseInt(get('--workers', String(Math.min(4, os.cpus().length)))),
    minTrades:  parseInt(get('--min-trades',   '30')),
    minWinRate: parseFloat(get('--min-winrate', '0')),
    minPF:      parseFloat(get('--min-pf',      '1.0')),
    maxDD:      parseFloat(get('--max-dd',      '100')),
    noZone2:    args.includes('--no-zone2'),
  };
}

// ---------------------------------------------------------------------------
// Generador de combinaciones
// ---------------------------------------------------------------------------

function buildCombinations(): ComboParams[] {
  const combos: ComboParams[] = [];
  for (const candleInterval of GRID.candleInterval)
  for (const tp1RR of GRID.tp1RR)
  for (const tp2RR of GRID.tp2RR)
  for (const z1min of GRID.z1min)
  for (const z1max of GRID.z1max)
  for (const tp1SizePercent of GRID.tp1SizePercent)
  for (const moveSlToBreakeven of GRID.moveSlToBreakeven)
  for (const maxBodyPercent of GRID.maxBodyPercent)
  for (const minRangePercent of GRID.minRangePercent)
  for (const minVolume of GRID.minVolume) {
    if (z1min >= z1max) continue;
    if (tp1SizePercent === 100 && moveSlToBreakeven === true) continue;
    // tp2RR solo tiene sentido cuando hay posición remanente tras TP1
    if (tp1SizePercent === 100 && tp2RR !== null) continue;
    combos.push({ candleInterval, tp1RR, tp2RR, z1min, z1max, tp1SizePercent, moveSlToBreakeven, maxBodyPercent, minRangePercent, minVolume });
  }
  return combos;
}

function chunkArray<T>(arr: T[], n: number): T[][] {
  const size = Math.ceil(arr.length / n);
  return Array.from({ length: n }, (_, i) => arr.slice(i * size, i * size + size)).filter(c => c.length > 0);
}

// ---------------------------------------------------------------------------
// Worker runner
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Progreso global
// ---------------------------------------------------------------------------

function renderProgress(done: number[], total: number[], totalCombos: number): void {
  const globalDone  = done.reduce((s, n) => s + n, 0);
  const pct         = totalCombos > 0 ? (globalDone / totalCombos) * 100 : 0;
  const BAR_WIDTH   = 30;
  const filled      = Math.round((pct / 100) * BAR_WIDTH);
  const bar         = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
  const workers     = done.map((d, i) => `W${i + 1}:${d}/${total[i] ?? '?'}`).join('  ');
  process.stdout.write(`\r  [${bar}] ${globalDone}/${totalCombos} (${pct.toFixed(1)}%)  ${workers}   `);
}

// ---------------------------------------------------------------------------
// Worker runner
// ---------------------------------------------------------------------------

function runWorker(
  chunk: ComboParams[],
  config: { symbol: string; from: number; to: number; z2min: number | null; z2max: number | null },
  candles1m: unknown[],
  workerIndex: number,
  onProgress: (done: number, total: number) => void,
): Promise<ComboResult[]> {
  return new Promise((resolve, reject) => {
    const workerScript = fileURLToPath(new URL('./grid-search-worker.ts', import.meta.url));
    const child = spawn('npx', ['tsx', workerScript], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    const input = JSON.stringify({
      symbol:    config.symbol,
      from:      config.from,
      to:        config.to,
      z2min:     config.z2min,
      z2max:     config.z2max,
      candles1m,
      combos:    chunk,
    });

    let buffer = '';
    let results: ComboResult[] = [];

    child.stdout.on('data', (d: Buffer) => {
      buffer += d.toString('utf-8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';           // último fragmento incompleto
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as { type: string; done?: number; total?: number; data?: ComboResult[] };
          if (msg.type === 'progress' && msg.done !== undefined && msg.total !== undefined) {
            onProgress(msg.done, msg.total);
          } else if (msg.type === 'results' && msg.data) {
            results = msg.data;
          }
        } catch { /* línea malformada, ignorar */ }
      }
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Worker ${workerIndex} terminó con código ${code}`));
        return;
      }
      resolve(results);
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function sortValue(r: ComboResult, key: SortKey): number {
  switch (key) {
    case 'profitFactor': return r.profitFactor;
    case 'expectancy':   return r.expectancy;
    case 'finalCapital': return r.finalCapital;
    case 'winRate':      return r.winRate;
  }
}

function printTable(results: ComboResult[], topN: number, sortBy: SortKey): void {
  const top = results.slice(0, topN);

  const header = [
    'TF'.padStart(4), 'TP1RR'.padStart(6), 'TP2RR'.padStart(6), 'Z1min'.padStart(6), 'Z1max'.padStart(6),
    'TP1%'.padStart(5), 'BE'.padStart(3),
    'Body%'.padStart(6), 'Range%'.padStart(7), 'MinVol'.padStart(7),
    'Trades'.padStart(7), 'WinRate'.padStart(8), 'ProfFactor'.padStart(11),
    'MaxDD'.padStart(7), 'Expectancy'.padStart(11), 'FinalCap'.padStart(10),
  ].join('  ');

  const sep = '─'.repeat(header.length);
  console.log(`\nTop ${topN} combinaciones — ordenado por ${sortBy}`);
  console.log(sep);
  console.log(header);
  console.log(sep);

  for (const r of top) {
    console.log([
      `${r.candleInterval}m`.padStart(4),
      r.tp1RR.toFixed(1).padStart(6),
      (r.tp2RR != null ? r.tp2RR.toFixed(1) : 'top').padStart(6),
      r.z1min.toFixed(2).padStart(6),
      r.z1max.toFixed(2).padStart(6),
      String(r.tp1SizePercent).padStart(5),
      (r.moveSlToBreakeven ? 'sí' : 'no').padStart(3),
      `${r.maxBodyPercent}%`.padStart(6),
      `${r.minRangePercent}%`.padStart(7),
      (r.minVolume != null ? String(r.minVolume) : '-').padStart(7),
      String(r.totalTrades).padStart(7),
      `${r.winRate.toFixed(1)}%`.padStart(8),
      (r.profitFactor >= 999 ? '∞' : r.profitFactor.toFixed(2)).padStart(11),
      `${r.maxDrawdown.toFixed(1)}%`.padStart(7),
      `${r.expectancy.toFixed(3)}R`.padStart(11),
      `$${r.finalCapital.toFixed(0)}`.padStart(10),
    ].join('  '));
  }
  console.log(sep + '\n');
}

function exportCsv(results: ComboResult[], outputPath: string): void {
  const headers = [
    'candleInterval', 'tp1RR', 'tp2RR', 'z1min', 'z1max', 'tp1SizePercent', 'moveSlToBreakeven',
    'maxBodyPercent', 'minRangePercent', 'minVolume',
    'totalTrades', 'winRate', 'profitFactor', 'maxDrawdown', 'expectancy', 'finalCapital',
    'sharpeRatio', 'sortinoRatio',
  ];
  const rows = results.map(r => [
    r.candleInterval, r.tp1RR, r.tp2RR ?? 'null', r.z1min, r.z1max, r.tp1SizePercent, r.moveSlToBreakeven,
    r.maxBodyPercent, r.minRangePercent, r.minVolume ?? 'null',
    r.totalTrades, r.winRate.toFixed(2),
    r.profitFactor >= 999 ? '999' : r.profitFactor.toFixed(4),
    r.maxDrawdown.toFixed(2), r.expectancy.toFixed(4),
    r.finalCapital.toFixed(2), r.sharpeRatio.toFixed(4), r.sortinoRatio.toFixed(4),
  ].join(','));
  writeFileSync(outputPath, [headers.join(','), ...rows].join('\n'), 'utf-8');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  loadEnv();
  const { symbol, from, to, topN, sortBy, workers, minTrades, minWinRate, minPF, maxDD, noZone2 } = parseArgs();

  const z2min = noZone2 ? null : FIXED.z2min;
  const z2max = noZone2 ? null : FIXED.z2max;

  const allCombos = buildCombinations();

  console.log(`\nGrid Search — SpinningTopFibStrategy`);
  console.log(`Symbol     : ${symbol}`);
  console.log(`Rango      : ${new Date(from).toISOString().slice(0, 10)} → ${new Date(to).toISOString().slice(0, 10)}`);
  console.log(`Combos     : ${allCombos.length}  |  Workers: ${workers}`);
  console.log(`Zona 2     : ${noZone2 ? 'deshabilitada' : `[${FIXED.z2min}, ${FIXED.z2max}] (fija)`}`);
  console.log(`Filtros    : minTrades=${minTrades}, minWinRate=${minWinRate}%, minPF=${minPF}, maxDD=${maxDD}%`);
  console.log(`Ordenar por: ${sortBy}\n`);

  // Pre-cargar velas 1m una sola vez
  process.stdout.write('Pre-cargando velas 1m...');
  const pool     = createPool();
  const realRepo = new CandleRepository({ db: pool });
  const memRepo  = new InMemoryCandleRepository(realRepo);
  const warmupMs = 120 * 60 * 1000;
  await memRepo.preload(symbol, from - warmupMs, to);
  // Extraer las velas cargadas para pasarlas a los workers
  const candles1m = await realRepo.getCandles(symbol, '1m', from - warmupMs, to);
  await pool.end();
  console.log(` ${candles1m.length} velas listas.\n`);

  // Dividir en chunks y lanzar workers en paralelo
  const chunks  = chunkArray(allCombos, workers);
  const config  = { symbol, from, to, z2min, z2max };
  const t0      = Date.now();

  console.log(`Lanzando ${chunks.length} workers...\n`);

  // Estado de progreso por worker
  const doneCounts:  number[] = chunks.map(() => 0);
  const totalCounts: number[] = chunks.map(c => c.length);

  renderProgress(doneCounts, totalCounts, allCombos.length);

  const workerPromises = chunks.map((chunk, i) =>
    runWorker(chunk, config, candles1m, i + 1, (done, total) => {
      doneCounts[i]  = done;
      totalCounts[i] = total;
      renderProgress(doneCounts, totalCounts, allCombos.length);
    })
    .catch(err => { process.stderr.write(`\n  Worker ${i + 1} error: ${err.message}\n`); return [] as ComboResult[]; })
  );

  const allResults = (await Promise.all(workerPromises)).flat();
  const elapsed    = ((Date.now() - t0) / 1000 / 60).toFixed(1);
  console.log(); // nueva línea tras la barra

  console.log(`\nCompletado en ${elapsed} min — ${allResults.length} combos evaluadas`);

  // Aplicar filtros
  const filtered = allResults.filter(r =>
    r.totalTrades  >= minTrades  &&
    r.winRate      >= minWinRate &&
    r.profitFactor >= minPF      &&
    r.maxDrawdown  <= maxDD
  );

  console.log(`${filtered.length} pasaron los filtros\n`);

  if (filtered.length === 0) {
    console.log('Sin resultados. Prueba con --min-pf 1.0 --min-trades 10');
    return;
  }

  filtered.sort((a, b) => sortValue(b, sortBy) - sortValue(a, sortBy));
  printTable(filtered, topN, sortBy);

  const csvPath = resolve(process.cwd(), `docs/backtest/results/grid-search-${Date.now()}.csv`);
  exportCsv(filtered, csvPath);
  console.log(`Resultados completos → ${csvPath}`);
}

main().catch(err => {
  console.error('Error fatal:', err.message);
  process.exit(1);
});
