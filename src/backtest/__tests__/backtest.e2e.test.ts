/**
 * backtest.e2e.test.ts
 *
 * Test de integración end-to-end del flujo completo de backtest.
 *
 * Cubre el pipeline sin mocks de lógica de negocio:
 *   ReplayProvider → StrategyEngine (FibonacciVolumeStrategy) →
 *   FillSimulator → MetricsCalculator → BacktestReport
 */

import BacktestRunner          from '../BacktestRunner.js';
import FillSimulator           from '../FillSimulator.js';
import MetricsCalculator       from '../MetricsCalculator.js';
import ReplayProvider          from '../../data/ReplayProvider.js';
import StrategyEngine          from '../../strategy/StrategyEngine.js';
import StrategyRegistry        from '../../strategy/StrategyRegistry.js';
import MarketStateBuilder      from '../../strategy/MarketStateBuilder.js';
import FibonacciVolumeStrategy from '../../strategy/strategies/FibonacciVolumeStrategy.js';
import type { Candle, BacktestReport, BacktestConfig } from '../../types.js';

// ---------------------------------------------------------------------------
// Constantes del test
// ---------------------------------------------------------------------------

const SYMBOL          = 'BTCUSDT';
const TIMEFRAME       = '1m';
const INITIAL_CAPITAL = 10_000;
const BASE_TIME       = 1_700_000_000_000;
const CANDLE_STEP     = 60_000;

const NORMAL_VOLUME = 100;
const HIGH_VOLUME   = NORMAL_VOLUME * 6;

const TRIGGER_LOW  = 29900;
const TRIGGER_HIGH = 30500;
const RANGE        = TRIGGER_HIGH - TRIGGER_LOW;

const TOUCH_LEVEL_PRICE = TRIGGER_LOW + RANGE * 1.8;
const TP1_PRICE = TRIGGER_LOW + RANGE * 3.0;
const SL_PRICE  = TRIGGER_LOW;

// ---------------------------------------------------------------------------
// Helper: MessageBroker en memoria
// ---------------------------------------------------------------------------

interface BrokerEvent {
  channel: string;
  payload: Record<string, unknown>;
}

function makeMessageBroker() {
  const published: BrokerEvent[] = [];
  const handlers: Record<string, ((payload: unknown) => void | Promise<void>)[]> = {};

  return {
    published,
    subscribe: (channel: string, handler: (payload: unknown) => void | Promise<void>) => {
      if (!handlers[channel]) handlers[channel] = [];
      handlers[channel].push(handler);
    },
    unsubscribe: (channel: string, handler: (payload: unknown) => void | Promise<void>) => {
      if (!handlers[channel]) return;
      handlers[channel] = handlers[channel].filter(h => h !== handler);
    },
    publish: async (channel: string, payload: Record<string, unknown>) => {
      published.push({ channel, payload });
      if (handlers[channel]) {
        for (const handler of handlers[channel]) {
          await handler(payload);
        }
      }
    },
    getEvents: (channel: string) => published.filter(e => e.channel === channel),
  };
}

// ---------------------------------------------------------------------------
// Helper: TimeProvider con setTime()
// ---------------------------------------------------------------------------

function makeTimeProvider(initialMs = BASE_TIME) {
  let current = initialMs;
  return {
    now:     () => current,
    setTime: (ms: number) => { current = ms; },
  };
}

// ---------------------------------------------------------------------------
// Helper: logger silencioso
// ---------------------------------------------------------------------------

function makeSilentLogger() {
  return {
    info:  () => {},
    warn:  () => {},
    error: () => {},
  };
}

// ---------------------------------------------------------------------------
// buildTestCandles()
// ---------------------------------------------------------------------------

