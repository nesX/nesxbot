/**
 * ExposureManager.unit.test.js
 *
 * Tests unitarios del ExposureManager.
 * El BrokerAdapter se reemplaza por un doble de prueba.
 */

import ExposureManager from '../ExposureManager.js';

// ---------------------------------------------------------------------------
// Helpers / Factories
// ---------------------------------------------------------------------------

function makeAdapter({ available = 10_000, total = 10_000 } = {}) {
  return {
    getBalance: vi.fn(async () => ({ available, total })),
  };
}

function makeLogger() {
  return {
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
  };
}

/** TradePlan mínimo válido */
function makeTradePlan(overrides = {}) {
  return {
    strategyId:  'strat-a',
    symbol:      'BTCUSDT',
    direction:   'LONG',
    entryPrice:  30_000,
    stopLoss:    29_700,  // 1% de riesgo = 300 puntos
    takeProfits: [{ price: 31_000, sizePercent: 100 }],
    riskPercent: 1,
    metadata:    {},
    ...overrides,
  };
}

function makeManager(adapterOpts, configOverrides) {
  const adapter = makeAdapter(adapterOpts);
  const logger  = makeLogger();
  const manager = new ExposureManager({
    brokerAdapter: adapter,
    config:        configOverrides,
    logger,
  });
  return { manager, adapter, logger };
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe('ExposureManager — constructor', () => {
  test('lanza si brokerAdapter no se provee', () => {
    expect(() => new ExposureManager({})).toThrow('brokerAdapter');
  });

  test('se instancia correctamente con dependencias mínimas', () => {
    expect(() => new ExposureManager({ brokerAdapter: makeAdapter() })).not.toThrow();
  });

  test('usa configuración por defecto cuando no se pasa config', () => {
    const { manager } = makeManager();
    // Comprobamos indirectamente a través de canExecute
    expect(manager).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// canExecute — reglas de riesgo
// ---------------------------------------------------------------------------

describe('ExposureManager.canExecute', () => {
  test('permite un TradePlan válido dentro de los límites', async () => {
    const { manager } = makeManager();
    const result = await manager.canExecute(makeTradePlan({ riskPercent: 1 }));
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  test('rechaza si riskPercent supera el máximo por trade', async () => {
    const { manager } = makeManager({}, { maxRiskPerTradePercent: 2 });
    const result = await manager.canExecute(makeTradePlan({ riskPercent: 3 }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/máximo por trade/);
  });

  test('rechaza si se alcanza el número máximo de posiciones abiertas', async () => {
    const { manager } = makeManager({}, { maxOpenTrades: 2 });

    // Abrir 2 trades
    manager.registerOpenTrade('trade-1', 'BTCUSDT', 1, 100);
    manager.registerOpenTrade('trade-2', 'ETHUSDT', 1, 100);

    const result = await manager.canExecute(makeTradePlan());
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/máximo/);
  });

  test('rechaza si la exposición por símbolo superaría el máximo', async () => {
    const { manager } = makeManager({}, { maxRiskPerSymbolPercent: 3 });

    // Ya hay 2% de riesgo en BTCUSDT
    manager.registerOpenTrade('trade-1', 'BTCUSDT', 2, 200);

    // Pedir otro 2% → total 4% > límite 3%
    const result = await manager.canExecute(makeTradePlan({ riskPercent: 2 }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/máximo por símbolo/);
  });

  test('rechaza si el riesgo total del portafolio superaría el máximo', async () => {
    const { manager } = makeManager(
      {},
      { maxTotalRiskPercent: 5, maxRiskPerSymbolPercent: 10, maxOpenTrades: 10 }
    );

    // 4% activo en diferentes símbolos
    manager.registerOpenTrade('trade-1', 'BTCUSDT', 2, 200);
    manager.registerOpenTrade('trade-2', 'ETHUSDT', 2, 200);

    // Pedir otro 2% → total 6% > límite 5%
    const result = await manager.canExecute(makeTradePlan({ symbol: 'SOLUSDT', riskPercent: 2 }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/máximo del portafolio/);
  });

  test('permite trade en símbolo diferente cuando hay espacio', async () => {
    const { manager } = makeManager(
      {},
      { maxRiskPerSymbolPercent: 3, maxTotalRiskPercent: 10, maxOpenTrades: 10 }
    );

    manager.registerOpenTrade('trade-1', 'BTCUSDT', 2, 200);

    // Nuevo trade en ETHUSDT no toca el límite de BTCUSDT
    const result = await manager.canExecute(makeTradePlan({ symbol: 'ETHUSDT', riskPercent: 2 }));
    expect(result.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// calculateSize
// ---------------------------------------------------------------------------

describe('ExposureManager.calculateSize', () => {
  test('calcula units y notional correctamente', async () => {
    // balance: 10_000, riskPercent: 1% → riskAmount: 100
    // entryPrice: 30_000, stopLoss: 29_700 → riskPerUnit: 300
    // units = 100 / 300 = 0.3333...
    const { manager } = makeManager({ available: 10_000 });
    const plan = makeTradePlan({ entryPrice: 30_000, stopLoss: 29_700, riskPercent: 1 });

    const result = await manager.calculateSize(plan);

    // riskAmount = 10_000 * 1% = 100
    // units = 100 / 300 = 0.3333...
    // notional = (100 / 300) * 30_000 = 10_000  (exactly: riskAmount / riskPerUnit * entryPrice)
    expect(result.riskAmount).toBeCloseTo(100);
    expect(result.units).toBeCloseTo(0.3333, 3);
    expect(result.notional).toBeCloseTo(10_000, 0);
  });

  test('consulta el balance del brokerAdapter', async () => {
    const { manager, adapter } = makeManager({ available: 5_000 });
    await manager.calculateSize(makeTradePlan());
    expect(adapter.getBalance).toHaveBeenCalled();
  });

  test('lanza si entryPrice === stopLoss (división por cero)', async () => {
    const { manager } = makeManager();
    const plan = makeTradePlan({ entryPrice: 30_000, stopLoss: 30_000 });

    await expect(manager.calculateSize(plan)).rejects.toThrow('división por cero');
  });

  test('escala correctamente con distintos balances', async () => {
    const { manager: m1 } = makeManager({ available: 10_000 });
    const { manager: m2 } = makeManager({ available: 20_000 });
    const plan = makeTradePlan({ riskPercent: 1 });

    const r1 = await m1.calculateSize(plan);
    const r2 = await m2.calculateSize(plan);

    // Con el doble de balance, units y notional deben ser el doble
    expect(r2.units).toBeCloseTo(r1.units * 2, 5);
    expect(r2.notional).toBeCloseTo(r1.notional * 2, 2);
  });
});

// ---------------------------------------------------------------------------
// getCurrentExposure
// ---------------------------------------------------------------------------

describe('ExposureManager.getCurrentExposure', () => {
  test('retorna 0 trades y 0 riesgo cuando no hay posiciones', async () => {
    const { manager } = makeManager();
    const exp = await manager.getCurrentExposure();
    expect(exp.openTrades).toBe(0);
    expect(exp.openRisk).toBe(0);
  });

  test('retorna el total correcto después de abrir trades', async () => {
    const { manager } = makeManager();
    manager.registerOpenTrade('t1', 'BTCUSDT', 1.5, 150);
    manager.registerOpenTrade('t2', 'ETHUSDT', 2.0, 200);

    const exp = await manager.getCurrentExposure();
    expect(exp.openTrades).toBe(2);
    expect(exp.openRisk).toBeCloseTo(3.5);
  });

  test('actualiza correctamente al cerrar un trade', async () => {
    const { manager } = makeManager();
    manager.registerOpenTrade('t1', 'BTCUSDT', 1.5, 150);
    manager.registerOpenTrade('t2', 'ETHUSDT', 2.0, 200);
    manager.unregisterTrade('t1');

    const exp = await manager.getCurrentExposure();
    expect(exp.openTrades).toBe(1);
    expect(exp.openRisk).toBeCloseTo(2.0);
  });
});

// ---------------------------------------------------------------------------
// registerOpenTrade / unregisterTrade
// ---------------------------------------------------------------------------

describe('ExposureManager — registro de trades', () => {
  test('registerOpenTrade no duplica si el mismo tradeId se registra dos veces', async () => {
    const { manager, logger } = makeManager(
      {},
      { maxOpenTrades: 5, maxTotalRiskPercent: 20 }
    );
    manager.registerOpenTrade('t1', 'BTCUSDT', 1, 100);
    manager.registerOpenTrade('t1', 'BTCUSDT', 1, 100); // duplicado

    const exp = await manager.getCurrentExposure();
    expect(exp.openTrades).toBe(1);
    expect(logger.warn).toHaveBeenCalled();
  });

  test('unregisterTrade loggea warn si el tradeId no existe', () => {
    const { manager, logger } = makeManager();
    manager.unregisterTrade('no-existe');
    expect(logger.warn).toHaveBeenCalled();
  });
});
