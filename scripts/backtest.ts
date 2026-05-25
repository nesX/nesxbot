/**
 * scripts/backtest.ts
 *
 * Corre SpinningTopFibStrategy para múltiples timeframes y muestra
 * una tabla comparativa de resultados.
 *
 * Uso:
 *   npm run backtest
 *   npm run backtest -- --symbol ETHUSDT
 *   npm run backtest -- --from 2025-01-01 --to 2025-06-30
 *   npm run backtest -- --intervals 1,3,5,15
 */

import { loadEnv }                    from './lib/env.js';
import { createPool }                 from './lib/db.js';
import { runBacktest, exportCsv }     from './lib/backtest.js';
import type { TradeDetail }           from './lib/backtest.js';
import SpinningTopFibStrategy         from '../src/strategy/strategies/SpinningTopFibStrategy.js';
import type { BacktestReport, Metrics } from '../src/types.js';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const DAY_PRESETS: Record<string, number[]> = {
  weekdays: [1, 2, 3, 4, 5],
  weekends: [0, 6],
  all:      [],
};

function parseArgs() {
  const args = process.argv.slice(2);
  const get  = (flag: string, fallback: string) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
  };
  const getFlag = (flag: string) => args.includes(flag);

  const daysRaw = get('--days', 'all');
  const tradingDays: number[] = daysRaw in DAY_PRESETS
    ? DAY_PRESETS[daysRaw]!
    : daysRaw.split(',').map(Number).filter(n => n >= 0 && n <= 6);

  const tp2RRRaw = get('--tp2rr', '');
  const tp2RR    = tp2RRRaw !== '' ? parseFloat(tp2RRRaw) : null;

  return {
    symbol:           get('--symbol', 'BTCUSDT'),
    from:             Date.parse(`${get('--from', '2025-01-01')}T00:00:00Z`),
    to:               Date.parse(`${get('--to',   '2025-01-31')}T23:59:59Z`),
    intervals:        get('--intervals', '1,2,3,4,5,6,7,8,9,10,11,12,13,14,15')
                        .split(',').map(Number).filter(n => Number.isInteger(n) && n > 0),
    tradingDays,
    tp1RR:            parseFloat(get('--tp1rr', '1.0')),
    tp2RR,
    tp1SizePercent:   parseFloat(get('--tp1size', '50')),
    moveSlToBreakeven: !getFlag('--no-breakeven'),
    zone1: { min: parseFloat(get('--z1min', '1.8')), max: parseFloat(get('--z1max', '2.1')) },
    zone2: getFlag('--no-zone2')
      ? null
      : { min: parseFloat(get('--z2min', '2.618')), max: parseFloat(get('--z2max', '3.0')) },
    maxBodyPercent:  parseFloat(get('--maxbody',   '30')),
    minRangePercent: parseFloat(get('--minrange',  '0.3')),
    minVolume:       args.includes('--minvolume') ? parseFloat(get('--minvolume', '0')) : undefined,
    zoneExpiry:      args.includes('--zone-expiry') ? get('--zone-expiry', '') : undefined,
    volMaType:       get('--vol-ma', '') as 'sma' | 'ema' | '',
    volMaPeriod:     parseInt(get('--vol-ma-period', '20'), 10),
    volMaMult:       parseFloat(get('--vol-ma-mult', '1')),

    rsiEnabled:      getFlag('--rsi'),
    rsiPeriod:       parseInt(get('--rsi-period', '14'), 10),
    rsiOb:           parseFloat(get('--rsi-ob', '70')),
    rsiOs:           parseFloat(get('--rsi-os', '30')),

    macdEnabled:      getFlag('--macd'),
    macdSignal:       getFlag('--macd-signal'),
    macdFast:         parseInt(get('--macd-fast', '12'), 10),
    macdSlow:         parseInt(get('--macd-slow', '26'), 10),
    macdSignalPeriod: parseInt(get('--macd-signal-period', '9'), 10),
    macdLevel:        parseFloat(get('--macd-level', '0')),
  };
}

// ---------------------------------------------------------------------------
// Tablas de resultados
// ---------------------------------------------------------------------------

function printTable(results: Array<{ interval: number; report: BacktestReport; ms: number }>): void {
  const header = [
    'TF'.padStart(4), 'Trades'.padStart(7), 'WinRate'.padStart(8),
    'ProfFactor'.padStart(11), 'MaxDD'.padStart(7),
    'Expectancy'.padStart(11), 'FinalCap'.padStart(10), 'Time'.padStart(7),
  ].join('  ');

  const sep = '─'.repeat(header.length);
  console.log('\n' + sep);
  console.log(header);
  console.log(sep);

  for (const { interval, report, ms } of results) {
    const m: Metrics = report.metrics;
    console.log([
      `${interval}m`.padStart(4),
      String(m.totalTrades).padStart(7),
      `${m.winRate.toFixed(1)}%`.padStart(8),
      (m.profitFactor === Infinity ? '∞' : m.profitFactor.toFixed(2)).padStart(11),
      `${m.maxDrawdown.toFixed(1)}%`.padStart(7),
      `$${m.expectancy.toFixed(2)}`.padStart(11),
      `$${m.finalCapital.toFixed(0)}`.padStart(10),
      `${(ms / 1000).toFixed(1)}s`.padStart(7),
    ].join('  '));
  }

  console.log(sep + '\n');
}