function buildTestCandles(): Candle[] {
  const candles: Candle[] = [];

  for (let i = 0; i < 20; i++) {
    candles.push({
      symbol:    SYMBOL,
      timeframe: TIMEFRAME,
      openTime:  BASE_TIME + i * CANDLE_STEP,
      open:      30000,
      high:      30500,
      low:       29900,
      close:     30200,
      volume:    NORMAL_VOLUME,
      isClosed:  true,
    });
  }

  candles.push({
    symbol:    SYMBOL,
    timeframe: TIMEFRAME,
    openTime:  BASE_TIME + 20 * CANDLE_STEP,
    open:      30000,
    high:      TRIGGER_HIGH,
    low:       TRIGGER_LOW,
    close:     30400,
    volume:    HIGH_VOLUME,
    isClosed:  true,
  });

  candles.push({
    symbol:    SYMBOL,
    timeframe: TIMEFRAME,
    openTime:  BASE_TIME + 21 * CANDLE_STEP,
    open:      30980,
    high:      32000,
    low:       30600,
    close:     TOUCH_LEVEL_PRICE,
    volume:    NORMAL_VOLUME,
    isClosed:  true,
  });

  return candles;
}

// ---------------------------------------------------------------------------
// buildDeps()
// ---------------------------------------------------------------------------

function buildDeps(testCandles: Candle[]) {
  const timeProvider = makeTimeProvider();
  const broker       = makeMessageBroker();
  const logger       = makeSilentLogger();

  const replayRepo = {
    getCandles: async (symbol: string, timeframe: string, from: number, to: number) =>
      testCandles.filter(c => c.openTime >= from && c.openTime <= to),
  };

  const candleRepo = {
    hasGranularData: async () => ({ has1s: false, has1m: false }),
    getCandles:      async (): Promise<Candle[]> => [],
  };

  const backtestRepo = {
    saveRun: async () => 'run-e2e-001',
  };

  const replayProvider = new ReplayProvider({
    repository:    replayRepo,
    messageBroker: broker,
    timeProvider,
    logger,
  });

  const strategy = new FibonacciVolumeStrategy();

  const registry = new StrategyRegistry();
  registry.register(strategy);

  const stateBuilder = new MarketStateBuilder({ timeProvider, logger });

  const strategyEngine = new StrategyEngine({
    messageBroker:      broker,
    strategyRegistry:   registry,
    marketStateBuilder: stateBuilder,
    timeProvider,
    logger,
  });

  const fillSimulator = new FillSimulator({
    candleRepository: candleRepo,
    timeProvider,
    logger,
  });

  const metricsCalculator = new MetricsCalculator();

  const runner = new BacktestRunner({
    replayProvider,
    strategyEngine,
    fillSimulator,
    metricsCalculator,
    backtestRepository: backtestRepo,
    messageBroker:      broker,
    logger,
  });

  return { runner, broker, backtestRepo };
}

// ---------------------------------------------------------------------------
// Config base del backtest
// ---------------------------------------------------------------------------

