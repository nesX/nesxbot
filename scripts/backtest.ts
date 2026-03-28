/**
 * scripts/backtest.ts
 *
 * Corre backtests de SpinningTopFibStrategy para múltiples timeframes
 * y muestra una tabla comparativa de resultados.
 *
 * Uso:
 *   npx tsx scripts/backtest.ts
 *   npx tsx scripts/backtest.ts --symbol ETHUSDT
 *   npx tsx scripts/backtest.ts --from 2025-01-01 --to 2025-06-30
 *   npx tsx scripts/backtest.ts --intervals 1,3,5,15
 */

import { Pool } from 'pg';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

import CandleRepository    from '../src/data/CandleRepository.js';
import ReplayProvider      from '../src/data/ReplayProvider.js';
import StrategyEngine      from '../src/strategy/StrategyEngine.js';
import StrategyRegistry    from '../src/strategy/StrategyRegistry.js';
import MarketStateBuilder  from '../src/strategy/MarketStateBuilder.js';
import FillSimulator       from '../src/backtest/FillSimulator.js';
import MetricsCalculator   from '../src/backtest/MetricsCalculator.js';
import BacktestRunner      from '../src/backtest/BacktestRunner.js';
import SpinningTopFibStrategy from '../src/strategy/strategies/SpinningTopFibStrategy.js';
import { createMessageBroker } from '../src/shared/MessageBroker.js';
import type { BacktestReport, Metrics } from '../src/types.js';

// ---------------------------------------------------------------------------
// Cargar variables de entorno desde .env
// ---------------------------------------------------------------------------

function loadEnv(): void {
  const envPath = resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) {
    throw new Error(
      'No se encontró el archivo .env\n' +
      'Crea uno copiando .env.example y completando los valores:\n' +
      '  cp .env.example .env'
    );
  }

  const lines = readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [key, ...rest] = trimmed.split('=');
    if (key && rest.length > 0) {
      process.env[key.trim()] = rest.join('=').trim();
    }
  }
}

// ---------------------------------------------------------------------------
// TimeProvider mutable para backtest
// ---------------------------------------------------------------------------

function createReplayTimeProvider() {
  let current = 0;
  return {
    now: ()           => current,
    setTime: (ms: number) => { current = ms; },
  };
}

// ---------------------------------------------------------------------------
// Parsear argumentos CLI
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const get  = (flag: string, fallback: string) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
  };

  const symbol    = get('--symbol', 'BTCUSDT');
  const fromStr   = get('--from',   '2025-01-01');
  const toStr     = get('--to',     '2025-03-31');
  const intervals = get('--intervals', '1,2,3,4,5,6,7,8,9,10,11,12,13,14,15')
    .split(',')
    .map(Number)
    .filter(n => Number.isInteger(n) && n > 0);

  return {
    symbol,
    from:      Date.parse(`${fromStr}T00:00:00Z`),
    to:        Date.parse(`${toStr}T23:59:59Z`),
    intervals,
  };
}

// ---------------------------------------------------------------------------
// Ejecutar un backtest para un intervalo específico
// ---------------------------------------------------------------------------

