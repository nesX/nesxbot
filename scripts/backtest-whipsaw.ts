/**
 * scripts/backtest-whipsaw.ts
 *
 * Corre WhipsawReversionStrategy y muestra los resultados.
 *
 * Uso:
 *   npm run backtest-whipsaw
 *   npm run backtest-whipsaw -- --symbol ETHUSDT
 *   npm run backtest-whipsaw -- --from 2025-01-01 --to 2025-03-31
 *   npm run backtest-whipsaw -- --proj-min 1.8 --proj-max 2.1
 *   npm run backtest-whipsaw -- --vol-mult 2.5 --min-bars 3 --max-bars 15
 */

import { loadEnv }                from './lib/env.js';
import { createPool }             from './lib/db.js';
import { runBacktest, exportCsv } from './lib/backtest.js';
import type { TradeDetail }       from './lib/backtest.js';
import WhipsawReversionStrategy   from '../src/strategy/strategies/WhipsawReversionStrategy.js';
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
  const get     = (flag: string, fallback: string) => {
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
    intervals:        get('--intervals', '1').split(',').map(Number).filter(n => Number.isInteger(n) && n > 0),
    tradingDays,

    // Detector de whipsaw
    volMult:          parseFloat(get('--vol-mult',  '3')),
    smaPeriod:        parseInt(get('--sma-period', '50'), 10),
    dispThreshold:    parseFloat(get('--disp-threshold', '0.3')),
    minBars:          parseInt(get('--min-bars', '5'), 10),
    maxBars:          parseInt(get('--max-bars', '20'), 10),

    // Zonas de proyección
    projMin:          parseFloat(get('--proj-min', '1.8')),
    projMax:          parseFloat(get('--proj-max', '2.1')),

    // Gestión del trade
    tp1RR:            parseFloat(get('--tp1rr', '1.0')),
    tp2RR,
    tp1SizePercent:   parseFloat(get('--tp1size', '50')),
    moveSlToBreakeven: !getFlag('--no-breakeven'),
    zoneExpiry:       getFlag('--zone-expiry') ? get('--zone-expiry', '') : undefined,

    // Filtros
    rsiEnabled:       getFlag('--rsi'),
    rsiPeriod:        parseInt(get('--rsi-period', '14'), 10),
    rsiOb:            parseFloat(get('--rsi-ob', '70')),
    rsiOs:            parseFloat(get('--rsi-os', '30')),

    macdEnabled:      getFlag('--macd'),
    macdSignal:       getFlag('--macd-signal'),
    macdFast:         parseInt(get('--macd-fast', '12'), 10),
    macdSlow:         parseInt(get('--macd-slow', '26'), 10),
    macdSignalPeriod: parseInt(get('--macd-signal-period', '9'), 10),
    macdLevel:        parseFloat(get('--macd-level', '0')),
  };
}

// ---------------------------------------------------------------------------
// Tabla de resultados
// ---------------------------------------------------------------------------

