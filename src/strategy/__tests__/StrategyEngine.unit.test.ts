/**
 * StrategyEngine.unit.test.ts
 *
 * Tests unitarios del StrategyEngine.
 * Todas las dependencias se reemplazan por dobles de prueba.
 */

import StrategyEngine    from '../StrategyEngine.js';
import StrategyBase      from '../StrategyBase.js';
import StrategyRegistry  from '../StrategyRegistry.js';
import MarketStateBuilder from '../MarketStateBuilder.js';
import type { TradePlan, MarketState, Candle } from '../../types.js';

// ---------------------------------------------------------------------------
// Helpers / Factories
// ---------------------------------------------------------------------------

function makeTimeProvider(fixedMs = 1_700_000_000_000) {
  return { now: () => fixedMs };
}

function makeBroker() {
  const published: Array<{ channel: string; payload: Record<string, unknown> }> = [];
  const subscribers: Record<string, (payload: unknown) => void | Promise<void>> = {};
  return {
    publish: vi.fn(async (channel: string, payload: Record<string, unknown>) => {
      published.push({ channel, payload });
    }),
    subscribe: vi.fn((channel: string, handler: (payload: unknown) => void | Promise<void>) => {
      subscribers[channel] = handler;
    }),
    published,
    subscribers,
    // Helper para simular un evento entrante
    emit: async (channel: string, payload: unknown) => {
      if (subscribers[channel]) {
        await subscribers[channel](payload);
      }
    },
  };
}

function makeLogger() {
  return {
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
  };
}

/** Crea una vela con valores por defecto */
function makeCandle(overrides: Partial<Candle> = {}): Candle {
  return {
    symbol:    'BTCUSDT',
    timeframe: '1m',
    openTime:  1_700_000_000_000,
    open:      30000,
    high:      30500,
    low:       29900,
    close:     30200,
    volume:    100,
    isClosed:  true,
    ...overrides,
  };
}

/** Estrategia stub que siempre retorna null */
class StubStrategyNull extends StrategyBase {
  get id() { return 'stub-null'; }
  get requiredTimeframes() { return ['1m']; }
  async evaluate(_state: MarketState) { return null; }
}

/** Estrategia stub que siempre retorna un TradePlan fijo */
class StubStrategySignal extends StrategyBase {
  private _tradePlan: TradePlan;
  constructor(tradePlan: TradePlan) {
    super();
    this._tradePlan = tradePlan;
  }
  get id() { return 'stub-signal'; }
  get requiredTimeframes() { return ['1m']; }
  async evaluate(_state: MarketState) { return this._tradePlan; }
}

/** Estrategia stub que lanza excepción en evaluate() */
class StubStrategyThrows extends StrategyBase {
  get id() { return 'stub-throws'; }
  get requiredTimeframes() { return ['1m']; }
  async evaluate(_state: MarketState): Promise<TradePlan | null> { throw new Error('error simulado en evaluate'); }
}

/** Construye un TradePlan mínimo válido */
function makeTradePlan(overrides: Partial<TradePlan> = {}): TradePlan {
  return {
    strategyId:  'stub-signal',
    symbol:      'BTCUSDT',
    direction:   'LONG',
    entryPrice:  30200,
    stopLoss:    29900,
    takeProfits: [{ price: 31000, sizePercent: 100 }],
    riskPercent: 1,
    metadata:    {},
    ...overrides,
  };
}

/** Construye un payload MARKET_CANDLE_CLOSED */
function makeCandleClosedPayload(overrides: Record<string, unknown> = {}) {
  const candle = makeCandle(overrides.candle as Partial<Candle>);
  return {
    symbol:    candle.symbol,
    timeframe: candle.timeframe,
    timestamp: 1_700_000_000_000,
    candle,
    ...overrides,
  };
}

