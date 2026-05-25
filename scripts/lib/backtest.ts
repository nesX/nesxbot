import { writeFileSync } from 'fs';
import { resolve }       from 'path';

import CandleRepository   from '../../src/data/CandleRepository.js';
import ReplayProvider     from '../../src/data/ReplayProvider.js';
import StrategyEngine     from '../../src/strategy/StrategyEngine.js';
import StrategyRegistry   from '../../src/strategy/StrategyRegistry.js';
import MarketStateBuilder from '../../src/strategy/MarketStateBuilder.js';
import FillSimulator      from '../../src/backtest/FillSimulator.js';
import MetricsCalculator  from '../../src/backtest/MetricsCalculator.js';
import BacktestRunner     from '../../src/backtest/BacktestRunner.js';
import BacktestRepository  from '../../src/backtest/BacktestRepository.js';
import { createMessageBroker } from '../../src/shared/MessageBroker.js';
import type StrategyBase  from '../../src/strategy/StrategyBase.js';
import type { BacktestReport, Candle, GranularDataInfo } from '../../src/types.js';
import type { Pool } from './db.js';

interface CandleRepo {
  getCandles(symbol: string, timeframe: string, from: number, to: number): Promise<Candle[]>;
  hasGranularData(symbol: string, from: number, to: number): Promise<GranularDataInfo>;
}

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface RunConfig {
  symbol: string;
  from: number;
  to: number;
  initialCapital?: number;
  riskPercent?: number;
  warmupCandles?: number;
  maxCandles?: number;
  /** Comisión taker por lado en % del notional (default 0.04 = 0.04%). */
  takerFeePercent?: number;
  /**
   * Persiste la corrida en backtest_runs / backtest_trades.
   * Por defecto false (grid search corre miles de backtests y no debe guardar
   * todos). El bucle de iteración de la IA lo activa para comparar runs.
   */
  persist?: boolean;
  /** Suprime todos los logs internos (útil en grid search / workers) */
  silent?: boolean;
  /** Logger personalizado — si se provee, tiene prioridad sobre silent */
  logger?: { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
}

/** Detalle completo de un trade para validación manual */
export interface TradeDetail {
  tradeId: string;
  strategyId: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  // Plan original
  entryPrice: number;
  stopLoss: number;
  tp1Price: number;
  tp2Price: number;
  // Fill real
  entryFillPrice: number;
  entryTime: string;       // ISO string — fácil de buscar en TradingView
  entryTimestamp: number;
  exitFillPrice: number;
  exitTime: string;
  exitTimestamp: number;
  exitType: string;
  // Resultado
  pnl: number;
  pnlPercent: number;
  resolutionMode: string;
  hadAmbiguity: boolean;
  // Origen (spinning top u otro patrón)
  zoneLabel: string;
  spinningTopTime: string;
  spinningTopHigh: number;
  spinningTopLow: number;
  spinningTopRange: number;
}

export interface BacktestResult {
  report: BacktestReport;
  trades: TradeDetail[];
}

// ---------------------------------------------------------------------------
// TimeProvider mutable para backtest
// ---------------------------------------------------------------------------

export function createReplayTimeProvider() {
  let current = 0;
  return {
    now:     ()           => current,
    setTime: (ms: number) => { current = ms; },
  };
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Cablea todos los módulos de infraestructura y ejecuta un backtest completo.
 * Captura el detalle de cada trade (TradePlan + FillResult) para validación manual.
 */
export async function runBacktest(
  strategy: StrategyBase,
  config: RunConfig,
  pool: Pool,
  repo?: CandleRepo,
): Promise<BacktestResult> {
  const {
    symbol,
    from,
    to,
    initialCapital = 10_000,
    riskPercent    = 1,
    warmupCandles  = 0,
    maxCandles     = 1000,
    takerFeePercent = 0.04,
    persist        = false,
    silent         = false,
    logger: customLogger,
  } = config;

  const noop         = { info: () => {}, warn: () => {}, error: () => {} };
  const activeLogger = customLogger ?? (silent ? noop : undefined);
  const broker       = createMessageBroker();
  const timeProvider = createReplayTimeProvider();
  const candleRepo   = repo ?? new CandleRepository({ db: pool });

  const registry = new StrategyRegistry();
  registry.register(strategy);

  const stateBuilder = new MarketStateBuilder({ timeProvider, maxCandles });

  const strategyEngine = new StrategyEngine({
    messageBroker:      broker,
    strategyRegistry:   registry,
    marketStateBuilder: stateBuilder,
    timeProvider,
    ...(activeLogger ? { logger: activeLogger } : {}),
  });

  const replayProvider = new ReplayProvider({
    repository:    { getCandles: (...a) => candleRepo.getCandles(...a) },
    messageBroker: broker,
    timeProvider,
    ...(activeLogger ? { logger: activeLogger } : {}),
  });

  const fillSimulator = new FillSimulator({
    candleRepository: candleRepo,
    timeProvider,
    takerFeePercent,
    ...(activeLogger ? { logger: activeLogger } : {}),
  });

  // Persistencia real solo si se pide; en grid search se deja en no-op para
  // no escribir miles de filas.
  const backtestRepository = persist
    ? new BacktestRepository({ db: pool })
    : { saveRun: async () => strategy.id };

  const runner = new BacktestRunner({
    replayProvider,
    strategyEngine,
    fillSimulator,
    metricsCalculator:  new MetricsCalculator(),
    backtestRepository,
    messageBroker:      broker,
    ...(activeLogger ? { logger: activeLogger } : {}),
  });

  // Capturar TradePlan de cada trade en EXECUTION_TRADE_OPENED
  // (BacktestRunner incluye el tradePlan completo en este evento)
  const plansByTradeId = new Map<string, Record<string, unknown>>();

  broker.subscribe('EXECUTION_TRADE_OPENED', (payload) => {
    const p = payload as Record<string, unknown>;
    const tradeId  = p['tradeId']  as string;
    const tradePlan = p['tradePlan'] as Record<string, unknown>;
    if (tradeId && tradePlan) plansByTradeId.set(tradeId, tradePlan);
  });

  const report = await runner.run({
    strategyId:    strategy.id,
    symbol,
    timeframe:     '1m',
    from,
    to,
    initialCapital,
    riskPercent,
    warmupCandles,
  });

  // Combinar FillResult con su TradePlan para construir TradeDetail
  const trades: TradeDetail[] = report.trades.map(fill => {
    const plan = plansByTradeId.get(fill.tradeId) ?? {};
    const meta = (plan['metadata'] ?? {}) as Record<string, unknown>;
    const tps   = (plan['takeProfits'] as Array<{ price: number }> | undefined) ?? [];

    return {
      tradeId:          fill.tradeId,
      strategyId:       String(plan['strategyId'] ?? strategy.id),
      symbol:           String(plan['symbol']     ?? symbol),
      direction:        (plan['direction'] as 'LONG' | 'SHORT') ?? 'LONG',
      entryPrice:       Number(plan['entryPrice'] ?? fill.entryFill.price),
      stopLoss:         Number(plan['stopLoss']   ?? 0),
      tp1Price:         tps[0]?.price ?? 0,
      tp2Price:         tps[1]?.price ?? 0,
      entryFillPrice:   fill.entryFill.price,
      entryTime:        new Date(fill.entryFill.timestamp).toISOString(),
      entryTimestamp:   fill.entryFill.timestamp,
      exitFillPrice:    fill.exitFill.price,
      exitTime:         new Date(fill.exitFill.timestamp).toISOString(),
      exitTimestamp:    fill.exitFill.timestamp,
      exitType:         fill.exitFill.type,
      pnl:              fill.pnl,
      pnlPercent:       fill.pnlPercent,
      resolutionMode:   fill.resolution_mode,
      hadAmbiguity:     fill.had_ambiguity,
      zoneLabel:        String(meta['zoneLabel']        ?? ''),
      spinningTopTime:  meta['spinningTopTime']
        ? new Date(Number(meta['spinningTopTime'])).toISOString()
        : '',
      spinningTopHigh:  Number(meta['spinningTopHigh']  ?? 0),
      spinningTopLow:   Number(meta['spinningTopLow']   ?? 0),
      spinningTopRange: Number(meta['spinningTopRange'] ?? 0),
    };
  });

  return { report, trades };
}

// ---------------------------------------------------------------------------
// Exportar CSV
// ---------------------------------------------------------------------------

/**
 * Guarda un CSV con todos los trades de todos los intervalos.
 * Una fila = un trade. Incluye columnas suficientes para validar en TradingView.
 */
export function exportCsv(
  allTrades: Array<{ interval: number; trades: TradeDetail[] }>,
  outputPath?: string,
): string {
  const path = outputPath ?? resolve(process.cwd(), `docs/backtest/results/backtest-trades-${Date.now()}.csv`);

  const headers = [
    'interval', 'tradeId', 'symbol', 'direction',
    'entryTime', 'entryPrice', 'entryFillPrice',
    'stopLoss', 'tp1Price', 'tp2Price',
    'exitTime', 'exitFillPrice', 'exitType',
    'pnl', 'pnlPercent', 'resolutionMode', 'hadAmbiguity',
    'zoneLabel', 'spinningTopTime', 'spinningTopHigh', 'spinningTopLow', 'spinningTopRange',
  ];

  const rows = allTrades.flatMap(({ interval, trades }) =>
    trades.map(t => [
      interval,
      t.tradeId,
      t.symbol,
      t.direction,
      t.entryTime,
      t.entryPrice,
      t.entryFillPrice,
      t.stopLoss,
      t.tp1Price,
      t.tp2Price,
      t.exitTime,
      t.exitFillPrice,
      t.exitType,
      t.pnl,
      t.pnlPercent,
      t.resolutionMode,
      t.hadAmbiguity,
      t.zoneLabel,
      t.spinningTopTime,
      t.spinningTopHigh,
      t.spinningTopLow,
      t.spinningTopRange,
    ].join(','))
  );

  writeFileSync(path, [headers.join(','), ...rows].join('\n'), 'utf-8');
  return path;
}