function printBreakdownTable(allTrades: Array<{ interval: number; trades: TradeDetail[] }>): void {
  // --- Dirección ---
  const dirHeader = [
    'TF'.padStart(4),
    'LONG'.padStart(6), 'L+'.padStart(4), 'L-'.padStart(4), 'L-WR%'.padStart(6),
    '  SHORT'.padStart(7), 'S+'.padStart(4), 'S-'.padStart(4), 'S-WR%'.padStart(6),
  ].join('  ');
  const dirSep = '─'.repeat(dirHeader.length);

  console.log('Dirección');
  console.log(dirSep);
  console.log(dirHeader);
  console.log(dirSep);

  for (const { interval, trades } of allTrades) {
    const longs  = trades.filter(t => t.direction === 'LONG');
    const shorts = trades.filter(t => t.direction === 'SHORT');
    const lw = longs.filter(t  => t.pnl > 0).length;
    const ll = longs.filter(t  => t.pnl <= 0).length;
    const sw = shorts.filter(t => t.pnl > 0).length;
    const sl = shorts.filter(t => t.pnl <= 0).length;
    const lwr = longs.length  > 0 ? (lw / longs.length  * 100).toFixed(1) : '-';
    const swr = shorts.length > 0 ? (sw / shorts.length * 100).toFixed(1) : '-';

    console.log([
      `${interval}m`.padStart(4),
      String(longs.length).padStart(6),  String(lw).padStart(4), String(ll).padStart(4), `${lwr}%`.padStart(6),
      String(shorts.length).padStart(7), String(sw).padStart(4), String(sl).padStart(4), `${swr}%`.padStart(6),
    ].join('  '));
  }
  console.log(dirSep);

  // --- Zona ---
  const zHeader = [
    'TF'.padStart(4),
    'Zona1'.padStart(6), 'Z1+'.padStart(4), 'Z1-'.padStart(4), 'Z1-WR%'.padStart(7),
    '  Zona2'.padStart(7), 'Z2+'.padStart(4), 'Z2-'.padStart(4), 'Z2-WR%'.padStart(7),
  ].join('  ');
  const zSep = '─'.repeat(zHeader.length);

  console.log('\nZonas de proyección');
  console.log(zSep);
  console.log(zHeader);
  console.log(zSep);

  for (const { interval, trades } of allTrades) {
    const z1 = trades.filter(t => t.zoneLabel === 'Z1_UP' || t.zoneLabel === 'Z1_DOWN');
    const z2 = trades.filter(t => t.zoneLabel === 'Z2_UP' || t.zoneLabel === 'Z2_DOWN');
    const z1w = z1.filter(t => t.pnl > 0).length;
    const z1l = z1.filter(t => t.pnl <= 0).length;
    const z2w = z2.filter(t => t.pnl > 0).length;
    const z2l = z2.filter(t => t.pnl <= 0).length;
    const z1wr = z1.length > 0 ? (z1w / z1.length * 100).toFixed(1) : '-';
    const z2wr = z2.length > 0 ? (z2w / z2.length * 100).toFixed(1) : '-';

    console.log([
      `${interval}m`.padStart(4),
      String(z1.length).padStart(6), String(z1w).padStart(4), String(z1l).padStart(4), `${z1wr}%`.padStart(7),
      String(z2.length).padStart(7), String(z2w).padStart(4), String(z2l).padStart(4), `${z2wr}%`.padStart(7),
    ].join('  '));
  }
  console.log(zSep + '\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  loadEnv();
  const { symbol, from, to, intervals, tradingDays, tp1RR, tp2RR, tp1SizePercent, moveSlToBreakeven, zone1, zone2, maxBodyPercent, minRangePercent, minVolume, zoneExpiry, volMaType, volMaPeriod, volMaMult, rsiEnabled, rsiPeriod, rsiOb, rsiOs, macdEnabled, macdSignal, macdFast, macdSlow, macdSignalPeriod, macdLevel } = parseArgs();

  const daysLabel = tradingDays.length === 0
    ? 'todos los días'
    : tradingDays.map(d => ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'][d]).join(', ');

  console.log(`\nSpinningTopFibStrategy — Backtest comparativo`);
  console.log(`Symbol    : ${symbol}`);
  console.log(`Rango     : ${new Date(from).toISOString().slice(0, 10)} → ${new Date(to).toISOString().slice(0, 10)}`);
  console.log(`Días      : ${daysLabel}`);
  console.log(`Intervalos: ${intervals.join(', ')} minutos`);
  console.log(`TP1 RR    : 1:${tp1RR}  (${tp1SizePercent}% posición)`);
  console.log(`TP2 RR    : ${tp2RR !== null ? `1:${tp2RR}` : 'high/low del trompo'}  (${100 - tp1SizePercent}% posición)`);
  console.log(`Breakeven : ${moveSlToBreakeven ? 'sí (SL → entry al tocar TP1)' : 'no'}`);
  console.log(`Zona 1    : [${zone1.min}, ${zone1.max}]`);
  console.log(`Zona 2    : ${zone2 ? `[${zone2.min}, ${zone2.max}]` : 'deshabilitada'}`);
  console.log(`Expiración: ${zoneExpiry ?? 'sin límite'}`);
  console.log(`Trompo    : body≤${maxBodyPercent}%  range≥${minRangePercent}%${minVolume !== undefined ? `  vol≥${minVolume}` : ''}${volMaType ? `  vol≥${volMaType.toUpperCase()}(${volMaPeriod})×${volMaMult}` : ''}`);
  if (rsiEnabled)              console.log(`Filtro RSI: período=${rsiPeriod}  ob≥${rsiOb}  os≤${rsiOs}`);
  if (macdEnabled || macdSignal) console.log(`Filtro MACD: fast=${macdFast}  slow=${macdSlow}  signal=${macdSignalPeriod}  modo=${macdSignal ? 'signal' : 'histogram'}${macdLevel !== 0 ? `  nivel±${macdLevel}` : ''}`);

  const pool       = createPool();
  const results:    Array<{ interval: number; report: BacktestReport; ms: number }> = [];
  const allTrades:  Array<{ interval: number; trades: TradeDetail[] }> = [];

  // Logger que sobreescribe la misma línea — mantiene la pantalla limpia
  const CLEAR = '\r\x1b[K';
  let lastMsg = '';
  const lineLogger = {
    info:  (...args: unknown[]) => {
      const msg = args.map(String).join(' ').slice(0, process.stdout.columns - 4);
      lastMsg = msg;
      process.stdout.write(`${CLEAR}  ${msg}`);
    },
    warn:  (...args: unknown[]) => lineLogger.info(...args),
    error: (...args: unknown[]) => lineLogger.info(...args),
  };

  for (const interval of intervals) {
    process.stdout.write(`${CLEAR}  Corriendo ${interval}m...`);
    lastMsg = '';
    const t0 = Date.now();

    try {
      const strategy = new SpinningTopFibStrategy({
        candleInterval:   interval,
        maxBodyPercent,
        minRangePercent,
        minVolume,
        volumeFilter: volMaType ? { type: volMaType, period: volMaPeriod, multiplier: volMaMult } : undefined,
        zone1,
        zone2,
        spinningTopMode:  'SINGLE_LAST',
        zoneExpiry,
        tp1SizePercent,
        tp1RR,
        tp2RR,
        moveSlToBreakeven,
        riskPercent:      1,
        tradingDays,
        filters: (rsiEnabled || macdEnabled || macdSignal) ? {
          ...(rsiEnabled ? { rsi: { period: rsiPeriod, overbought: rsiOb, oversold: rsiOs } } : {}),
          ...(macdEnabled || macdSignal ? { macd: { fastPeriod: macdFast, slowPeriod: macdSlow, signalPeriod: macdSignalPeriod, mode: macdSignal ? 'signal' as const : 'histogram' as const, histogramThreshold: macdLevel } } : {}),
        } : undefined,
      });

      const { report, trades } = await runBacktest(strategy, {
        symbol,
        from,
        to,
        warmupCandles: interval * 20,
        logger: lineLogger,
      }, pool);

      const ms = Date.now() - t0;
      results.push({ interval, report, ms });
      allTrades.push({ interval, trades });
      // Finaliza la línea con el resumen del intervalo
      process.stdout.write(`${CLEAR}  ${interval}m → ${report.metrics.totalTrades} trades  WR ${report.metrics.winRate.toFixed(1)}%  PF ${report.metrics.profitFactor === Infinity ? '∞' : report.metrics.profitFactor.toFixed(2)}  (${(ms / 1000).toFixed(1)}s)\n`);
    } catch (err) {
      process.stdout.write(`${CLEAR}  ${interval}m → ERROR: ${(err as Error).message}\n`);
    }
  }

  await pool.end();

  if (results.length > 0) {
    printTable(results);
    printBreakdownTable(allTrades);
    const csvPath = exportCsv(allTrades);
    console.log(`Trades exportados → ${csvPath}`);
  }
}

main().catch(err => {
  console.error('Error fatal:', err.message);
  process.exit(1);
});