function buildConfig(testCandles: Candle[]): BacktestConfig & { riskPercent: number } {
  const lastCandle = testCandles[testCandles.length - 1];
  return {
    strategyId:     'fibonacci-volume-v1',
    symbol:         SYMBOL,
    timeframe:      TIMEFRAME,
    from:           BASE_TIME,
    to:             lastCandle.openTime,
    initialCapital: INITIAL_CAPITAL,
    riskPercent:    1,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Backtest E2E', () => {
  let testCandles: Candle[];
  let runner: BacktestRunner;
  let broker: ReturnType<typeof makeMessageBroker>;
  let backtestRepo: { saveRun: () => Promise<string> };
  let report: BacktestReport;
  let config: ReturnType<typeof buildConfig>;

  beforeAll(async () => {
    testCandles  = buildTestCandles();
    ({ runner, broker, backtestRepo } = buildDeps(testCandles));
    config       = buildConfig(testCandles);
    report       = await runner.run(config);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Estructura del reporte
  // -------------------------------------------------------------------------

  describe('estructura del BacktestReport', () => {
    test('report no es null', () => {
      expect(report).not.toBeNull();
      expect(typeof report).toBe('object');
    });

    test('report tiene las propiedades de primer nivel: config, metrics, trades', () => {
      expect(report).toHaveProperty('config');
      expect(report).toHaveProperty('metrics');
      expect(report).toHaveProperty('trades');
    });

    test('report.config refleja la configuración pasada a run()', () => {
      expect(report.config).toMatchObject({
        strategyId:     config.strategyId,
        symbol:         config.symbol,
        timeframe:      config.timeframe,
        from:           config.from,
        to:             config.to,
        initialCapital: config.initialCapital,
        riskPercent:    config.riskPercent,
      });
    });

    test('report.trades es un array', () => {
      expect(Array.isArray(report.trades)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Señal generada — al menos un trade
  // -------------------------------------------------------------------------

  describe('generación de señal por FibonacciVolumeStrategy', () => {
    test('se generó al menos un trade simulado', () => {
      expect(report.trades.length).toBeGreaterThanOrEqual(1);
    });

    test('cada trade tiene los campos requeridos del FillResult', () => {
      for (const trade of report.trades) {
        expect(trade).toHaveProperty('tradeId');
        expect(typeof trade.tradeId).toBe('string');
        expect(trade.tradeId.length).toBeGreaterThan(0);

        expect(trade).toHaveProperty('entryFill');
        expect(trade.entryFill).toHaveProperty('price');
        expect(trade.entryFill).toHaveProperty('timestamp');
        expect(trade.entryFill).toHaveProperty('slippage');

        expect(trade).toHaveProperty('exitFill');
        expect(trade.exitFill).toHaveProperty('price');
        expect(trade.exitFill).toHaveProperty('timestamp');
        expect(trade.exitFill).toHaveProperty('type');

        expect(trade).toHaveProperty('pnl');
        expect(typeof trade.pnl).toBe('number');

        expect(trade).toHaveProperty('resolution_mode');
        expect(['PRECISE_1S', 'PRECISE_1M', 'PESSIMISTIC']).toContain(trade.resolution_mode);

        expect(trade).toHaveProperty('had_ambiguity');
        expect(typeof trade.had_ambiguity).toBe('boolean');
      }
    });

    test('el primer trade es una señal LONG en el nivel Fibonacci 1.8 (30980)', () => {
      const trade = report.trades[0];
      expect(trade.entryFill.price).toBeGreaterThan(TOUCH_LEVEL_PRICE * 0.999);
      expect(trade.entryFill.price).toBeLessThan(TOUCH_LEVEL_PRICE * 1.002);
    });

    test('el primer trade resolvió en modo PESSIMISTIC (sin datos granulares en el stub)', () => {
      expect(report.trades[0].resolution_mode).toBe('PESSIMISTIC');
    });

    test('el primer trade alcanzó TP1 — aparece en partialFills o exitFill', () => {
      const trade = report.trades[0];
      const hitTp =
        trade.exitFill.type.startsWith('TP') ||
        trade.partialFills.some((f: { type: string }) => f.type.startsWith('TP'));
      expect(hitTp).toBe(true);
    });

    test('el primer trade tiene PnL positivo (cerró en TP)', () => {
      expect(report.trades[0].pnl).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Métricas
  // -------------------------------------------------------------------------

  describe('report.metrics', () => {
    test('metrics existe y es un objeto', () => {
      expect(report.metrics).toBeDefined();
      expect(typeof report.metrics).toBe('object');
    });

    test('metrics tiene todos los campos requeridos', () => {
      expect(report.metrics).toHaveProperty('totalTrades');
      expect(report.metrics).toHaveProperty('winRate');
      expect(report.metrics).toHaveProperty('profitFactor');
      expect(report.metrics).toHaveProperty('maxDrawdown');
      expect(report.metrics).toHaveProperty('sharpeRatio');
      expect(report.metrics).toHaveProperty('sortinoRatio');
      expect(report.metrics).toHaveProperty('expectancy');
      expect(report.metrics).toHaveProperty('finalCapital');
      expect(report.metrics).toHaveProperty('tpBreakdown');
      expect(report.metrics).toHaveProperty('resolution_confidence');
      expect(report.metrics).toHaveProperty('pessimistic_penalties');
    });

    test('metrics.totalTrades === report.trades.length', () => {
      expect(report.metrics.totalTrades).toBe(report.trades.length);
    });

    test('metrics.totalTrades >= 1', () => {
      expect(report.metrics.totalTrades).toBeGreaterThanOrEqual(1);
    });

    test('metrics.winRate está entre 0 y 100', () => {
      expect(report.metrics.winRate).toBeGreaterThanOrEqual(0);
      expect(report.metrics.winRate).toBeLessThanOrEqual(100);
    });

    test('metrics.finalCapital es un número positivo', () => {
      expect(typeof report.metrics.finalCapital).toBe('number');
      expect(report.metrics.finalCapital).toBeGreaterThan(0);
    });

    test('metrics.maxDrawdown es un número >= 0', () => {
      expect(typeof report.metrics.maxDrawdown).toBe('number');
      expect(report.metrics.maxDrawdown).toBeGreaterThanOrEqual(0);
    });

    test('metrics.tpBreakdown tiene las claves tp1, tp2, tp3', () => {
      expect(report.metrics.tpBreakdown).toHaveProperty('tp1');
      expect(report.metrics.tpBreakdown).toHaveProperty('tp2');
      expect(report.metrics.tpBreakdown).toHaveProperty('tp3');
    });

    test('metrics.resolution_confidence suma 100% cuando hay trades', () => {
      const conf = report.metrics.resolution_confidence;
      const sum  = conf.PRECISE_1S + conf.PRECISE_1M + conf.PESSIMISTIC;
      expect(sum).toBeCloseTo(100, 5);
    });

    test('metrics.resolution_confidence es 100% PESSIMISTIC (stub sin datos granulares)', () => {
      const conf = report.metrics.resolution_confidence;
      expect(conf.PESSIMISTIC).toBeCloseTo(100, 5);
      expect(conf.PRECISE_1S).toBe(0);
      expect(conf.PRECISE_1M).toBe(0);
    });

    test('metrics.winRate es 100% (todos los trades cerraron en TP en este set de datos)', () => {
      expect(report.metrics.winRate).toBeCloseTo(100, 5);
    });

    test('metrics.profitFactor es mayor que 1 (más ganancia que pérdida)', () => {
      expect(report.metrics.profitFactor).toBeGreaterThan(1);
    });
  });

  // -------------------------------------------------------------------------
  // Eventos del MessageBroker
  // -------------------------------------------------------------------------

  describe('eventos emitidos por el broker', () => {
    test('EXECUTION_TRADE_OPENED fue emitido tantas veces como trades hay en el reporte', () => {
      const events = broker.getEvents('EXECUTION_TRADE_OPENED');
      expect(events.length).toBe(report.trades.length);
    });

    test('EXECUTION_TRADE_CLOSED fue emitido tantas veces como trades hay en el reporte', () => {
      const events = broker.getEvents('EXECUTION_TRADE_CLOSED');
      expect(events.length).toBe(report.trades.length);
    });

    test('payload de EXECUTION_TRADE_OPENED contiene los campos esperados', () => {
      const events = broker.getEvents('EXECUTION_TRADE_OPENED');
      expect(events.length).toBeGreaterThanOrEqual(1);

      const { payload } = events[0];
      expect(payload).toHaveProperty('tradeId');
      expect(typeof payload['tradeId']).toBe('string');
      expect(payload).toHaveProperty('strategyId', 'fibonacci-volume-v1');
      expect(payload).toHaveProperty('symbol', SYMBOL);
      expect(payload).toHaveProperty('direction', 'LONG');
      expect(payload).toHaveProperty('entryPrice');
      expect(typeof payload['entryPrice']).toBe('number');
      expect(payload).toHaveProperty('timestamp');
      expect(payload).toHaveProperty('tradePlan');
    });

    test('payload de EXECUTION_TRADE_CLOSED contiene pnl, exitType y fillResult', () => {
      const events = broker.getEvents('EXECUTION_TRADE_CLOSED');
      expect(events.length).toBeGreaterThanOrEqual(1);

      const { payload } = events[0];
      expect(payload).toHaveProperty('tradeId');
      expect(payload).toHaveProperty('pnl');
      expect(typeof payload['pnl']).toBe('number');
      expect(payload).toHaveProperty('exitType');
      expect(payload).toHaveProperty('fillResult');
      expect((payload['fillResult'] as Record<string, unknown>)).toHaveProperty('resolution_mode');
    });

    test('EXECUTION_PARTIAL_FILLED fue emitido al menos una vez (trade cerró en TP)', () => {
      const partialEvents = broker.getEvents('EXECUTION_PARTIAL_FILLED');
      expect(partialEvents.length).toBeGreaterThanOrEqual(1);
    });

    test('los tradeId de OPENED y CLOSED son consistentes entre sí', () => {
      const openedIds = broker.getEvents('EXECUTION_TRADE_OPENED').map(e => e.payload['tradeId']);
      const closedIds = broker.getEvents('EXECUTION_TRADE_CLOSED').map(e => e.payload['tradeId']);

      expect(openedIds).toEqual(closedIds);
    });
  });

  // -------------------------------------------------------------------------
  // Coherencia interna del reporte
  // -------------------------------------------------------------------------

  describe('coherencia interna del BacktestReport', () => {
    test('los tradeId en report.trades son únicos', () => {
      const ids = report.trades.map(t => t.tradeId);
      const unique = new Set(ids);
      expect(unique.size).toBe(ids.length);
    });

    test('entryFill.price de cada trade es un número positivo', () => {
      for (const trade of report.trades) {
        expect(typeof trade.entryFill.price).toBe('number');
        expect(trade.entryFill.price).toBeGreaterThan(0);
      }
    });

    test('exitFill.price de cada trade es un número positivo', () => {
      for (const trade of report.trades) {
        expect(typeof trade.exitFill.price).toBe('number');
        expect(trade.exitFill.price).toBeGreaterThan(0);
      }
    });

    test('entryFill.slippage de cada trade es un número >= 0', () => {
      for (const trade of report.trades) {
        expect(typeof trade.entryFill.slippage).toBe('number');
        expect(trade.entryFill.slippage).toBeGreaterThanOrEqual(0);
      }
    });

    test('exitFill.type de cada trade es uno de los valores válidos', () => {
      const validTypes = ['TP1', 'TP2', 'TP3', 'SL', 'MANUAL'];
      for (const trade of report.trades) {
        expect(validTypes).toContain(trade.exitFill.type);
      }
    });

    test('report.id fue asignado por el BacktestRepository', () => {
      expect(report).toHaveProperty('id', 'run-e2e-001');
    });
  });

  // -------------------------------------------------------------------------
  // Invariantes del flujo completo
  // -------------------------------------------------------------------------

  describe('invariantes del flujo end-to-end', () => {
    test('el número de EXECUTION_TRADE_OPENED coincide con el de EXECUTION_TRADE_CLOSED', () => {
      const opened = broker.getEvents('EXECUTION_TRADE_OPENED').length;
      const closed = broker.getEvents('EXECUTION_TRADE_CLOSED').length;
      expect(opened).toBe(closed);
    });

    test('todos los trades en report.trades están referenciados en los eventos del broker', () => {
      const closedIds = new Set(
        broker.getEvents('EXECUTION_TRADE_CLOSED').map(e => e.payload['tradeId'])
      );
      for (const trade of report.trades) {
        expect(closedIds.has(trade.tradeId)).toBe(true);
      }
    });

    test('metrics.finalCapital es mayor que initialCapital (todos los trades ganaron)', () => {
      expect(report.metrics.finalCapital).toBeGreaterThan(INITIAL_CAPITAL);
    });
  });
});