function printTable(results: Array<{ interval: number; report: BacktestReport; ms: number }>): void {
  const header = [
    'TF'.padStart(5), 'Trades'.padStart(7), 'WinRate'.padStart(8),
    'ProfFactor'.padStart(11), 'MaxDD'.padStart(7),
    'Expectancy'.padStart(11), 'FinalCap'.padStart(10), 'Time'.padStart(7),
  ].join('  ');
  const sep = '─'.repeat(header.length);

  console.log('\n' + sep);
  console.log(header);
  console.log(sep);

  for (const { interval, report, ms } of results) {
    const m: Metrics = report.metrics;
    const tfLabel = interval >= 1440 ? '1d' : interval >= 60 ? `${interval / 60}h` : `${interval}m`;
    console.log([
      tfLabel.padStart(5),
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
  const header = [
    'TF'.padStart(5),
    'LONG'.padStart(6), 'L+'.padStart(4), 'L-'.padStart(4), 'LWR%'.padStart(6),
    '  SHORT'.padStart(7), 'S+'.padStart(4), 'S-'.padStart(4), 'SWR%'.padStart(6),
    '  WS_UP'.padStart(7), 'UWR%'.padStart(6),
    '  WS_DN'.padStart(7), 'DWR%'.padStart(6),
  ].join('  ');
  const sep = '─'.repeat(header.length);

  console.log(sep);
  console.log(header);
  console.log(sep);

  for (const { interval, trades } of allTrades) {
    const tfLabel = interval >= 1440 ? '1d' : interval >= 60 ? `${interval / 60}h` : `${interval}m`;

    const longs  = trades.filter(t => t.direction === 'LONG');
    const shorts = trades.filter(t => t.direction === 'SHORT');
    const lw = longs.filter(t  => t.pnl > 0).length;
    const ll = longs.filter(t  => t.pnl <= 0).length;
    const sw = shorts.filter(t => t.pnl > 0).length;
    const sl = shorts.filter(t => t.pnl <= 0).length;
    const lwr = longs.length  > 0 ? (lw / longs.length  * 100).toFixed(1) : '-';
    const swr = shorts.length > 0 ? (sw / shorts.length * 100).toFixed(1) : '-';

    const up   = trades.filter(t => t.zoneLabel === 'WS_UP');
    const down = trades.filter(t => t.zoneLabel === 'WS_DOWN');
    const upWR   = up.length   > 0 ? (up.filter(t   => t.pnl > 0).length / up.length   * 100).toFixed(1) : '-';
    const downWR = down.length > 0 ? (down.filter(t => t.pnl > 0).length / down.length * 100).toFixed(1) : '-';

    console.log([
      tfLabel.padStart(5),
      String(longs.length).padStart(6),  String(lw).padStart(4), String(ll).padStart(4), `${lwr}%`.padStart(6),
      String(shorts.length).padStart(7), String(sw).padStart(4), String(sl).padStart(4), `${swr}%`.padStart(6),
      String(up.length).padStart(7),   `${upWR}%`.padStart(6),
      String(down.length).padStart(7), `${downWR}%`.padStart(6),
    ].join('  '));
  }
  console.log(sep + '\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  loadEnv();
  const {
    symbol, from, to, intervals, tradingDays,
    volMult, smaPeriod, dispThreshold, minBars, maxBars,
    projMin, projMax,
    tp1RR, tp2RR, tp1SizePercent, moveSlToBreakeven, zoneExpiry,
    rsiEnabled, rsiPeriod, rsiOb, rsiOs,
    macdEnabled, macdSignal, macdFast, macdSlow, macdSignalPeriod, macdLevel,
  } = parseArgs();

  const daysLabel = tradingDays.length === 0
    ? 'todos los días'
    : tradingDays.map(d => ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'][d]).join(', ');

  console.log(`\nWhipsawReversionStrategy — Backtest comparativo`);
  console.log(`Symbol      : ${symbol}`);
  console.log(`Rango       : ${new Date(from).toISOString().slice(0, 10)} → ${new Date(to).toISOString().slice(0, 10)}`);
  console.log(`Días        : ${daysLabel}`);
  console.log(`Intervalos  : ${intervals.map(i => i >= 1440 ? '1d' : i >= 60 ? `${i/60}h` : `${i}m`).join(', ')}`);
  console.log(`Detector    : volMult=${volMult}  smaPeriod=${smaPeriod}  disp≤${dispThreshold}  bars=[${minBars},${maxBars}]`);
  console.log(`Proyección  : [${projMin}×R, ${projMax}×R]`);
  console.log(`TP1 RR      : 1:${tp1RR}  (${tp1SizePercent}% posición)`);
  console.log(`TP2 RR      : ${tp2RR !== null ? `1:${tp2RR}` : 'spikeHigh/spikeLow (reversión total)'}  (${100 - tp1SizePercent}% posición)`);
  console.log(`Breakeven   : ${moveSlToBreakeven ? 'sí' : 'no'}`);
  console.log(`Expiración  : ${zoneExpiry ?? 'sin límite'}`);
  if (rsiEnabled)                console.log(`Filtro RSI  : período=${rsiPeriod}  ob≥${rsiOb}  os≤${rsiOs}`);
  if (macdEnabled || macdSignal) console.log(`Filtro MACD : fast=${macdFast}  slow=${macdSlow}  signal=${macdSignalPeriod}  modo=${macdSignal ? 'signal' : 'histogram'}${macdLevel !== 0 ? `  nivel±${macdLevel}` : ''}`);

  const pool       = createPool();
  const results:   Array<{ interval: number; report: BacktestReport; ms: number }> = [];
  const allTrades: Array<{ interval: number; trades: TradeDetail[] }> = [];

  const CLEAR = '\r\x1b[K';
  const lineLogger = {
    info:  (...a: unknown[]) => process.stdout.write(`${CLEAR}  ${String(a.join(' ')).slice(0, (process.stdout.columns ?? 80) - 4)}`),
    warn:  (...a: unknown[]) => lineLogger.info(...a),
    error: (...a: unknown[]) => lineLogger.info(...a),
  };

  for (const interval of intervals) {
    const tfLabel = interval >= 1440 ? '1d' : interval >= 60 ? `${interval/60}h` : `${interval}m`;
    process.stdout.write(`${CLEAR}  Corriendo ${tfLabel}...`);
    const t0 = Date.now();

    try {
      const strategy = new WhipsawReversionStrategy({
        candleInterval:        interval,
        volatilityMultiplier:  volMult,
        smaPeriod,
        displacementThreshold: dispThreshold,
        minBars,
        maxBars,
        projMin,
        projMax,
        tp1SizePercent,
        tp1RR,
        tp2RR,
        moveSlToBreakeven,
        riskPercent: 1,
        zoneExpiry,
        tradingDays,
        filters: (rsiEnabled || macdEnabled || macdSignal) ? {
          ...(rsiEnabled ? { rsi: { period: rsiPeriod, overbought: rsiOb, oversold: rsiOs } } : {}),
          ...(macdEnabled || macdSignal ? {
            macd: {
              fastPeriod:         macdFast,
              slowPeriod:         macdSlow,
              signalPeriod:       macdSignalPeriod,
              mode:               macdSignal ? 'signal' as const : 'histogram' as const,
              histogramThreshold: macdLevel,
            },
          } : {}),
        } : undefined,
      });

      // warmup: smaPeriod + maxBars velas del TF configurado (en minutos de 1m)
      const warmupCandles = (smaPeriod + maxBars + 10) * interval;

      const { report, trades } = await runBacktest(strategy, {
        symbol, from, to,
        warmupCandles,
        logger: lineLogger,
      }, pool);

      const ms = Date.now() - t0;
      results.push({ interval, report, ms });
      allTrades.push({ interval, trades });
      process.stdout.write(`${CLEAR}  ${tfLabel} → ${report.metrics.totalTrades} trades  WR ${report.metrics.winRate.toFixed(1)}%  PF ${report.metrics.profitFactor === Infinity ? '∞' : report.metrics.profitFactor.toFixed(2)}  (${(ms / 1000).toFixed(1)}s)\n`);
    } catch (err) {
      process.stdout.write(`${CLEAR}  ${tfLabel} → ERROR: ${(err as Error).message}\n`);
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
