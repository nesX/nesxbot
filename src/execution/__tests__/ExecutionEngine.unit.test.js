/**
 * ExecutionEngine.unit.test.js
 *
 * Tests unitarios del ExecutionEngine.
 * Todas las dependencias se reemplazan por dobles de prueba.
 *
 * Casos cubiertos:
 *   - Señal válida → EXECUTION_TRADE_OPENED
 *   - Señal rechazada por ExposureManager → EXECUTION_SIGNAL_REJECTED
 *   - TradePlan con TPs desordenados → EXECUTION_SIGNAL_REJECTED con mensaje descriptivo
 *   - TP parcial → EXECUTION_PARTIAL_FILLED + posición parcialmente cerrada
 *   - SL tocado → EXECUTION_TRADE_CLOSED con exitType: 'SL'
 *   - DryRunAdapter simula fills con precio del mercado
 *   - BrokerAdapter.placeOrder falla irrecuperablemente → SYSTEM_CRITICAL_ERROR
 */

import ExecutionEngine  from '../ExecutionEngine.js';
import DryRunAdapter    from '../DryRunAdapter.js';
import ExposureManager  from '../ExposureManager.js';
import OrderManager     from '../OrderManager.js';

// ---------------------------------------------------------------------------
// Helpers / Factories
// ---------------------------------------------------------------------------

const FIXED_TS = 1_700_000_000_000;

function makeTimeProvider(fixedMs = FIXED_TS) {
  return { now: () => fixedMs };
}

