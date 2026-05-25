/**
 * scripts/validate-trades.ts
 *
 * Imprime un reporte de trades para validación manual en TradingView.
 * Prioriza los más sospechosos: hadAmbiguity=true, PESSIMISTIC, y SL.
 *
 * Uso:
 *   npx tsx scripts/validate-trades.ts
 *   npx tsx scripts/validate-trades.ts --csv docs/backtest/results/backtest-trades-XXXX.csv
 *   npx tsx scripts/validate-trades.ts --filter ambiguity
 *   npx tsx scripts/validate-trades.ts --filter pessimistic
 *   npx tsx scripts/validate-trades.ts --filter sl
 *   npx tsx scripts/validate-trades.ts --filter all
 *   npx tsx scripts/validate-trades.ts --filter random --sample 20
 *   npx tsx scripts/validate-trades.ts --interval 1
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, join }                       from 'path';

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

interface Trade {
  interval:        number;
  tradeId:         string;
  symbol:          string;
  direction:       'LONG' | 'SHORT';
  entryTime:       string;
  entryPrice:      number;
  entryFillPrice:  number;
  stopLoss:        number;
  tp1Price:        number;
  tp2Price:        number;
  exitTime:        string;
  exitFillPrice:   number;
  exitType:        string;
  pnl:             number;
  pnlPercent:      number;
  resolutionMode:  string;
  hadAmbiguity:    boolean;
  zoneLabel:       string;
  spinningTopTime: string;
  spinningTopHigh: number;
  spinningTopLow:  number;
  spinningTopRange: number;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs() {
  const args    = process.argv.slice(2);
  const get     = (flag: string, fallback: string) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
  };

  return {
    csvPath:  get('--csv',      ''),
    filter:   get('--filter',  'ambiguity') as 'ambiguity' | 'pessimistic' | 'sl' | 'all' | 'random',
    sample:   parseInt(get('--sample', '20')),
    interval: get('--interval', ''),
  };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

function findLatestCsv(): string {
  const dir = resolve(process.cwd(), 'docs/backtest/results');
  const files = readdirSync(dir)
    .filter(f => f.startsWith('backtest-trades-') && f.endsWith('.csv'))
    .map(f => ({ name: f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  if (files.length === 0) throw new Error('No se encontraron CSVs en docs/backtest/results/');
  return join(dir, files[0]!.name);
}

function parseCsv(path: string): Trade[] {
  const lines  = readFileSync(path, 'utf-8').trim().split('\n');
  const header = lines[0]!.split(',');

  const idx = (col: string) => header.indexOf(col);

  return lines.slice(1).map(line => {
    const c = line.split(',');
    return {
      interval:         parseInt(c[idx('interval')]!),
      tradeId:          c[idx('tradeId')]!,
      symbol:           c[idx('symbol')]!,
      direction:        c[idx('direction')] as 'LONG' | 'SHORT',
      entryTime:        c[idx('entryTime')]!,
      entryPrice:       parseFloat(c[idx('entryPrice')]!),
      entryFillPrice:   parseFloat(c[idx('entryFillPrice')]!),
      stopLoss:         parseFloat(c[idx('stopLoss')]!),
      tp1Price:         parseFloat(c[idx('tp1Price')]!),
      tp2Price:         parseFloat(c[idx('tp2Price')]!),
      exitTime:         c[idx('exitTime')]!,
      exitFillPrice:    parseFloat(c[idx('exitFillPrice')]!),
      exitType:         c[idx('exitType')]!,
      pnl:              parseFloat(c[idx('pnl')]!),
      pnlPercent:       parseFloat(c[idx('pnlPercent')]!),
      resolutionMode:   c[idx('resolutionMode')]!,
      hadAmbiguity:     c[idx('hadAmbiguity')] === 'true',
      zoneLabel:        c[idx('zoneLabel')]!,
      spinningTopTime:  c[idx('spinningTopTime')]!,
      spinningTopHigh:  parseFloat(c[idx('spinningTopHigh')]!),
      spinningTopLow:   parseFloat(c[idx('spinningTopLow')]!),
      spinningTopRange: parseFloat(c[idx('spinningTopRange')]!),
    };
  });
}

// ---------------------------------------------------------------------------
// Filtros
// ---------------------------------------------------------------------------

function applyFilter(trades: Trade[], filter: string, sample: number): Trade[] {
  switch (filter) {
    case 'ambiguity':
      return trades.filter(t => t.hadAmbiguity);
    case 'pessimistic':
      return trades.filter(t => t.resolutionMode === 'PESSIMISTIC');
    case 'sl':
      return trades.filter(t => t.exitType === 'SL');
    case 'random': {
      const shuffled = [...trades].sort(() => Math.random() - 0.5);
      return shuffled.slice(0, sample);
    }
    case 'all':
    default:
      return trades;
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  white:  '\x1b[37m',
};

function p(n: number, decimals = 2) {
  return n.toFixed(decimals);
}

function printSummary(all: Trade[], filtered: Trade[], filter: string) {
  const byMode = (m: string) => all.filter(t => t.resolutionMode === m).length;
  const ambig  = all.filter(t => t.hadAmbiguity).length;
  const sls    = all.filter(t => t.exitType === 'SL').length;
  const tps    = all.filter(t => t.exitType !== 'SL').length;
  const wr     = (tps / all.length * 100).toFixed(1);

  console.log(`\n${C.bold}═══ RESUMEN DEL CSV ═══${C.reset}`);
  console.log(`  Total trades      : ${C.bold}${all.length}${C.reset}`);
  console.log(`  Win Rate          : ${C.green}${wr}%${C.reset}  (TP: ${tps}  SL: ${sls})`);
  console.log(`  hadAmbiguity=true : ${ambig > 0 ? C.yellow : C.dim}${ambig}${C.reset}`);
  console.log(`  PRECISE_1S        : ${byMode('PRECISE_1S')}`);
  console.log(`  PRECISE_1M        : ${byMode('PRECISE_1M')}`);
  console.log(`  PESSIMISTIC       : ${byMode('PESSIMISTIC') > 0 ? C.red : C.dim}${byMode('PESSIMISTIC')}${C.reset}`);
  console.log(`\n  Filtro aplicado   : ${C.cyan}${filter}${C.reset}  → ${C.bold}${filtered.length} trades${C.reset} a revisar\n`);
}

function printTrade(t: Trade, i: number, total: number) {
  const isWin   = t.exitType !== 'SL';
  const result  = isWin ? `${C.green}✓ ${t.exitType}${C.reset}` : `${C.red}✗ SL${C.reset}`;
  const alerts: string[] = [];

  if (t.hadAmbiguity)                   alerts.push(`${C.yellow}⚠ hadAmbiguity${C.reset}`);
  if (t.resolutionMode === 'PESSIMISTIC') alerts.push(`${C.red}⚠ PESSIMISTIC${C.reset}`);
  if (t.resolutionMode === 'PRECISE_1M') alerts.push(`${C.yellow}~ PRECISE_1M${C.reset}`);

  const dir     = t.direction === 'LONG' ? `${C.green}LONG${C.reset}` : `${C.red}SHORT${C.reset}`;
  const pnlStr  = t.pnl >= 0
    ? `${C.green}+${p(t.pnl)}${C.reset}`
    : `${C.red}${p(t.pnl)}${C.reset}`;

  const risk    = Math.abs(t.stopLoss - t.entryFillPrice);
  const tp1Dist = Math.abs(t.tp1Price - t.entryFillPrice);
  const rr      = risk > 0 ? (tp1Dist / risk).toFixed(2) : '?';

  console.log(`${C.bold}─── Trade ${i}/${total} ───────────────────────────────────${C.reset}`);
  console.log(`  ${C.dim}${t.tradeId}${C.reset}`);
  console.log(`  ${dir}  ${t.symbol}  ${t.interval}m  ${t.zoneLabel}  ${result}  PnL: ${pnlStr} R  ${alerts.join('  ')}`);
  console.log();
  console.log(`  ${C.bold}1. Busca el trompo${C.reset}`);
  console.log(`     Timestamp  : ${C.cyan}${t.spinningTopTime}${C.reset}`);
  console.log(`     High       : ${p(t.spinningTopHigh, 4)}`);
  console.log(`     Low        : ${p(t.spinningTopLow, 4)}`);
  console.log(`     Range      : ${p(t.spinningTopRange, 4)}`);
  console.log();
  console.log(`  ${C.bold}2. Verifica la zona de entrada${C.reset}`);

  if (t.direction === 'SHORT') {
    const zLower = t.spinningTopLow + t.spinningTopRange * 1.95;
    const zUpper = t.spinningTopLow + t.spinningTopRange * 2.06;
    console.log(`     Zona Z1_UP : [${p(zLower, 2)}, ${p(zUpper, 2)}]`);
    console.log(`     Entry plan : ${p(t.entryPrice, 4)}  (borde inferior de la zona)`);
    console.log(`     SL plan    : ${p(t.stopLoss, 4)}   (borde superior de la zona)`);
  } else {
    const zUpper = t.spinningTopHigh - t.spinningTopRange * 1.95;
    const zLower = t.spinningTopHigh - t.spinningTopRange * 2.06;
    console.log(`     Zona Z1_DOWN: [${p(zLower, 2)}, ${p(zUpper, 2)}]`);
    console.log(`     Entry plan : ${p(t.entryPrice, 4)}  (borde superior de la zona)`);
    console.log(`     SL plan    : ${p(t.stopLoss, 4)}   (borde inferior de la zona)`);
  }

  console.log(`     TP1 plan   : ${p(t.tp1Price, 4)}   (RR calculado: 1:${rr})`);
  console.log();
  console.log(`  ${C.bold}3. Verifica el fill${C.reset}`);
  console.log(`     Entry fill : ${p(t.entryFillPrice, 4)}  @ ${t.entryTime}`);
  console.log(`     Exit fill  : ${p(t.exitFillPrice, 4)}  @ ${t.exitTime}`);
  console.log(`     Modo       : ${t.resolutionMode}`);
  console.log();
}

function printChecklist(trades: Trade[]) {
  const ambig  = trades.filter(t => t.hadAmbiguity).length;
  const pess   = trades.filter(t => t.resolutionMode === 'PESSIMISTIC').length;
  const sls    = trades.filter(t => t.exitType === 'SL').length;

  console.log(`${C.bold}═══ CHECKLIST DE VALIDACIÓN ═══${C.reset}`);
  console.log(`  Para cada trade marcado con ⚠:`);
  console.log(`  [ ] El trompo existe visualmente en TradingView`);
  console.log(`  [ ] El precio llegó a la zona z1=[1.95, 2.06] × range`);
  console.log(`  [ ] El entry price está en el borde correcto de la zona`);
  console.log(`  [ ] El SL está en el borde opuesto (exterior) de la zona`);
  console.log(`  [ ] El TP está a la distancia de RR correcta`);
  console.log(`  [ ] El precio tocó TP o SL en el timestamp de salida`);
  console.log();
  console.log(`  Resumen a revisar:`);
  if (ambig  > 0) console.log(`  ${C.yellow}  ${ambig} trades con hadAmbiguity — el fill puede estar mal asignado${C.reset}`);
  if (pess   > 0) console.log(`  ${C.red}  ${pess} trades PESSIMISTIC — sin datos granulares, fill es estimado${C.reset}`);
  if (sls    > 0) console.log(`  ${C.dim}  ${sls} trades SL — verificar que realmente tocó el stop${C.reset}`);
  console.log();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const { csvPath, filter, sample, interval } = parseArgs();

const path   = csvPath || findLatestCsv();
let trades   = parseCsv(path);

if (interval) {
  trades = trades.filter(t => String(t.interval) === interval);
}

const filtered = applyFilter(trades, filter, sample);

console.log(`\n${C.bold}Archivo: ${path}${C.reset}`);
if (interval) console.log(`Filtrado por interval=${interval}`);

printSummary(trades, filtered, filter);

if (filtered.length === 0) {
  console.log(`${C.dim}No hay trades para el filtro "${filter}".${C.reset}\n`);
  process.exit(0);
}

filtered.forEach((t, i) => printTrade(t, i + 1, filtered.length));
printChecklist(filtered);
