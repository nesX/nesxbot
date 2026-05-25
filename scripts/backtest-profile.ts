/**
 * scripts/backtest-profile.ts
 *
 * Corre UN backtest con instrumentación de tiempos para identificar el bottleneck.
 * Usa solo 1 intervalo y un rango corto de fechas para que termine rápido.
 *
 * Uso:
 *   npx tsx scripts/backtest-profile.ts
 *   npx tsx scripts/backtest-profile.ts --interval 5 --days 7
 */

import { loadEnv }             from './lib/env.js';
import { createPool }          from './lib/db.js';
import { createReplayTimeProvider } from './lib/backtest.js';
import { createMessageBroker } from '../src/shared/MessageBroker.js';
import CandleRepository        from '../src/data/CandleRepository.js';
import ReplayProvider          from '../src/data/ReplayProvider.js';
import StrategyEngine          from '../src/strategy/StrategyEngine.js';
import StrategyRegistry        from '../src/strategy/StrategyRegistry.js';
import MarketStateBuilder      from '../src/strategy/MarketStateBuilder.js';
import FillSimulator           from '../src/backtest/FillSimulator.js';
import MetricsCalculator       from '../src/backtest/MetricsCalculator.js';
import BacktestRunner          from '../src/backtest/BacktestRunner.js';
import SpinningTopFibStrategy  from '../src/strategy/strategies/SpinningTopFibStrategy.js';

loadEnv();

const args       = process.argv.slice(2);
const getArg     = (flag: string, fallback: string) => {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
};
const INTERVAL   = Number(getArg('--interval', '5'));
const DAYS       = Number(getArg('--days', '7'));   // días a probar (máx 31)
const SYMBOL     = getArg('--symbol', 'BTCUSDT');

const FROM = Date.parse('2025-01-01T00:00:00Z');
const TO   = FROM + DAYS * 24 * 60 * 60 * 1000;

console.log(`\nProfiling backtest — ${SYMBOL} ${INTERVAL}m — ${DAYS} días`);
console.log('─'.repeat(55));

// ---------------------------------------------------------------------------
// Contadores de tiempo
// ---------------------------------------------------------------------------

const timers = {
  dbFetch:      0,   // tiempo total de queries a BD
  fillSimulator: 0,  // tiempo total en FillSimulator (incluye queries 1s)
  evaluate:     0,   // tiempo total en strategy.evaluate()
  candleLoop:   0,   // tiempo total procesando candles (evento MARKET_CANDLE_CLOSED)
};

let candleCount  = 0;
let signalCount  = 0;
let fillCount    = 0;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const pool         = createPool();
const broker       = createMessageBroker();
const timeProvider = createReplayTimeProvider();
const candleRepo   = new CandleRepository({ db: pool });

// Wrappear getCandles para medir tiempo de DB
const wrappedRepo = {
  hasGranularData: async (sym: string, f: number, t: number) => {
    const t0 = performance.now();
    const r  = await candleRepo.hasGranularData(sym, f, t);
    timers.dbFetch += performance.now() - t0;
    return r;
  },
  getCandles: async (sym: string, tf: string, f: number, t: number) => {
    const t0 = performance.now();
    const r  = await candleRepo.getCandles(sym, tf, f, t);
    timers.dbFetch += performance.now() - t0;
    return r;
  },
};

const registry  = new StrategyRegistry();
const strategy  = new SpinningTopFibStrategy({
  candleInterval:  INTERVAL,
  maxBodyPercent:  30,
  minRangePercent: 0.3,
  zone1:           { min: 1.8,   max: 2.1 },
  zone2:           { min: 2.618, max: 3.0 },
  spinningTopMode: 'SINGLE_LAST',
  tp1SizePercent:  50,
  riskPercent:     1,
});

registry.register(strategy);

const stateBuilder = new MarketStateBuilder({ timeProvider, maxCandles: 1000 });

// Wrappear evaluate para medir tiempo de estrategia
const originalEvaluate = strategy.evaluate.bind(strategy);
(strategy as unknown as { evaluate: typeof originalEvaluate }).evaluate = async (state) => {
  const t0 = performance.now();
  const r  = await originalEvaluate(state);
  timers.evaluate += performance.now() - t0;
  return r;
};

const strategyEngine = new StrategyEngine({
  messageBroker:      broker,
  strategyRegistry:   registry,
  marketStateBuilder: stateBuilder,
  timeProvider,
});

// Contar candles y medir tiempo del loop completo
broker.subscribe('MARKET_CANDLE_CLOSED', () => { candleCount++; });
broker.subscribe('STRATEGY_SIGNAL_GENERATED', () => { signalCount++; });

const replayProvider = new ReplayProvider({
  repository:    { getCandles: (...a) => wrappedRepo.getCandles(...a) },
  messageBroker: broker,
  timeProvider,
});

// Wrappear FillSimulator para medir su tiempo
const fillSim = new FillSimulator({ candleRepository: wrappedRepo, timeProvider });
const originalSimulate = fillSim.simulateFill.bind(fillSim);
(fillSim as unknown as { simulateFill: typeof originalSimulate }).simulateFill = async (...a) => {
  const t0 = performance.now();
  const r  = await originalSimulate(...a);
  timers.fillSimulator += performance.now() - t0;
  fillCount++;
  return r;
};

const runner = new BacktestRunner({
  replayProvider,
  strategyEngine,
  fillSimulator:      fillSim,
  metricsCalculator:  new MetricsCalculator(),
  backtestRepository: { saveRun: async () => 'profile' },
  messageBroker:      broker,
});

// ---------------------------------------------------------------------------
// Correr
// ---------------------------------------------------------------------------

const totalStart = performance.now();

const report = await runner.run({
  strategyId:     strategy.id,
  symbol:         SYMBOL,
  timeframe:      '1m',
  from:           FROM,
  to:             TO,
  initialCapital: 10_000,
  riskPercent:    1,
  warmupCandles:  INTERVAL * 20,
});

const totalMs = performance.now() - totalStart;

await pool.end();

// ---------------------------------------------------------------------------
// Reporte
// ---------------------------------------------------------------------------

const other = totalMs - timers.dbFetch - timers.fillSimulator - timers.evaluate;

console.log(`\nResultados: ${report.metrics.totalTrades} trades\n`);
console.log('Tiempo total:       ' + totalMs.toFixed(0).padStart(8) + ' ms');
console.log('─'.repeat(55));
console.log('DB fetch (candles): ' + timers.dbFetch.toFixed(0).padStart(8) + ' ms' +
  `  (${(timers.dbFetch / totalMs * 100).toFixed(1)}%)`);
console.log('FillSimulator:      ' + timers.fillSimulator.toFixed(0).padStart(8) + ' ms' +
  `  (${(timers.fillSimulator / totalMs * 100).toFixed(1)}%)  ← ${fillCount} fills`);
console.log('strategy.evaluate:  ' + timers.evaluate.toFixed(0).padStart(8) + ' ms' +
  `  (${(timers.evaluate / totalMs * 100).toFixed(1)}%)  ← ${candleCount} candles`);
console.log('Overhead/otros:     ' + other.toFixed(0).padStart(8) + ' ms' +
  `  (${(other / totalMs * 100).toFixed(1)}%)`);
console.log('─'.repeat(55));
console.log(`Señales generadas:  ${signalCount}`);
console.log(`ms por candle:      ${(timers.evaluate / candleCount).toFixed(3)} ms`);
console.log(`ms por fill:        ${fillCount ? (timers.fillSimulator / fillCount).toFixed(0) : 'n/a'} ms`);