function makeBroker() {
  const published   = [];
  const subscribers = {};

  return {
    publish: vi.fn(async (channel, payload) => {
      published.push({ channel, payload });
    }),
    subscribe: vi.fn((channel, handler) => {
      subscribers[channel] = handler;
    }),
    published,
    subscribers,
    // Simula un evento entrante
    emit: async (channel, payload) => {
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

/** TradePlan mínimo válido — LONG */
function makeTradePlan(overrides = {}) {
  return {
    strategyId:  'strat-a',
    symbol:      'BTCUSDT',
    direction:   'LONG',
    entryPrice:  30_000,
    stopLoss:    29_700,
    takeProfits: [
      { price: 30_600, sizePercent: 50 },
      { price: 31_200, sizePercent: 50 },
    ],
    riskPercent: 1,
    metadata:    {},
    ...overrides,
  };
}

/** Construye el conjunto completo de dependencias y el ExecutionEngine */
function makeEngine(opts = {}) {
  const timeProvider = opts.timeProvider || makeTimeProvider();
  const broker       = opts.broker       || makeBroker();
  const logger       = opts.logger       || makeLogger();

  // BrokerAdapter: usa DryRunAdapter por defecto (más realista)
  const adapter = opts.adapter || new DryRunAdapter({
    slippagePercent: 0,    // 0% slippage para simplificar los cálculos en tests
    initialBalance:  10_000,
    timeProvider,
  });

  // Registrar un precio inicial para que las órdenes MARKET no fallen
  if (adapter.updateMarketPrice) {
    adapter.updateMarketPrice('BTCUSDT', 30_000);
  }

  const exposureManager = opts.exposureManager || new ExposureManager({
    brokerAdapter: adapter,
    config: {
      maxRiskPerTradePercent:  2,
      maxOpenTrades:           5,
      maxRiskPerSymbolPercent: 10,
      maxTotalRiskPercent:     20,
    },
    logger,
  });

  const orderManager = opts.orderManager || new OrderManager({
    brokerAdapter: adapter,
    timeProvider,
    logger,
  });

  const engine = new ExecutionEngine({
    messageBroker:   broker,
    timeProvider,
    brokerAdapter:   adapter,
    exposureManager,
    orderManager,
    logger,
  });

  return { engine, broker, adapter, exposureManager, orderManager, logger, timeProvider };
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe('ExecutionEngine — constructor', () => {
  test('lanza si messageBroker no se provee', () => {
    expect(() => new ExecutionEngine({
      timeProvider:    makeTimeProvider(),
      brokerAdapter:   new DryRunAdapter(),
      exposureManager: { canExecute: vi.fn(), calculateSize: vi.fn() },
      orderManager:    { openPosition: vi.fn() },
    })).toThrow('messageBroker');
  });

  test('lanza si timeProvider no se provee', () => {
    expect(() => new ExecutionEngine({
      messageBroker:   makeBroker(),
      brokerAdapter:   new DryRunAdapter(),
      exposureManager: { canExecute: vi.fn(), calculateSize: vi.fn() },
      orderManager:    { openPosition: vi.fn() },
    })).toThrow('timeProvider');
  });

  test('lanza si brokerAdapter no se provee', () => {
    expect(() => new ExecutionEngine({
      messageBroker:   makeBroker(),
      timeProvider:    makeTimeProvider(),
      exposureManager: { canExecute: vi.fn(), calculateSize: vi.fn() },
      orderManager:    { openPosition: vi.fn() },
    })).toThrow('brokerAdapter');
  });

  test('lanza si exposureManager no se provee', () => {
    expect(() => new ExecutionEngine({
      messageBroker:   makeBroker(),
      timeProvider:    makeTimeProvider(),
      brokerAdapter:   new DryRunAdapter(),
      orderManager:    { openPosition: vi.fn() },
    })).toThrow('exposureManager');
  });

  test('lanza si orderManager no se provee', () => {
    expect(() => new ExecutionEngine({
      messageBroker:   makeBroker(),
      timeProvider:    makeTimeProvider(),
      brokerAdapter:   new DryRunAdapter(),
      exposureManager: { canExecute: vi.fn(), calculateSize: vi.fn() },
    })).toThrow('orderManager');
  });

  test('se instancia correctamente con todas las dependencias', () => {
    expect(() => makeEngine()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// start / stop
// ---------------------------------------------------------------------------

describe('ExecutionEngine — start / stop', () => {
  test('start() se suscribe a STRATEGY_SIGNAL_GENERATED y MARKET_CANDLE_CLOSED', async () => {
    const { engine, broker } = makeEngine();
    await engine.start();

    expect(broker.subscribe).toHaveBeenCalledWith('STRATEGY_SIGNAL_GENERATED', expect.any(Function));
    expect(broker.subscribe).toHaveBeenCalledWith('MARKET_CANDLE_CLOSED', expect.any(Function));
  });

  test('start() duplicado no suscribe dos veces', async () => {
    const { engine, broker } = makeEngine();
    await engine.start();
    await engine.start();

    expect(broker.subscribe).toHaveBeenCalledTimes(2); // 1 por cada evento, una sola vez
  });

  test('stop() hace que las nuevas señales sean ignoradas', async () => {
    const { engine, broker } = makeEngine();
    await engine.start();
    await engine.stop();

    await broker.emit('STRATEGY_SIGNAL_GENERATED', { tradePlan: makeTradePlan() });

    const opened = broker.published.filter(e => e.channel === 'EXECUTION_TRADE_OPENED');
    expect(opened).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Flujo principal: señal válida → EXECUTION_TRADE_OPENED
// ---------------------------------------------------------------------------

describe('ExecutionEngine — señal válida abre trade', () => {
  test('emite EXECUTION_TRADE_OPENED con los datos correctos', async () => {
    const { engine, broker } = makeEngine();
    await engine.start();

    await broker.emit('STRATEGY_SIGNAL_GENERATED', { tradePlan: makeTradePlan() });

    const events = broker.published.filter(e => e.channel === 'EXECUTION_TRADE_OPENED');
    expect(events).toHaveLength(1);

    const payload = events[0].payload;
    expect(payload.symbol).toBe('BTCUSDT');
    expect(payload.direction).toBe('LONG');
    expect(payload.stopLoss).toBe(29_700);
    expect(payload.takeProfits).toHaveLength(2);
    expect(payload.tradeId).toBeDefined();
    expect(payload.timestamp).toBe(FIXED_TS);
  });

  test('NO emite EXECUTION_SIGNAL_REJECTED cuando la señal es válida', async () => {
    const { engine, broker } = makeEngine();
    await engine.start();

    await broker.emit('STRATEGY_SIGNAL_GENERATED', { tradePlan: makeTradePlan() });

    const rejected = broker.published.filter(e => e.channel === 'EXECUTION_SIGNAL_REJECTED');
    expect(rejected).toHaveLength(0);
  });

  test('registra el trade en ExposureManager tras abrirlo', async () => {
    const { engine, broker, exposureManager } = makeEngine();
    await engine.start();

    await broker.emit('STRATEGY_SIGNAL_GENERATED', { tradePlan: makeTradePlan() });

    const exposure = await exposureManager.getCurrentExposure();
    expect(exposure.openTrades).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Señal rechazada por riesgo → EXECUTION_SIGNAL_REJECTED
// ---------------------------------------------------------------------------

describe('ExecutionEngine — señal rechazada por ExposureManager', () => {
  test('emite EXECUTION_SIGNAL_REJECTED cuando la exposición máxima está alcanzada', async () => {
    // Configurar ExposureManager con solo 1 trade máximo
    const timeProvider = makeTimeProvider();
    const adapter      = new DryRunAdapter({ slippagePercent: 0, timeProvider });
    adapter.updateMarketPrice('BTCUSDT', 30_000);

    const exposure = new ExposureManager({
      brokerAdapter: adapter,
      config: { maxOpenTrades: 1, maxRiskPerTradePercent: 2, maxRiskPerSymbolPercent: 10, maxTotalRiskPercent: 20 },
    });

    const orderMgr = new OrderManager({ brokerAdapter: adapter, timeProvider });
    const broker   = makeBroker();

    const engine = new ExecutionEngine({
      messageBroker:   broker,
      timeProvider,
      brokerAdapter:   adapter,
      exposureManager: exposure,
      orderManager:    orderMgr,
    });

    await engine.start();

    // Primer trade — debe abrirse
    await broker.emit('STRATEGY_SIGNAL_GENERATED', { tradePlan: makeTradePlan() });
    // Segundo trade — debe ser rechazado (maxOpenTrades: 1)
    await broker.emit('STRATEGY_SIGNAL_GENERATED', { tradePlan: makeTradePlan({ strategyId: 'strat-b' }) });

    const rejected = broker.published.filter(e => e.channel === 'EXECUTION_SIGNAL_REJECTED');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].payload.reason).toMatch(/máximo/i);
  });

  test('el payload de EXECUTION_SIGNAL_REJECTED incluye strategyId, symbol, reason, timestamp', async () => {
    const timeProvider = makeTimeProvider();
    const adapter      = new DryRunAdapter({ slippagePercent: 0, timeProvider });
    adapter.updateMarketPrice('BTCUSDT', 30_000);

    const exposure = new ExposureManager({
      brokerAdapter: adapter,
      config: { maxOpenTrades: 0 }, // ningún trade permitido
    });

    const broker = makeBroker();
    const engine = new ExecutionEngine({
      messageBroker:   broker,
      timeProvider,
      brokerAdapter:   adapter,
      exposureManager: exposure,
      orderManager:    new OrderManager({ brokerAdapter: adapter, timeProvider }),
    });

    await engine.start();
    const plan = makeTradePlan({ strategyId: 'fib-v1', symbol: 'ETHUSDT' });
    // Actualizar precio para ETHUSDT también
    adapter.updateMarketPrice('ETHUSDT', 2_000);
    await broker.emit('STRATEGY_SIGNAL_GENERATED', { tradePlan: plan });

    const rejected = broker.published.filter(e => e.channel === 'EXECUTION_SIGNAL_REJECTED');
    expect(rejected[0].payload).toMatchObject({
      strategyId: 'fib-v1',
      symbol:     'ETHUSDT',
      timestamp:  FIXED_TS,
    });
    expect(rejected[0].payload.reason).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// TradePlan con TPs desordenados → EXECUTION_SIGNAL_REJECTED descriptivo
// ---------------------------------------------------------------------------

describe('ExecutionEngine — TPs desordenados', () => {
  test('rechaza LONG con TPs descendentes y describe el error', async () => {
    const { engine, broker } = makeEngine();
    await engine.start();

    const plan = makeTradePlan({
      direction:   'LONG',
      takeProfits: [
        { price: 31_200, sizePercent: 50 },
        { price: 30_600, sizePercent: 50 }, // desordenado
      ],
    });

    await broker.emit('STRATEGY_SIGNAL_GENERATED', { tradePlan: plan });

    const rejected = broker.published.filter(e => e.channel === 'EXECUTION_SIGNAL_REJECTED');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].payload.reason).toMatch(/LONG/);
    expect(rejected[0].payload.reason).toMatch(/desordenados/i);
  });

  test('rechaza SHORT con TPs ascendentes y describe el error', async () => {
    const { engine, broker } = makeEngine();
    await engine.start();

    const plan = makeTradePlan({
      direction:   'SHORT',
      entryPrice:  30_000,
      stopLoss:    30_300,
      takeProfits: [
        { price: 29_400, sizePercent: 50 },
        { price: 29_700, sizePercent: 50 }, // desordenado para SHORT
      ],
    });

    await broker.emit('STRATEGY_SIGNAL_GENERATED', { tradePlan: plan });

    const rejected = broker.published.filter(e => e.channel === 'EXECUTION_SIGNAL_REJECTED');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].payload.reason).toMatch(/SHORT/);
  });

  test('no emite EXECUTION_TRADE_OPENED cuando hay TPs desordenados', async () => {
    const { engine, broker } = makeEngine();
    await engine.start();

    await broker.emit('STRATEGY_SIGNAL_GENERATED', {
      tradePlan: makeTradePlan({
        takeProfits: [
          { price: 31_200, sizePercent: 50 },
          { price: 30_600, sizePercent: 50 },
        ],
      }),
    });

    const opened = broker.published.filter(e => e.channel === 'EXECUTION_TRADE_OPENED');
    expect(opened).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// DryRunAdapter — fills simulados
// ---------------------------------------------------------------------------

describe('ExecutionEngine + DryRunAdapter — fills simulados', () => {
  test('SL tocado emite EXECUTION_TRADE_CLOSED con exitType SL', async () => {
    const { engine, broker, adapter } = makeEngine();
    await engine.start();

    // Abrir trade
    await broker.emit('STRATEGY_SIGNAL_GENERATED', { tradePlan: makeTradePlan() });

    // Simular que el precio baja hasta el SL (29_700)
    await broker.emit('MARKET_CANDLE_CLOSED', {
      symbol: 'BTCUSDT',
      candle: { close: 29_700, high: 30_000, low: 29_600 },
    });

    const closed = broker.published.filter(e => e.channel === 'EXECUTION_TRADE_CLOSED');
    expect(closed).toHaveLength(1);
    expect(closed[0].payload.exitType).toBe('SL');
    expect(closed[0].payload.tradeId).toBeDefined();
  });

  test('TP1 tocado emite EXECUTION_PARTIAL_FILLED', async () => {
    const { engine, broker } = makeEngine();
    await engine.start();

    await broker.emit('STRATEGY_SIGNAL_GENERATED', { tradePlan: makeTradePlan() });

    // Precio sube hasta TP1 (30_600)
    await broker.emit('MARKET_CANDLE_CLOSED', {
      symbol: 'BTCUSDT',
      candle: { close: 30_600, high: 30_700, low: 30_500 },
    });

    const partial = broker.published.filter(e => e.channel === 'EXECUTION_PARTIAL_FILLED');
    expect(partial).toHaveLength(1);
    expect(partial[0].payload.tpLevel).toBe(1);
    expect(partial[0].payload.remainingSize).toBeGreaterThan(0);
  });

  test('TP2 tocado tras TP1 cierra el trade con EXECUTION_TRADE_CLOSED', async () => {
    const { engine, broker } = makeEngine();
    await engine.start();

    await broker.emit('STRATEGY_SIGNAL_GENERATED', { tradePlan: makeTradePlan() });

    // TP1 (30_600)
    await broker.emit('MARKET_CANDLE_CLOSED', {
      symbol: 'BTCUSDT',
      candle: { close: 30_600, high: 30_700, low: 30_500 },
    });

    // TP2 (31_200)
    await broker.emit('MARKET_CANDLE_CLOSED', {
      symbol: 'BTCUSDT',
      candle: { close: 31_200, high: 31_300, low: 31_100 },
    });

    const closed = broker.published.filter(e => e.channel === 'EXECUTION_TRADE_CLOSED');
    expect(closed).toHaveLength(1);
    expect(closed[0].payload.exitType).toBe('TP');
  });

  test('después de cerrar por SL, el trade se elimina de ExposureManager', async () => {
    const { engine, broker, exposureManager } = makeEngine();
    await engine.start();

    await broker.emit('STRATEGY_SIGNAL_GENERATED', { tradePlan: makeTradePlan() });

    // Verificar que el trade está registrado
    let exp = await exposureManager.getCurrentExposure();
    expect(exp.openTrades).toBe(1);

    // SL tocado
    await broker.emit('MARKET_CANDLE_CLOSED', {
      symbol: 'BTCUSDT',
      candle: { close: 29_700, high: 30_000, low: 29_600 },
    });

    exp = await exposureManager.getCurrentExposure();
    expect(exp.openTrades).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SYSTEM_CRITICAL_ERROR cuando el broker falla irrecuperablemente
// ---------------------------------------------------------------------------

describe('ExecutionEngine — errores críticos del broker', () => {
  test('emite SYSTEM_CRITICAL_ERROR cuando placeOrder falla con error no recuperable', async () => {
    const timeProvider = makeTimeProvider();
    const broker       = makeBroker();

    // Adapter que siempre falla con error de lógica (no recuperable)
    const badAdapter = {
      placeOrder:          vi.fn(async () => { throw new Error('insufficient balance'); }),
      cancelOrder:         vi.fn(),
      getOpenOrders:       vi.fn(async () => []),
      getBalance:          vi.fn(async () => ({ available: 10_000, total: 10_000 })),
      updateMarketPrice:   vi.fn(() => ({ filled: [] })),
    };

    const exposure = new ExposureManager({
      brokerAdapter: badAdapter,
      config: { maxRiskPerTradePercent: 2, maxOpenTrades: 5, maxRiskPerSymbolPercent: 10, maxTotalRiskPercent: 20 },
    });

    const orderMgr = new OrderManager({ brokerAdapter: badAdapter, timeProvider });

    const engine = new ExecutionEngine({
      messageBroker:   broker,
      timeProvider,
      brokerAdapter:   badAdapter,
      exposureManager: exposure,
      orderManager:    orderMgr,
    });

    await engine.start();
    await broker.emit('STRATEGY_SIGNAL_GENERATED', { tradePlan: makeTradePlan() });

    const critical = broker.published.filter(e => e.channel === 'SYSTEM_CRITICAL_ERROR');
    expect(critical).toHaveLength(1);
    expect(critical[0].payload.source).toBe('ExecutionEngine');
    expect(critical[0].payload.recoverable).toBe(false);
  });

  test('NO emite SYSTEM_CRITICAL_ERROR para errores recuperables (timeout)', async () => {
    const timeProvider = makeTimeProvider();
    const broker       = makeBroker();

    const recoverableAdapter = {
      placeOrder:    vi.fn(async () => { throw new Error('timeout connecting to exchange'); }),
      cancelOrder:   vi.fn(),
      getOpenOrders: vi.fn(async () => []),
      getBalance:    vi.fn(async () => ({ available: 10_000, total: 10_000 })),
      updateMarketPrice: vi.fn(() => ({ filled: [] })),
    };

    const exposure = new ExposureManager({
      brokerAdapter: recoverableAdapter,
      config: { maxRiskPerTradePercent: 2, maxOpenTrades: 5, maxRiskPerSymbolPercent: 10, maxTotalRiskPercent: 20 },
    });

    const engine = new ExecutionEngine({
      messageBroker:   broker,
      timeProvider,
      brokerAdapter:   recoverableAdapter,
      exposureManager: exposure,
      orderManager:    new OrderManager({ brokerAdapter: recoverableAdapter, timeProvider }),
    });

    await engine.start();
    await broker.emit('STRATEGY_SIGNAL_GENERATED', { tradePlan: makeTradePlan() });

    const critical = broker.published.filter(e => e.channel === 'SYSTEM_CRITICAL_ERROR');
    expect(critical).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// moveSL público
// ---------------------------------------------------------------------------

describe('ExecutionEngine.moveSL', () => {
  test('emite EXECUTION_SL_MOVED con oldSL, newSL y reason', async () => {
    const { engine, broker } = makeEngine();
    await engine.start();

    // Abrir trade
    await broker.emit('STRATEGY_SIGNAL_GENERATED', { tradePlan: makeTradePlan() });

    const opened  = broker.published.find(e => e.channel === 'EXECUTION_TRADE_OPENED');
    const tradeId = opened.payload.tradeId;

    // Mover SL a breakeven
    await engine.moveSL(tradeId, 30_000, 'breakeven');

    const slMoved = broker.published.filter(e => e.channel === 'EXECUTION_SL_MOVED');
    expect(slMoved).toHaveLength(1);

    const payload = slMoved[0].payload;
    expect(payload.tradeId).toBe(tradeId);
    expect(payload.oldSL).toBe(29_700);
    expect(payload.newSL).toBe(30_000);
    expect(payload.reason).toBe('breakeven');
    expect(payload.timestamp).toBeDefined();
  });

  test('no lanza si el tradeId no existe', async () => {
    const { engine, broker } = makeEngine();
    await engine.start();

    await expect(engine.moveSL('trade-no-existe', 30_000, 'trailing')).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Resiliencia
// ---------------------------------------------------------------------------

describe('ExecutionEngine — resiliencia', () => {
  test('ignora eventos sin tradePlan sin lanzar', async () => {
    const { engine, broker } = makeEngine();
    await engine.start();

    await expect(
      broker.emit('STRATEGY_SIGNAL_GENERATED', {})
    ).resolves.not.toThrow();
  });

  test('procesa múltiples señales de distintos símbolos independientemente', async () => {
    const { engine, broker, adapter } = makeEngine();
    adapter.updateMarketPrice('ETHUSDT', 2_000);
    await engine.start();

    const planBTC = makeTradePlan({ symbol: 'BTCUSDT', strategyId: 'strat-a' });
    const planETH = makeTradePlan({
      symbol:     'ETHUSDT',
      strategyId: 'strat-b',
      entryPrice: 2_000,
      stopLoss:   1_970,
      takeProfits: [
        { price: 2_060, sizePercent: 50 },
        { price: 2_120, sizePercent: 50 },
      ],
    });

    await broker.emit('STRATEGY_SIGNAL_GENERATED', { tradePlan: planBTC });
    await broker.emit('STRATEGY_SIGNAL_GENERATED', { tradePlan: planETH });

    const opened = broker.published.filter(e => e.channel === 'EXECUTION_TRADE_OPENED');
    expect(opened).toHaveLength(2);
  });
});
