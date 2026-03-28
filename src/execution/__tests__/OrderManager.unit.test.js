/**
 * OrderManager.unit.test.js
 *
 * Tests unitarios del OrderManager.
 * El BrokerAdapter se reemplaza por un doble de prueba configurable.
 */

import OrderManager from '../OrderManager.js';

// ---------------------------------------------------------------------------
// Helpers / Factories
// ---------------------------------------------------------------------------

function makeTimeProvider(fixedMs = 1_700_000_000_000) {
  return { now: () => fixedMs };
}

function makeLogger() {
  return {
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
  };
}

/**
 * Crea un BrokerAdapter stub cuyas órdenes pueden configurarse para
 * retornar FILLED o PENDING según la clave de clientOrderId.
 */
function makeAdapter({ alwaysFill = false, fillPrice = 30_200 } = {}) {
  let orderCounter = 100;
  const placedOrders   = [];
  const canceledOrders = [];

  const adapter = {
    placedOrders,
    canceledOrders,

    placeOrder: vi.fn(async (order) => {
      const orderId = `ord-${++orderCounter}`;
      const stored  = { ...order, orderId };

      const isFilled   = alwaysFill || order.type === 'MARKET';
      stored.status    = isFilled ? 'FILLED'  : 'PENDING';
      stored.fillPrice = isFilled ? fillPrice : null;
      placedOrders.push(stored);

      return {
        orderId,
        status:    stored.status,
        fillPrice: stored.fillPrice,
      };
    }),

    cancelOrder: vi.fn(async (orderId) => {
      canceledOrders.push(orderId);
      return { success: true };
    }),

    getOpenOrders: vi.fn(async () => []),
    getBalance:    vi.fn(async () => ({ available: 10_000, total: 10_000 })),
  };

  return adapter;
}

/** TradePlan mínimo válido — LONG con 2 TPs */
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