async function runInterval(
  interval: number,
  symbol: string,
  from: number,
  to: number,
  pool: Pool,
): Promise<BacktestReport> {
  const broker          = createMessageBroker();
  const timeProvider    = createReplayTimeProvider();
  const candleRepo      = new CandleRepository({ db: pool });
  const stateBuilder    = new MarketStateBuilder({ timeProvider, maxCandles: 1000 });
  const registry        = new StrategyRegistry();
  const strategy        = new SpinningTopFibStrategy({
    candleInterval:  interval,
    maxBodyPercent:  30,
    minRangePercent: 0.3,
    zone1:           { min: 1.8,    max: 2.1 },
    zone2:           { min: 2.618,  max: 3.0 },
    spinningTopMode: 'SINGLE_LAST',
    zoneLifetime:    Infinity,
    tp1SizePercent:  50,
    riskPercent:     1,
  });

  registry.register(strategy);

  const strategyEngine = new StrategyEngine({
    messageBroker:    broker,
    strategyRegistry: registry,
    marketStateBuilder: stateBuilder,
    timeProvider,
  });

  const replayRepo = {
    getCandles: (sym: string, tf: string, f: number, t: number) =>
      candleRepo.getCandles(sym, tf, f, t),
  };

  const replayProvider = new ReplayProvider({
    repository:    replayRepo,
    messageBroker: broker,
    timeProvider,
  });

  const fillSimulator = new FillSimulator({
    candleRepository: candleRepo,
    timeProvider,
  });

  const metricsCalc = new MetricsCalculator();

  const backtestRepo = {
    saveRun: async (_report: BacktestReport) => `interval-${interval}`,
  };

  const runner = new BacktestRunner({
    replayProvider,
    strategyEngine,
    fillSimulator,
    metricsCalculator: metricsCalc,
    backtestRepository: backtestRepo,
    messageBroker: broker,
  });

  return runner.run({
    strategyId:    strategy.id,
    symbol,
    timeframe:     '1m',
    from,
    to,
    initialCapital: 10_000,
    riskPercent:    1,
    warmupCandles:  interval * 20,
  });
}

// ---------------------------------------------------------------------------
// Tabla de resultados
// ---------------------------------------------------------------------------

function printTable(
  results: Array<{ interval: number; report: BacktestReport; ms: number }>,
): void {
  const header = [
    'TF'.padStart(4),
    'Trades'.padStart(7),
    'WinRate'.padStart(8),
    'ProfFactor'.padStart(11),
    'MaxDD'.padStart(7),
    'Expectancy'.padStart(11),
    'FinalCap'.padStart(10),
    'Time'.padStart(7),
  ].join('  ');

  const sep = '─'.repeat(header.length);

  console.log('\n' + sep);
  console.log(header);
  console.log(sep);

  for (const { interval, report, ms } of results) {
    const m: Metrics = report.metrics;

    const row = [
      `${interval}m`.padStart(4),
      String(m.totalTrades).padStart(7),
      `${(m.winRate * 100).toFixed(1)}%`.padStart(8),
      m.profitFactor === Infinity
        ? '     ∞'.padStart(11)
        : m.profitFactor.toFixed(2).padStart(11),
      `${(m.maxDrawdown * 100).toFixed(1)}%`.padStart(7),
      `$${m.expectancy.toFixed(2)}`.padStart(11),
      `$${m.finalCapital.toFixed(0)}`.padStart(10),
      `${(ms / 1000).toFixed(1)}s`.padStart(7),
    ].join('  ');

    console.log(row);
  }

  console.log(sep + '\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  loadEnv();

  const { symbol, from, to, intervals } = parseArgs();

  console.log(`\nSpinningTopFibStrategy — Backtest comparativo`);
  console.log(`Symbol : ${symbol}`);
  console.log(`Rango  : ${new Date(from).toISOString().slice(0, 10)} → ${new Date(to).toISOString().slice(0, 10)}`);
  console.log(`Intervalos: ${intervals.join(', ')} minutos`);

  const pool = new Pool({
    host:     process.env['DB_HOST']     ?? 'localhost',
    port:     Number(process.env['DB_PORT'] ?? 5432),
    user:     process.env['DB_USER']     ?? 'postgres',
    password: process.env['DB_PASSWORD'] ?? '',
    database: process.env['DB_NAME']     ?? 'market_tracker',
  });

  const results: Array<{ interval: number; report: BacktestReport; ms: number }> = [];

  for (const interval of intervals) {
    process.stdout.write(`  Corriendo ${interval}m...`);
    const t0 = Date.now();

    try {
      const report = await runInterval(interval, symbol, from, to, pool);
      const ms     = Date.now() - t0;
      results.push({ interval, report, ms });
      console.log(` ${report.metrics.totalTrades} trades (${(ms / 1000).toFixed(1)}s)`);
    } catch (err) {
      console.log(` ERROR: ${(err as Error).message}`);
    }
  }

  await pool.end();

  if (results.length > 0) {
    printTable(results);
  }
}

main().catch(err => {
  console.error('Error fatal:', err.message);
  process.exit(1);
});
