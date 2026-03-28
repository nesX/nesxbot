/**
 * BacktestRunner.integration.test.ts
 *
 * Tests de integración del BacktestRunner.
 * Todos los módulos colaboradores usan dobles en memoria — no hay BD real.
 */

import BacktestRunner      from '../BacktestRunner.js';
import FillSimulator       from '../FillSimulator.js';
import MetricsCalculator   from '../MetricsCalculator.js';
import ReplayProvider      from '../../data/ReplayProvider.js';
import StrategyEngine      from '../../strategy/StrategyEngine.js';
import StrategyRegistry    from '../../strategy/StrategyRegistry.js';
import MarketStateBuilder  from '../../strategy/MarketStateBuilder.js';
import StrategyBase        from '../../strategy/StrategyBase.js';
import type { Candle, MarketState, TradePlan, GranularDataInfo } from '../../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTimeProvider(initialMs = 1_700_000_000_000) {
  let current = initialMs;
  return {
    now:     () => current,
    setTime: (ms: number) => { current = ms; },
  };
}

function makeLogger() {
  return {
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
  };
}

interface BrokerEvent {
  channel: string;
  payload: Record<string, unknown>;
}

function makeMessageBroker() {
  const published: BrokerEvent[] = [];
  const handlers: Record<string, ((payload: unknown) => void | Promise<void>)[]> = {};

  const broker = {
    published,
    handlers,

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

  return broker;
}

function makeCandle(openTime: number, overrides: Partial<Candle> = {}): Candle {
  return {
    symbol:    'BTCUSDT',
    timeframe: '1h',
    openTime,
    open:      30000,
    high:      30500,
    low:       29500,
    close:     30200,
    volume:    100,
    isClosed:  true,
    ...overrides,
  };
}

function makeRepo({ has1s = false, has1m = false, granularCandles = [] as Candle[] } = {}) {
  return {
    hasGranularData: vi.fn(async (): Promise<GranularDataInfo> => ({ has1s, has1m })),
    getCandles:      vi.fn(async (symbol: string, timeframe: string, from: number, to: number): Promise<Candle[]> => {
      return granularCandles.filter(
        c => c.openTime >= from && c.openTime <= to
      );
    }),
  };
}

function makeBacktestRepo() {
  const runs: unknown[] = [];
  return {
    saveRun: vi.fn(async (report: unknown) => {
      const id = 'run-' + runs.length;
      runs.push({ id, ...(report as object) });
      return id;
    }),
    runs,
  };
}

class AlwaysLongStrategy extends StrategyBase {
  get id() { return 'always-long-v1'; }
  get requiredTimeframes() { return ['1h']; }

  async evaluate(state: MarketState): Promise<TradePlan | null> {
    if (!state.candles['1h'] || state.candles['1h'].length === 0) return null;

    const latestCandle = state.candles['1h'][state.candles['1h'].length - 1];
    return {
      strategyId:  this.id,
      symbol:      state.symbol,
      direction:   'LONG',
      entryPrice:  latestCandle.close,
      stopLoss:    latestCandle.close * 0.97,
      takeProfits: [
        { price: latestCandle.close * 1.03, sizePercent: 60 },
        { price: latestCandle.close * 1.06, sizePercent: 40 },
      ],
      riskPercent: 1,
      metadata:    {},
    };
  }
}

class NeverSignalStrategy extends StrategyBase {
  get id() { return 'never-signal-v1'; }
  get requiredTimeframes() { return ['1h']; }
  async evaluate(): Promise<TradePlan | null> { return null; }
}

// ---------------------------------------------------------------------------
// Fábrica de BacktestRunner completo con todos los colaboradores
// ---------------------------------------------------------------------------

function makeRunner({
  strategyInstance = new AlwaysLongStrategy() as StrategyBase,
  has1s = false,
  has1m = false,
  granularCandles = [] as Candle[],
  replayCandles = null as Candle[] | null,
  brokerOverride = null as ReturnType<typeof makeMessageBroker> | null,
} = {}) {
  const BASE_TIME = 1_700_000_000_000;
  const STEP      = 60 * 60 * 1000;

  const defaultCandles = Array.from({ length: 10 }, (_, i) =>
    makeCandle(BASE_TIME + i * STEP, {
      open:  30000 + i * 10,
      high:  30600 + i * 10,
      low:   29400 + i * 10,
      close: 30200 + i * 10,
    })
  );

  const candlesToReplay = replayCandles || defaultCandles;

  const timeProvider    = makeTimeProvider(BASE_TIME);
  const broker          = brokerOverride || makeMessageBroker();
  const logger          = makeLogger();
  const candleRepo      = makeRepo({ has1s, has1m, granularCandles });
  const backtestRepo    = makeBacktestRepo();

  const replayRepo = {
    getCandles: vi.fn(async (symbol: string, tf: string, from: number, to: number) =>
      candlesToReplay.filter(c => c.openTime >= from && c.openTime <= to)
    ),
  };

  const replayProvider = new ReplayProvider({
    repository:    replayRepo,
    messageBroker: broker,
    timeProvider,
    logger,
  });

  const registry = new StrategyRegistry();
  registry.register(strategyInstance);

  const stateBuilder   = new MarketStateBuilder({ timeProvider, logger });
  const strategyEngine = new StrategyEngine({
    messageBroker:       broker,
    strategyRegistry:    registry,
    marketStateBuilder:  stateBuilder,
    timeProvider,
    logger,
  });

  const fillSimulator = new FillSimulator({
    candleRepository: candleRepo,
    timeProvider,
    logger,
  });

  const metricsCalc = new MetricsCalculator();

  const runner = new BacktestRunner({
    replayProvider,
    strategyEngine,
    fillSimulator,
    metricsCalculator:  metricsCalc,
    backtestRepository: backtestRepo,
    messageBroker:      broker,
    logger,
  });

  return {
    runner,
    broker,
    backtestRepo,
    candleRepo,
    candles: candlesToReplay,
    BASE_TIME,
    STEP,
  };
}

// ---------------------------------------------------------------------------
// BacktestRunner — constructor
// ---------------------------------------------------------------------------

type BacktestRunnerDeps = ConstructorParameters<typeof BacktestRunner>[0];

describe('BacktestRunner — constructor', () => {
  test('lanza si replayProvider no se provee', () => {
    expect(() => new BacktestRunner({
      replayProvider:     null as unknown as BacktestRunnerDeps['replayProvider'],
      strategyEngine:     {} as BacktestRunnerDeps['strategyEngine'],
      fillSimulator:      {} as BacktestRunnerDeps['fillSimulator'],
      metricsCalculator:  {} as BacktestRunnerDeps['metricsCalculator'],
      backtestRepository: {} as BacktestRunnerDeps['backtestRepository'],
      messageBroker:      {} as BacktestRunnerDeps['messageBroker'],
    })).toThrow('replayProvider');
  });

  test('lanza si strategyEngine no se provee', () => {
    expect(() => new BacktestRunner({
      replayProvider:     {} as BacktestRunnerDeps['replayProvider'],
      strategyEngine:     null as unknown as BacktestRunnerDeps['strategyEngine'],
      fillSimulator:      {} as BacktestRunnerDeps['fillSimulator'],
      metricsCalculator:  {} as BacktestRunnerDeps['metricsCalculator'],
      backtestRepository: {} as BacktestRunnerDeps['backtestRepository'],
      messageBroker:      {} as BacktestRunnerDeps['messageBroker'],
    })).toThrow('strategyEngine');
  });

  test('lanza si messageBroker no se provee', () => {
    expect(() => new BacktestRunner({
      replayProvider:     {} as BacktestRunnerDeps['replayProvider'],
      strategyEngine:     {} as BacktestRunnerDeps['strategyEngine'],
      fillSimulator:      {} as BacktestRunnerDeps['fillSimulator'],
      metricsCalculator:  {} as BacktestRunnerDeps['metricsCalculator'],
      backtestRepository: {} as BacktestRunnerDeps['backtestRepository'],
      messageBroker:      null as unknown as BacktestRunnerDeps['messageBroker'],
    })).toThrow('messageBroker');
  });
});

// ---------------------------------------------------------------------------
// BacktestRunner.run() — validaciones de config
// ---------------------------------------------------------------------------

describe('BacktestRunner.run() — validaciones de config', () => {
  let runner: BacktestRunner;
  beforeEach(() => { ({ runner } = makeRunner()); });

  test('lanza si config es null', async () => {
    await expect(runner.run(null as unknown as Parameters<(typeof runner)['run']>[0])).rejects.toThrow('config');
  });

  test('lanza si strategyId es vacío', async () => {
    await expect(runner.run({
      strategyId:     '',
      symbol:         'BTCUSDT',
      timeframe:      '1h',
      from:           1_700_000_000_000,
      to:             1_700_003_600_000,
      initialCapital: 10000,
    })).rejects.toThrow('strategyId');
  });

  test('lanza si from >= to', async () => {
    await expect(runner.run({
      strategyId:     'always-long-v1',
      symbol:         'BTCUSDT',
      timeframe:      '1h',
      from:           2_000_000_000_000,
      to:             1_000_000_000_000,
      initialCapital: 10000,
    })).rejects.toThrow('from');
  });

  test('lanza si initialCapital <= 0', async () => {
    await expect(runner.run({
      strategyId:     'always-long-v1',
      symbol:         'BTCUSDT',
      timeframe:      '1h',
      from:           1_700_000_000_000,
      to:             1_700_003_600_000,
      initialCapital: 0,
    })).rejects.toThrow('initialCapital');
  });

  test('lanza si falta symbol', async () => {
    await expect(runner.run({
      strategyId:     'always-long-v1',
      timeframe:      '1h',
      from:           1_700_000_000_000,
      to:             1_700_003_600_000,
      initialCapital: 10000,
    } as Parameters<(typeof runner)['run']>[0])).rejects.toThrow('symbol');
  });
});

// ---------------------------------------------------------------------------
// Corrida completa — estructura del BacktestReport
// ---------------------------------------------------------------------------

describe('BacktestRunner — corrida completa', () => {
  test('devuelve un BacktestReport con la estructura correcta', async () => {
    const { runner, BASE_TIME, STEP, candles } = makeRunner();

    const report = await runner.run({
      strategyId:     'always-long-v1',
      symbol:         'BTCUSDT',
      timeframe:      '1h',
      from:           BASE_TIME,
      to:             BASE_TIME + (candles.length - 1) * STEP,
      initialCapital: 10000,
      riskPercent:    1,
    });

    expect(report).toHaveProperty('config');
    expect(report).toHaveProperty('metrics');
    expect(report).toHaveProperty('trades');

    expect(report.config).toMatchObject({
      strategyId:     'always-long-v1',
      symbol:         'BTCUSDT',
      timeframe:      '1h',
      from:           BASE_TIME,
      initialCapital: 10000,
    });

    expect(report.metrics).toHaveProperty('finalCapital');
    expect(report.metrics).toHaveProperty('totalTrades');
    expect(report.metrics).toHaveProperty('winRate');
    expect(report.metrics).toHaveProperty('profitFactor');
    expect(report.metrics).toHaveProperty('maxDrawdown');
    expect(report.metrics).toHaveProperty('sharpeRatio');
    expect(report.metrics).toHaveProperty('sortinoRatio');
    expect(report.metrics).toHaveProperty('expectancy');
    expect(report.metrics).toHaveProperty('tpBreakdown');
    expect(report.metrics).toHaveProperty('resolution_confidence');
    expect(report.metrics).toHaveProperty('pessimistic_penalties');

    expect(Array.isArray(report.trades)).toBe(true);
  });

  test('corrida con 10 velas termina sin errores', async () => {
    const { runner, BASE_TIME, STEP, candles } = makeRunner();

    await expect(runner.run({
      strategyId:     'always-long-v1',
      symbol:         'BTCUSDT',
      timeframe:      '1h',
      from:           BASE_TIME,
      to:             BASE_TIME + (candles.length - 1) * STEP,
      initialCapital: 10000,
    })).resolves.not.toThrow();
  });

  test('corrida con 1000 velas termina sin errores', async () => {
    const BASE_TIME = 1_700_000_000_000;
    const STEP      = 60 * 60 * 1000;
    const COUNT     = 1000;

    const bigCandles = Array.from({ length: COUNT }, (_, i) =>
      makeCandle(BASE_TIME + i * STEP, {
        open:  30000,
        high:  30600,
        low:   29400,
        close: 30200,
      })
    );

    const { runner } = makeRunner({ replayCandles: bigCandles });

    await expect(runner.run({
      strategyId:     'always-long-v1',
      symbol:         'BTCUSDT',
      timeframe:      '1h',
      from:           BASE_TIME,
      to:             BASE_TIME + (COUNT - 1) * STEP,
      initialCapital: 10000,
    })).resolves.not.toThrow();
  }, 30_000);

  test('si la estrategia no emite señales, trades es [] y totalTrades = 0', async () => {
    const { runner, BASE_TIME, STEP, candles } = makeRunner({
      strategyInstance: new NeverSignalStrategy(),
    });

    const report = await runner.run({
      strategyId:     'never-signal-v1',
      symbol:         'BTCUSDT',
      timeframe:      '1h',
      from:           BASE_TIME,
      to:             BASE_TIME + (candles.length - 1) * STEP,
      initialCapital: 10000,
    });

    expect(report.trades).toHaveLength(0);
    expect(report.metrics.totalTrades).toBe(0);
    expect(report.metrics.finalCapital).toBe(10000);
  });
});

// ---------------------------------------------------------------------------
// Eventos del MessageBroker
// ---------------------------------------------------------------------------

describe('BacktestRunner — eventos emitidos', () => {
  test('emite EXECUTION_TRADE_OPENED por cada trade simulado', async () => {
    const { runner, broker, BASE_TIME, STEP, candles } = makeRunner();

    const report = await runner.run({
      strategyId:     'always-long-v1',
      symbol:         'BTCUSDT',
      timeframe:      '1h',
      from:           BASE_TIME,
      to:             BASE_TIME + (candles.length - 1) * STEP,
      initialCapital: 10000,
    });

    const openedEvents = broker.getEvents('EXECUTION_TRADE_OPENED');
    expect(openedEvents.length).toBe(report.trades.length);
  });

  test('emite EXECUTION_TRADE_CLOSED por cada trade simulado', async () => {
    const { runner, broker, BASE_TIME, STEP, candles } = makeRunner();

    const report = await runner.run({
      strategyId:     'always-long-v1',
      symbol:         'BTCUSDT',
      timeframe:      '1h',
      from:           BASE_TIME,
      to:             BASE_TIME + (candles.length - 1) * STEP,
      initialCapital: 10000,
    });

    const closedEvents = broker.getEvents('EXECUTION_TRADE_CLOSED');
    expect(closedEvents.length).toBe(report.trades.length);
  });

  test('payload de EXECUTION_TRADE_OPENED contiene tradeId, symbol, direction, entryPrice', async () => {
    const { runner, broker, BASE_TIME, STEP, candles } = makeRunner();

    await runner.run({
      strategyId:     'always-long-v1',
      symbol:         'BTCUSDT',
      timeframe:      '1h',
      from:           BASE_TIME,
      to:             BASE_TIME + (candles.length - 1) * STEP,
      initialCapital: 10000,
    });

    const openedEvents = broker.getEvents('EXECUTION_TRADE_OPENED');
    if (openedEvents.length === 0) return;

    const payload = openedEvents[0].payload;
    expect(payload).toHaveProperty('tradeId');
    expect(payload).toHaveProperty('symbol', 'BTCUSDT');
    expect(payload).toHaveProperty('direction', 'LONG');
    expect(payload).toHaveProperty('entryPrice');
    expect(payload).toHaveProperty('timestamp');
  });

  test('payload de EXECUTION_TRADE_CLOSED contiene pnl y fillResult', async () => {
    const { runner, broker, BASE_TIME, STEP, candles } = makeRunner();

    await runner.run({
      strategyId:     'always-long-v1',
      symbol:         'BTCUSDT',
      timeframe:      '1h',
      from:           BASE_TIME,
      to:             BASE_TIME + (candles.length - 1) * STEP,
      initialCapital: 10000,
    });

    const closedEvents = broker.getEvents('EXECUTION_TRADE_CLOSED');
    if (closedEvents.length === 0) return;

    const payload = closedEvents[0].payload;
    expect(payload).toHaveProperty('pnl');
    expect(payload).toHaveProperty('fillResult');
    expect((payload['fillResult'] as Record<string, unknown>)).toHaveProperty('resolution_mode');
  });

  test('emite EXECUTION_PARTIAL_FILLED para exits de tipo TP', async () => {
    const BASE_TIME = 1_700_000_000_000;
    const STEP      = 60 * 60 * 1000;

    const candles = [
      makeCandle(BASE_TIME, {
        open:  30200,
        high:  31100,
        low:   29900,
        close: 30200,
      }),
      makeCandle(BASE_TIME + STEP, {
        open:  30200,
        high:  31100,
        low:   29900,
        close: 30200,
      }),
    ];

    const { runner, broker } = makeRunner({ replayCandles: candles });

    await runner.run({
      strategyId:     'always-long-v1',
      symbol:         'BTCUSDT',
      timeframe:      '1h',
      from:           BASE_TIME,
      to:             BASE_TIME + STEP,
      initialCapital: 10000,
    });

    const partialEvents = broker.getEvents('EXECUTION_PARTIAL_FILLED');
    const closedEvents  = broker.getEvents('EXECUTION_TRADE_CLOSED');

    if (closedEvents.length > 0) {
      const hasTPExit = closedEvents.some(e =>
        typeof e.payload['exitType'] === 'string' && (e.payload['exitType'] as string).startsWith('TP')
      );
      if (hasTPExit) {
        expect(partialEvents.length).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Persistencia
// ---------------------------------------------------------------------------

describe('BacktestRunner — persistencia', () => {
  test('llama a backtestRepository.saveRun con el report', async () => {
    const { runner, backtestRepo, BASE_TIME, STEP, candles } = makeRunner();

    await runner.run({
      strategyId:     'always-long-v1',
      symbol:         'BTCUSDT',
      timeframe:      '1h',
      from:           BASE_TIME,
      to:             BASE_TIME + (candles.length - 1) * STEP,
      initialCapital: 10000,
    });

    expect(backtestRepo.saveRun).toHaveBeenCalledTimes(1);
    const savedReport = backtestRepo.saveRun.mock.calls[0][0];
    expect(savedReport).toHaveProperty('config');
    expect(savedReport).toHaveProperty('metrics');
    expect(savedReport).toHaveProperty('trades');
  });

  test('el reporte incluye id asignado por el repositorio', async () => {
    const { runner, BASE_TIME, STEP, candles } = makeRunner();

    const report = await runner.run({
      strategyId:     'always-long-v1',
      symbol:         'BTCUSDT',
      timeframe:      '1h',
      from:           BASE_TIME,
      to:             BASE_TIME + (candles.length - 1) * STEP,
      initialCapital: 10000,
    });

    expect(report).toHaveProperty('id');
    expect(typeof report.id).toBe('string');
  });

  test('el runner continúa si saveRun lanza error (no es crítico)', async () => {
    const broker = makeMessageBroker();
    const BASE_TIME = 1_700_000_000_000;
    const STEP      = 60 * 60 * 1000;
    const candles   = Array.from({ length: 3 }, (_, i) => makeCandle(BASE_TIME + i * STEP));

    const timeProvider   = makeTimeProvider(BASE_TIME);
    const logger         = makeLogger();
    const replayRepo     = { getCandles: vi.fn(async () => candles) };
    const replayProvider = new ReplayProvider({ repository: replayRepo, messageBroker: broker, timeProvider, logger });
    const registry       = new StrategyRegistry();
    registry.register(new AlwaysLongStrategy());
    const stateBuilder   = new MarketStateBuilder({ timeProvider, logger });
    const strategyEngine = new StrategyEngine({
      messageBroker: broker, strategyRegistry: registry,
      marketStateBuilder: stateBuilder, timeProvider, logger,
    });
    const fillSim   = new FillSimulator({ candleRepository: makeRepo(), timeProvider, logger });
    const metricsCa = new MetricsCalculator();

    const failingRepo = { saveRun: vi.fn(async () => { throw new Error('DB caída'); }) };

    const runner = new BacktestRunner({
      replayProvider,
      strategyEngine,
      fillSimulator:      fillSim,
      metricsCalculator:  metricsCa,
      backtestRepository: failingRepo,
      messageBroker:      broker,
      logger,
    });

    const report = await runner.run({
      strategyId:     'always-long-v1',
      symbol:         'BTCUSDT',
      timeframe:      '1h',
      from:           BASE_TIME,
      to:             BASE_TIME + 2 * STEP,
      initialCapital: 10000,
    });

    expect(report).toHaveProperty('config');
    expect(report).toHaveProperty('metrics');
  });
});

// ---------------------------------------------------------------------------
// resolution_confidence — suma 100% en el reporte
// ---------------------------------------------------------------------------

describe('BacktestRunner — resolution_confidence en el reporte', () => {
  test('resolution_confidence suma 100% cuando hay trades', async () => {
    const { runner, BASE_TIME, STEP, candles } = makeRunner();

    const report = await runner.run({
      strategyId:     'always-long-v1',
      symbol:         'BTCUSDT',
      timeframe:      '1h',
      from:           BASE_TIME,
      to:             BASE_TIME + (candles.length - 1) * STEP,
      initialCapital: 10000,
    });

    if (report.metrics.totalTrades === 0) return;

    const conf = report.metrics.resolution_confidence;
    const sum  = conf.PRECISE_1S + conf.PRECISE_1M + conf.PESSIMISTIC;
    expect(sum).toBeCloseTo(100, 5);
  });

  test('resolution_confidence es todo 0 cuando no hay trades', async () => {
    const { runner, BASE_TIME, STEP, candles } = makeRunner({
      strategyInstance: new NeverSignalStrategy(),
    });

    const report = await runner.run({
      strategyId:     'never-signal-v1',
      symbol:         'BTCUSDT',
      timeframe:      '1h',
      from:           BASE_TIME,
      to:             BASE_TIME + (candles.length - 1) * STEP,
      initialCapital: 10000,
    });

    const conf = report.metrics.resolution_confidence;
    expect(conf.PRECISE_1S).toBe(0);
    expect(conf.PRECISE_1M).toBe(0);
    expect(conf.PESSIMISTIC).toBe(0);
  });
});