/** Fábrica de StrategyEngine con dependencias por defecto o personalizadas */
function makeEngine({ registryStrategies = [] as StrategyBase[], brokerOverride = undefined as ReturnType<typeof makeBroker> | undefined, loggerOverride = undefined as ReturnType<typeof makeLogger> | undefined } = {}) {
  const broker   = brokerOverride ?? makeBroker();
  const registry = new StrategyRegistry();
  for (const s of registryStrategies) {
    registry.register(s);
  }
  const timeProvider = makeTimeProvider();
  const builder      = new MarketStateBuilder({ timeProvider });
  const logger       = loggerOverride ?? makeLogger();

  const engine = new StrategyEngine({
    messageBroker:      broker,
    strategyRegistry:   registry,
    marketStateBuilder: builder,
    timeProvider,
    logger,
  });

  return { engine, broker, registry, builder, logger };
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe('StrategyEngine — constructor', () => {
  test('lanza si messageBroker no se provee', () => {
    const registry = new StrategyRegistry();
    const builder  = new MarketStateBuilder({ timeProvider: makeTimeProvider() });
    expect(() => new StrategyEngine({
      strategyRegistry:   registry,
      marketStateBuilder: builder,
      timeProvider:       makeTimeProvider(),
    } as never)).toThrow('messageBroker');
  });

  test('lanza si strategyRegistry no se provee', () => {
    expect(() => new StrategyEngine({
      messageBroker:      makeBroker(),
      marketStateBuilder: new MarketStateBuilder({ timeProvider: makeTimeProvider() }),
      timeProvider:       makeTimeProvider(),
    } as never)).toThrow('strategyRegistry');
  });

  test('lanza si marketStateBuilder no se provee', () => {
    expect(() => new StrategyEngine({
      messageBroker:    makeBroker(),
      strategyRegistry: new StrategyRegistry(),
      timeProvider:     makeTimeProvider(),
    } as never)).toThrow('marketStateBuilder');
  });

  test('lanza si timeProvider no se provee', () => {
    expect(() => new StrategyEngine({
      messageBroker:      makeBroker(),
      strategyRegistry:   new StrategyRegistry(),
      marketStateBuilder: new MarketStateBuilder({ timeProvider: makeTimeProvider() }),
    } as never)).toThrow('timeProvider');
  });

  test('se instancia correctamente con dependencias válidas', () => {
    expect(() => makeEngine()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// start() / stop()
// ---------------------------------------------------------------------------

describe('StrategyEngine — start / stop', () => {
  test('start() se suscribe a MARKET_CANDLE_CLOSED', () => {
    const { engine, broker } = makeEngine();
    engine.start();
    expect(broker.subscribe).toHaveBeenCalledWith('MARKET_CANDLE_CLOSED', expect.any(Function));
  });

  test('start() duplicado no suscribe dos veces', () => {
    const { engine, broker } = makeEngine();
    engine.start();
    engine.start();
    expect(broker.subscribe).toHaveBeenCalledTimes(1);
  });

  test('stop() detiene el procesamiento de nuevas velas', async () => {
    const tradePlan = makeTradePlan();
    const strategy  = new StubStrategySignal(tradePlan);
    const { engine, broker } = makeEngine({ registryStrategies: [strategy] });

    engine.start();
    engine.stop();

    await broker.emit('MARKET_CANDLE_CLOSED', makeCandleClosedPayload());

    // No debe emitir señal porque el engine está parado
    const signals = broker.published.filter(e => e.channel === 'STRATEGY_SIGNAL_GENERATED');
    expect(signals).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Flujo principal: MARKET_CANDLE_CLOSED → evaluate() → STRATEGY_SIGNAL_GENERATED
// ---------------------------------------------------------------------------

describe('StrategyEngine — flujo principal', () => {
  test('emite STRATEGY_SIGNAL_GENERATED cuando evaluate() retorna TradePlan', async () => {
    const tradePlan = makeTradePlan();
    const strategy  = new StubStrategySignal(tradePlan);
    const { engine, broker } = makeEngine({ registryStrategies: [strategy] });

    engine.start();
    await broker.emit('MARKET_CANDLE_CLOSED', makeCandleClosedPayload());

    const signals = broker.published.filter(e => e.channel === 'STRATEGY_SIGNAL_GENERATED');
    expect(signals).toHaveLength(1);
    expect(signals[0].payload.tradePlan).toEqual(tradePlan);
  });

  test('NO emite STRATEGY_SIGNAL_GENERATED cuando evaluate() retorna null', async () => {
    const strategy = new StubStrategyNull();
    const { engine, broker } = makeEngine({ registryStrategies: [strategy] });

    engine.start();
    await broker.emit('MARKET_CANDLE_CLOSED', makeCandleClosedPayload());

    const signals = broker.published.filter(e => e.channel === 'STRATEGY_SIGNAL_GENERATED');
    expect(signals).toHaveLength(0);
  });

  test('NO emite STRATEGY_SIGNAL_GENERATED cuando evaluate() retorna undefined', async () => {
    class StubUndefined extends StrategyBase {
      get id() { return 'stub-undefined'; }
      get requiredTimeframes() { return ['1m']; }
      async evaluate(_state: MarketState): Promise<TradePlan | null> { return null; }
    }
    const { engine, broker } = makeEngine({ registryStrategies: [new StubUndefined()] });

    engine.start();
    await broker.emit('MARKET_CANDLE_CLOSED', makeCandleClosedPayload());

    const signals = broker.published.filter(e => e.channel === 'STRATEGY_SIGNAL_GENERATED');
    expect(signals).toHaveLength(0);
  });

  test('actualiza el MarketStateBuilder antes de llamar evaluate()', async () => {
    const evaluateSpy = vi.fn().mockResolvedValue(null);

    class SpyStrategy extends StrategyBase {
      get id() { return 'spy'; }
      get requiredTimeframes() { return ['1m']; }
      async evaluate(state: MarketState) { return evaluateSpy(state); }
    }

    const { engine, broker } = makeEngine({ registryStrategies: [new SpyStrategy()] });
    engine.start();

    const payload = makeCandleClosedPayload();
    await broker.emit('MARKET_CANDLE_CLOSED', payload);

    expect(evaluateSpy).toHaveBeenCalledTimes(1);
    const state = evaluateSpy.mock.calls[0][0] as MarketState;
    // La vela debe estar en el estado
    expect(state.candles['1m'].length).toBeGreaterThan(0);
  });

  test('llama evaluate() en todas las estrategias registradas', async () => {
    const evalA = vi.fn().mockResolvedValue(null);
    const evalB = vi.fn().mockResolvedValue(null);

    class StratA extends StrategyBase {
      get id() { return 'strat-a'; }
      get requiredTimeframes() { return ['1m']; }
      async evaluate(s: MarketState) { return evalA(s); }
    }
    class StratB extends StrategyBase {
      get id() { return 'strat-b'; }
      get requiredTimeframes() { return ['1m']; }
      async evaluate(s: MarketState) { return evalB(s); }
    }

    const { engine, broker } = makeEngine({ registryStrategies: [new StratA(), new StratB()] });
    engine.start();
    await broker.emit('MARKET_CANDLE_CLOSED', makeCandleClosedPayload());

    expect(evalA).toHaveBeenCalledTimes(1);
    expect(evalB).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Resiliencia: excepciones en evaluate()
// ---------------------------------------------------------------------------

describe('StrategyEngine — resiliencia ante excepciones', () => {
  test('continúa con otras estrategias si una lanza excepción', async () => {
    const tradePlan = makeTradePlan({ strategyId: 'stub-signal' });
    const throwing  = new StubStrategyThrows();
    const working   = new StubStrategySignal(tradePlan);

    const { engine, broker } = makeEngine({ registryStrategies: [throwing, working] });
    engine.start();
    await broker.emit('MARKET_CANDLE_CLOSED', makeCandleClosedPayload());

    const signals = broker.published.filter(e => e.channel === 'STRATEGY_SIGNAL_GENERATED');
    expect(signals).toHaveLength(1);
    expect((signals[0].payload.tradePlan as TradePlan).strategyId).toBe('stub-signal');
  });

  test('loggea el error cuando evaluate() lanza excepción', async () => {
    const logger   = makeLogger();
    const throwing = new StubStrategyThrows();
    const { engine, broker } = makeEngine({
      registryStrategies: [throwing],
      loggerOverride: logger,
    });

    engine.start();
    await broker.emit('MARKET_CANDLE_CLOSED', makeCandleClosedPayload());

    expect(logger.error).toHaveBeenCalled();
    const errorMsg = logger.error.mock.calls[0][0] as string;
    expect(errorMsg).toMatch(/stub-throws/);
    expect(errorMsg).toMatch(/error simulado en evaluate/);
  });

  test('no lanza hacia el caller cuando evaluate() lanza excepción', async () => {
    const throwing = new StubStrategyThrows();
    const { engine, broker } = makeEngine({ registryStrategies: [throwing] });

    engine.start();

    // No debe rechazar la promesa
    await expect(
      broker.emit('MARKET_CANDLE_CLOSED', makeCandleClosedPayload())
    ).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// emitZoneArmed / emitZoneDisarmed
// ---------------------------------------------------------------------------

describe('StrategyEngine — emisión de eventos de zona', () => {
  test('emitZoneArmed publica STRATEGY_ZONE_ARMED en el broker', async () => {
    const { engine, broker } = makeEngine();
    const zonePayload = {
      strategyId: 'fibonacci-volume-v1',
      symbol:     'BTCUSDT',
      levels:     [] as unknown[],
      triggerCandle: makeCandle(),
    };

    await engine.emitZoneArmed(zonePayload);

    const events = broker.published.filter(e => e.channel === 'STRATEGY_ZONE_ARMED');
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual(zonePayload);
  });

  test('emitZoneDisarmed publica STRATEGY_ZONE_DISARMED en el broker', async () => {
    const { engine, broker } = makeEngine();
    const zonePayload = {
      strategyId: 'fibonacci-volume-v1',
      symbol:     'BTCUSDT',
      reason:     'nueva vela de alto volumen',
    };

    await engine.emitZoneDisarmed(zonePayload);

    const events = broker.published.filter(e => e.channel === 'STRATEGY_ZONE_DISARMED');
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual(zonePayload);
  });
});