function makeOrderManager(adapterOpts = {}) {
  const adapter      = makeAdapter(adapterOpts);
  const timeProvider = makeTimeProvider();
  const logger       = makeLogger();
  const manager      = new OrderManager({ brokerAdapter: adapter, timeProvider, logger });
  return { manager, adapter, logger };
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe('OrderManager — constructor', () => {
  test('lanza si brokerAdapter no se provee', () => {
    expect(() => new OrderManager({
      timeProvider: makeTimeProvider(),
    })).toThrow('brokerAdapter');
  });

  test('lanza si timeProvider no se provee', () => {
    expect(() => new OrderManager({
      brokerAdapter: makeAdapter(),
    })).toThrow('timeProvider');
  });

  test('se instancia correctamente con dependencias válidas', () => {
    expect(() => new OrderManager({
      brokerAdapter: makeAdapter(),
      timeProvider:  makeTimeProvider(),
    })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// openPosition — validación de TPs
// ---------------------------------------------------------------------------

describe('OrderManager.openPosition — validación de TPs', () => {
  test('lanza si no hay Take Profits', async () => {
    const { manager } = makeOrderManager({ alwaysFill: true });
    const plan = makeTradePlan({ takeProfits: [] });

    await expect(manager.openPosition({
      tradeId: 'trade-1',
      tradePlan: plan,
      units: 0.1,
    })).rejects.toThrow(/al menos un Take Profit/);
  });

  test('lanza si los TPs de un LONG están desordenados (descendente)', async () => {
    const { manager } = makeOrderManager({ alwaysFill: true });
    const plan = makeTradePlan({
      direction:   'LONG',
      takeProfits: [
        { price: 31_200, sizePercent: 50 },  // TP1 más alto que TP2
        { price: 30_600, sizePercent: 50 },
      ],
    });

    await expect(manager.openPosition({
      tradeId: 'trade-1',
      tradePlan: plan,
      units: 0.1,
    })).rejects.toThrow(/LONG/);
  });

  test('lanza si los TPs de un SHORT están desordenados (ascendente)', async () => {
    const { manager } = makeOrderManager({ alwaysFill: true });
    const plan = makeTradePlan({
      direction:   'SHORT',
      entryPrice:  30_000,
      stopLoss:    30_300,
      takeProfits: [
        { price: 29_400, sizePercent: 50 },
        { price: 29_700, sizePercent: 50 }, // TP2 más alto que TP1 → error en SHORT
      ],
    });

    await expect(manager.openPosition({
      tradeId: 'trade-1',
      tradePlan: plan,
      units: 0.1,
    })).rejects.toThrow(/SHORT/);
  });

  test('lanza si la suma de sizePercent no es 100', async () => {
    const { manager } = makeOrderManager({ alwaysFill: true });
    const plan = makeTradePlan({
      takeProfits: [
        { price: 30_600, sizePercent: 40 },
        { price: 31_200, sizePercent: 40 }, // total 80 ≠ 100
      ],
    });

    await expect(manager.openPosition({
      tradeId: 'trade-1',
      tradePlan: plan,
      units: 0.1,
    })).rejects.toThrow(/100/);
  });

  test('acepta TPs correctamente ordenados para LONG', async () => {
    const { manager } = makeOrderManager({ alwaysFill: true });
    const plan = makeTradePlan(); // TPs ascendentes por defecto

    await expect(manager.openPosition({
      tradeId: 'trade-1',
      tradePlan: plan,
      units: 0.1,
    })).resolves.not.toThrow();
  });

  test('acepta TPs correctamente ordenados para SHORT', async () => {
    const { manager } = makeOrderManager({ alwaysFill: true });
    const plan = makeTradePlan({
      direction:   'SHORT',
      entryPrice:  30_000,
      stopLoss:    30_300,
      takeProfits: [
        { price: 29_700, sizePercent: 50 },
        { price: 29_400, sizePercent: 50 },
      ],
    });

    await expect(manager.openPosition({
      tradeId: 'trade-2',
      tradePlan: plan,
      units: 0.1,
    })).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// openPosition — flujo principal
// ---------------------------------------------------------------------------

describe('OrderManager.openPosition — flujo principal', () => {
  test('queda en WAITING_ENTRY cuando la orden de entrada es LIMIT y no se llena', async () => {
    const { manager, adapter } = makeOrderManager({ alwaysFill: false });
    const group = await manager.openPosition({
      tradeId:   'trade-1',
      tradePlan: makeTradePlan(),
      units:     0.1,
      entryType: 'LIMIT',
    });

    expect(group.status).toBe('WAITING_ENTRY');
    expect(group.slOrderId).toBeNull();
    expect(group.tpOrderIds).toHaveLength(0);
  });

  test('pasa a OPEN y coloca SL + TPs cuando la entrada se llena inmediatamente', async () => {
    const { manager, adapter } = makeOrderManager({ alwaysFill: true });
    const group = await manager.openPosition({
      tradeId:   'trade-1',
      tradePlan: makeTradePlan(),
      units:     0.1,
      entryType: 'LIMIT',
    });

    expect(group.status).toBe('OPEN');
    expect(group.slOrderId).toBeTruthy();
    expect(group.tpOrderIds).toHaveLength(2);
    // 1 orden de entrada + 1 SL + 2 TPs = 4 llamadas
    expect(adapter.placeOrder).toHaveBeenCalledTimes(4);
  });

  test('coloca la orden de entrada con los parámetros correctos', async () => {
    const { manager, adapter } = makeOrderManager({ alwaysFill: false });
    const plan = makeTradePlan();

    await manager.openPosition({ tradeId: 'trade-1', tradePlan: plan, units: 0.5 });

    const entryCall = adapter.placeOrder.mock.calls[0][0];
    expect(entryCall.symbol).toBe(plan.symbol);
    expect(entryCall.side).toBe('BUY'); // LONG → BUY
    expect(entryCall.quantity).toBe(0.5);
    expect(entryCall.price).toBe(plan.entryPrice);
  });

  test('el SL es SELL para posición LONG', async () => {
    const { manager, adapter } = makeOrderManager({ alwaysFill: true });
    await manager.openPosition({
      tradeId:   'trade-1',
      tradePlan: makeTradePlan(),
      units:     0.1,
    });

    // Encontrar la llamada de SL
    const slCall = adapter.placeOrder.mock.calls.find(
      ([order]) => order.type === 'STOP_LOSS'
    )[0];
    expect(slCall.side).toBe('SELL');
    expect(slCall.stopPrice).toBe(29_700);
  });

  test('el SL es BUY para posición SHORT', async () => {
    const { manager, adapter } = makeOrderManager({ alwaysFill: true });
    await manager.openPosition({
      tradeId:   'trade-2',
      tradePlan: makeTradePlan({
        direction:   'SHORT',
        entryPrice:  30_000,
        stopLoss:    30_300,
        takeProfits: [
          { price: 29_700, sizePercent: 50 },
          { price: 29_400, sizePercent: 50 },
        ],
      }),
      units: 0.1,
    });

    const slCall = adapter.placeOrder.mock.calls.find(
      ([order]) => order.type === 'STOP_LOSS'
    )[0];
    expect(slCall.side).toBe('BUY');
  });
});

// ---------------------------------------------------------------------------
// onEntryFilled
// ---------------------------------------------------------------------------

describe('OrderManager.onEntryFilled', () => {
  test('coloca SL y TPs tras confirmar la entrada', async () => {
    const { manager, adapter } = makeOrderManager({ alwaysFill: false });
    const plan = makeTradePlan();

    await manager.openPosition({ tradeId: 'trade-1', tradePlan: plan, units: 0.3 });
    // Hasta aquí solo la orden de entrada (1 llamada)
    expect(adapter.placeOrder).toHaveBeenCalledTimes(1);

    // Confirmar fill de entrada
    await manager.onEntryFilled('trade-1', 30_050, plan);

    // Ahora debe haber SL + 2 TPs = 3 llamadas adicionales
    expect(adapter.placeOrder).toHaveBeenCalledTimes(4);

    const group = manager.getGroup('trade-1');
    expect(group.status).toBe('OPEN');
    expect(group.entryPrice).toBe(30_050);
    expect(group.slOrderId).toBeTruthy();
    expect(group.tpOrderIds).toHaveLength(2);
  });

  test('lanza si el trade no está en WAITING_ENTRY', async () => {
    const { manager } = makeOrderManager({ alwaysFill: true });
    await manager.openPosition({
      tradeId:   'trade-1',
      tradePlan: makeTradePlan(),
      units:     0.1,
    });

    // Ya está OPEN
    await expect(
      manager.onEntryFilled('trade-1', 30_000, makeTradePlan())
    ).rejects.toThrow('WAITING_ENTRY');
  });
});

// ---------------------------------------------------------------------------
// moveSL
// ---------------------------------------------------------------------------

describe('OrderManager.moveSL', () => {
  test('cancela el SL anterior y coloca uno nuevo', async () => {
    const { manager, adapter } = makeOrderManager({ alwaysFill: true });
    await manager.openPosition({
      tradeId:   'trade-1',
      tradePlan: makeTradePlan(),
      units:     0.1,
    });

    const oldGroup  = manager.getGroup('trade-1');
    const oldSLId   = oldGroup.slOrderId;

    const result = await manager.moveSL('trade-1', 29_900);

    expect(adapter.cancelOrder).toHaveBeenCalledWith(oldSLId, 'BTCUSDT');
    expect(result.oldSL).toBe(29_700);
    expect(result.newSL).toBe(29_900);

    const newGroup = manager.getGroup('trade-1');
    expect(newGroup.currentSL).toBe(29_900);
    expect(newGroup.slOrderId).not.toBe(oldSLId);
  });

  test('lanza si el trade no está OPEN', async () => {
    const { manager } = makeOrderManager({ alwaysFill: false });
    await manager.openPosition({
      tradeId:   'trade-1',
      tradePlan: makeTradePlan(),
      units:     0.1,
    });

    await expect(manager.moveSL('trade-1', 29_900)).rejects.toThrow(/abierto/);
  });
});

// ---------------------------------------------------------------------------
// registerTPFill
// ---------------------------------------------------------------------------

describe('OrderManager.registerTPFill', () => {
  test('reduce remainingUnits al registrar un TP parcial', async () => {
    const { manager } = makeOrderManager({ alwaysFill: true });
    await manager.openPosition({
      tradeId:   'trade-1',
      tradePlan: makeTradePlan(),
      units:     1.0,
    });

    const { remainingUnits, isFullyClosed } = manager.registerTPFill('trade-1', 0, 30_600, 0.5);
    expect(remainingUnits).toBeCloseTo(0.5);
    expect(isFullyClosed).toBe(false);
  });

  test('detecta cierre completo cuando remainingUnits llega a 0', async () => {
    const { manager } = makeOrderManager({ alwaysFill: true });
    await manager.openPosition({
      tradeId:   'trade-1',
      tradePlan: makeTradePlan(),
      units:     1.0,
    });

    manager.registerTPFill('trade-1', 0, 30_600, 0.5);
    const { isFullyClosed } = manager.registerTPFill('trade-1', 1, 31_200, 0.5);

    expect(isFullyClosed).toBe(true);
    const group = manager.getGroup('trade-1');
    expect(group.status).toBe('CLOSED');
  });
});

// ---------------------------------------------------------------------------
// closeGroup
// ---------------------------------------------------------------------------

describe('OrderManager.closeGroup', () => {
  test('cancela el SL y todos los TPs pendientes', async () => {
    const { manager, adapter } = makeOrderManager({ alwaysFill: true });
    await manager.openPosition({
      tradeId:   'trade-1',
      tradePlan: makeTradePlan(),
      units:     0.1,
    });

    const group = manager.getGroup('trade-1');
    await manager.closeGroup('trade-1', 'SL');

    // Debe haber cancelado el SL + 2 TPs = 3 cancelaciones
    expect(adapter.cancelOrder).toHaveBeenCalledTimes(3);
    const canceledIds = adapter.cancelOrder.mock.calls.map(([id]) => id);
    expect(canceledIds).toContain(group.slOrderId);
    for (const tpId of group.tpOrderIds) {
      expect(canceledIds).toContain(tpId);
    }
  });

  test('no lanza si closeGroup se llama dos veces', async () => {
    const { manager } = makeOrderManager({ alwaysFill: true });
    await manager.openPosition({
      tradeId:   'trade-1',
      tradePlan: makeTradePlan(),
      units:     0.1,
    });

    await manager.closeGroup('trade-1', 'SL');
    await expect(manager.closeGroup('trade-1', 'manual')).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// getActiveTradeIds
// ---------------------------------------------------------------------------

describe('OrderManager.getActiveTradeIds', () => {
  test('retorna los trades OPEN y WAITING_ENTRY', async () => {
    const { manager } = makeOrderManager({ alwaysFill: false });

    // Trade en WAITING_ENTRY
    await manager.openPosition({
      tradeId: 'trade-waiting',
      tradePlan: makeTradePlan(),
      units: 0.1,
    });

    const ids = manager.getActiveTradeIds();
    expect(ids).toContain('trade-waiting');
  });

  test('no incluye trades cerrados', async () => {
    const { manager } = makeOrderManager({ alwaysFill: true });

    await manager.openPosition({
      tradeId: 'trade-1',
      tradePlan: makeTradePlan(),
      units: 0.1,
    });
    await manager.closeGroup('trade-1', 'SL');

    const ids = manager.getActiveTradeIds();
    expect(ids).not.toContain('trade-1');
  });
});
