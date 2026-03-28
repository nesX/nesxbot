/**
 * PositionManager.unit.test.js
 *
 * Tests unitarios del PositionManager.
 * Todas las dependencias son dobles en memoria — no se requiere BD real.
 *
 * Casos cubiertos:
 *   Constructor
 *     - lanza si falta messageBroker, timeProvider o positionRepository
 *     - se instancia correctamente con todas las dependencias
 *
 *   start()
 *     - reconstruye posiciones abiertas desde BD al iniciar
 *     - se suscribe a los cuatro eventos de ejecución
 *     - un segundo start() es idempotente
 *
 *   stop()
 *     - limpia el estado en memoria
 *     - eventos posteriores a stop() son ignorados
 *
 *   EXECUTION_TRADE_OPENED
 *     - agrega la posición al estado en memoria
 *     - persiste la posición en BD via repositorio
 *     - un tradeId duplicado es ignorado silenciosamente
 *
 *   EXECUTION_PARTIAL_FILLED
 *     - actualiza size y status a PARTIAL
 *     - llama a repo.update con los cambios correctos
 *     - payload con tradeId desconocido no lanza
 *
 *   EXECUTION_SL_MOVED
 *     - actualiza stopLoss en memoria y llama a repo.update
 *     - payload con tradeId desconocido no lanza
 *
 *   EXECUTION_TRADE_CLOSED
 *     - elimina la posición del mapa en memoria
 *     - llama a repo.update con status CLOSED, exitPrice, exitType, pnl
 *     - payload con tradeId desconocido no lanza
 *
 *   getOpenPositions()
 *     - retorna copias de las posiciones (no referencias mutables)
 *     - retorna array vacío si no hay posiciones abiertas
 *
 *   getPosition(tradeId)
 *     - retorna copia de la posición cuando existe
 *     - retorna null para tradeId desconocido
 *
 *   syncWithBroker()
 *     - emite SYSTEM_SYNC_DISCREPANCY cuando local no está en broker
 *     - emite SYSTEM_SYNC_DISCREPANCY cuando broker tiene posición sin registro local
 *     - no emite discrepancia cuando broker y estado local coinciden
 *     - no opera si no se inyectó brokerAdapter
 */

import PositionManager from '../PositionManager.js';

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const FIXED_TS = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// Factories de dobles
// ---------------------------------------------------------------------------

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
      if (!subscribers[channel]) subscribers[channel] = [];
      subscribers[channel].push(handler);
    }),
    published,
    subscribers,
    // Simula la recepción de un evento
    emit: async (channel, payload) => {
      if (subscribers[channel]) {
        for (const handler of subscribers[channel]) {
          await handler(payload);
        }
      }
    },
  };
}

function makeRepo(openPositions = []) {
  return {
    save:     vi.fn(async () => {}),
    update:   vi.fn(async () => true),
    findOpen: vi.fn(async () => openPositions),
    findById: vi.fn(async (tradeId) => {
      return openPositions.find(p => p.tradeId === tradeId) || null;
    }),
  };
}

function makeLogger() {
  return {
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
  };
}

function makeBrokerAdapter(openOrders = []) {
  return {
    getOpenOrders: vi.fn(async () => openOrders),
    placeOrder:    vi.fn(),
    cancelOrder:   vi.fn(),
    getBalance:    vi.fn(async () => ({ available: 10_000, total: 10_000 })),
  };
}

/** Posición válida completa */
function makePosition(overrides = {}) {
  return {
    tradeId:     'strat-a-BTCUSDT-1700000000000',
    strategyId:  'strat-a',
    symbol:      'BTCUSDT',
    direction:   'LONG',
    entryPrice:  30_000,
    entryTime:   FIXED_TS,
    stopLoss:    29_700,
    takeProfits: [
      { price: 30_600, sizePercent: 50 },
      { price: 31_200, sizePercent: 50 },
    ],
    size:   0.1,
    status: 'OPEN',
    ...overrides,
  };
}

/** Payload del evento EXECUTION_TRADE_OPENED */
function makeTradeOpenedPayload(overrides = {}) {
  return {
    tradeId:     'strat-a-BTCUSDT-1700000000000',
    strategyId:  'strat-a',
    symbol:      'BTCUSDT',
    direction:   'LONG',
    entryPrice:  30_000,
    size:        0.1,
    stopLoss:    29_700,
    takeProfits: [
      { price: 30_600, sizePercent: 50 },
      { price: 31_200, sizePercent: 50 },
    ],
    timestamp: FIXED_TS,
    ...overrides,
  };
}

/** Construye un PositionManager listo para usar */
function makeManager(opts = {}) {
  const broker  = opts.broker  || makeBroker();
  const repo    = opts.repo    || makeRepo(opts.openPositions || []);
  const adapter = opts.adapter !== undefined ? opts.adapter : makeBrokerAdapter();
  const logger  = opts.logger  || makeLogger();
  const time    = opts.time    || makeTimeProvider();

  const manager = new PositionManager({
    messageBroker:      broker,
    timeProvider:       time,
    positionRepository: repo,
    brokerAdapter:      adapter,
    logger,
  });

  return { manager, broker, repo, adapter, logger, time };
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe('PositionManager — constructor', () => {
  test('lanza si messageBroker no se provee', () => {
    expect(() => new PositionManager({
      timeProvider:       makeTimeProvider(),
      positionRepository: makeRepo(),
    })).toThrow('messageBroker');
  });

  test('lanza si timeProvider no se provee', () => {
    expect(() => new PositionManager({
      messageBroker:      makeBroker(),
      positionRepository: makeRepo(),
    })).toThrow('timeProvider');
  });

  test('lanza si positionRepository no se provee', () => {
    expect(() => new PositionManager({
      messageBroker: makeBroker(),
      timeProvider:  makeTimeProvider(),
    })).toThrow('positionRepository');
  });

  test('se instancia correctamente con las dependencias mínimas', () => {
    expect(() => new PositionManager({
      messageBroker:      makeBroker(),
      timeProvider:       makeTimeProvider(),
      positionRepository: makeRepo(),
    })).not.toThrow();
  });

  test('brokerAdapter es opcional', () => {
    expect(() => new PositionManager({
      messageBroker:      makeBroker(),
      timeProvider:       makeTimeProvider(),
      positionRepository: makeRepo(),
    })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// start()
// ---------------------------------------------------------------------------

describe('PositionManager — start()', () => {
  test('carga posiciones abiertas desde BD al iniciar', async () => {
    const existing = [makePosition()];
    const { manager } = makeManager({ openPositions: existing });

    await manager.start();

    expect(manager.getOpenPositions()).toHaveLength(1);
    expect(manager.getPosition(existing[0].tradeId)).not.toBeNull();
  });

  test('se suscribe a los cuatro eventos de ejecución', async () => {
    const { manager, broker } = makeManager();
    await manager.start();

    const channels = broker.subscribe.mock.calls.map(c => c[0]);
    expect(channels).toContain('EXECUTION_TRADE_OPENED');
    expect(channels).toContain('EXECUTION_PARTIAL_FILLED');
    expect(channels).toContain('EXECUTION_SL_MOVED');
    expect(channels).toContain('EXECUTION_TRADE_CLOSED');
  });

  test('segundo start() es idempotente — no suscribe dos veces', async () => {
    const { manager, broker } = makeManager();
    await manager.start();
    await manager.start();

    // 4 suscripciones en total, no 8
    expect(broker.subscribe).toHaveBeenCalledTimes(4);
  });

  test('start() sin posiciones abiertas en BD deja el mapa vacío', async () => {
    const { manager } = makeManager({ openPositions: [] });
    await manager.start();
    expect(manager.getOpenPositions()).toHaveLength(0);
  });

  test('start() carga múltiples posiciones abiertas', async () => {
    const positions = [
      makePosition({ tradeId: 'trade-1', symbol: 'BTCUSDT' }),
      makePosition({ tradeId: 'trade-2', symbol: 'ETHUSDT' }),
    ];
    const { manager } = makeManager({ openPositions: positions });
    await manager.start();
    expect(manager.getOpenPositions()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// stop()
// ---------------------------------------------------------------------------

describe('PositionManager — stop()', () => {
  test('stop() limpia el estado en memoria', async () => {
    const existing = [makePosition()];
    const { manager } = makeManager({ openPositions: existing });

    await manager.start();
    expect(manager.getOpenPositions()).toHaveLength(1);

    await manager.stop();
    expect(manager.getOpenPositions()).toHaveLength(0);
  });

  test('eventos recibidos después de stop() son ignorados', async () => {
    const { manager, broker, repo } = makeManager();
    await manager.start();
    await manager.stop();

    await broker.emit('EXECUTION_TRADE_OPENED', makeTradeOpenedPayload());

    expect(manager.getOpenPositions()).toHaveLength(0);
    expect(repo.save).not.toHaveBeenCalled();
  });

  test('stop() múltiple no lanza', async () => {
    const { manager } = makeManager();
    await manager.start();
    await expect(manager.stop()).resolves.not.toThrow();
    await expect(manager.stop()).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// EXECUTION_TRADE_OPENED
// ---------------------------------------------------------------------------

describe('PositionManager — EXECUTION_TRADE_OPENED', () => {
  test('agrega la posición al estado en memoria', async () => {
    const { manager, broker } = makeManager();
    await manager.start();

    await broker.emit('EXECUTION_TRADE_OPENED', makeTradeOpenedPayload());

    const positions = manager.getOpenPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0].tradeId).toBe('strat-a-BTCUSDT-1700000000000');
    expect(positions[0].status).toBe('OPEN');
  });

  test('persiste la posición en BD via save()', async () => {
    const { manager, broker, repo } = makeManager();
    await manager.start();

    await broker.emit('EXECUTION_TRADE_OPENED', makeTradeOpenedPayload());

    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(repo.save.mock.calls[0][0]).toMatchObject({
      tradeId:   'strat-a-BTCUSDT-1700000000000',
      symbol:    'BTCUSDT',
      direction: 'LONG',
      status:    'OPEN',
    });
  });

  test('un tradeId duplicado no lanza ni duplica la posición', async () => {
    const { manager, broker, repo } = makeManager();
    await manager.start();

    const payload = makeTradeOpenedPayload();
    await broker.emit('EXECUTION_TRADE_OPENED', payload);
    await broker.emit('EXECUTION_TRADE_OPENED', payload); // duplicado

    expect(manager.getOpenPositions()).toHaveLength(1);
    expect(repo.save).toHaveBeenCalledTimes(1); // persistido una sola vez
  });

  test('payload incompleto es ignorado silenciosamente', async () => {
    const { manager, broker } = makeManager();
    await manager.start();

    await expect(
      broker.emit('EXECUTION_TRADE_OPENED', { tradeId: 'abc' }) // falta symbol, direction, etc.
    ).resolves.not.toThrow();

    expect(manager.getOpenPositions()).toHaveLength(0);
  });

  test('takeProfits se almacenan como copias independientes', async () => {
    const { manager, broker } = makeManager();
    await manager.start();

    const payload = makeTradeOpenedPayload();
    await broker.emit('EXECUTION_TRADE_OPENED', payload);

    const position = manager.getPosition('strat-a-BTCUSDT-1700000000000');
    expect(position.takeProfits).toHaveLength(2);
    expect(position.takeProfits[0]).toEqual({ price: 30_600, sizePercent: 50 });
  });

  test('error de repo.save no propaga al emisor del evento', async () => {
    const repo = makeRepo();
    repo.save = vi.fn(async () => { throw new Error('BD no disponible'); });

    const { manager, broker } = makeManager({ repo });
    await manager.start();

    await expect(
      broker.emit('EXECUTION_TRADE_OPENED', makeTradeOpenedPayload())
    ).resolves.not.toThrow();

    // La posición aún se guarda en memoria aunque falle la BD
    expect(manager.getOpenPositions()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// EXECUTION_PARTIAL_FILLED
// ---------------------------------------------------------------------------

describe('PositionManager — EXECUTION_PARTIAL_FILLED', () => {
  test('actualiza size y status a PARTIAL', async () => {
    const { manager, broker } = makeManager();
    await manager.start();

    await broker.emit('EXECUTION_TRADE_OPENED', makeTradeOpenedPayload());

    await broker.emit('EXECUTION_PARTIAL_FILLED', {
      tradeId:       'strat-a-BTCUSDT-1700000000000',
      tpLevel:       1,
      fillPrice:     30_600,
      remainingSize: 0.05,
      timestamp:     FIXED_TS,
    });

    const position = manager.getPosition('strat-a-BTCUSDT-1700000000000');
    expect(position.size).toBe(0.05);
    expect(position.status).toBe('PARTIAL');
  });

  test('llama a repo.update con status PARTIAL', async () => {
    const { manager, broker, repo } = makeManager();
    await manager.start();

    await broker.emit('EXECUTION_TRADE_OPENED', makeTradeOpenedPayload());
    repo.update.mockClear();

    await broker.emit('EXECUTION_PARTIAL_FILLED', {
      tradeId:       'strat-a-BTCUSDT-1700000000000',
      tpLevel:       1,
      fillPrice:     30_600,
      remainingSize: 0.05,
      timestamp:     FIXED_TS,
    });

    expect(repo.update).toHaveBeenCalledWith(
      'strat-a-BTCUSDT-1700000000000',
      { status: 'PARTIAL' }
    );
  });

  test('tradeId desconocido no lanza', async () => {
    const { manager, broker } = makeManager();
    await manager.start();

    await expect(
      broker.emit('EXECUTION_PARTIAL_FILLED', {
        tradeId:       'trade-no-existe',
        remainingSize: 0.05,
        timestamp:     FIXED_TS,
      })
    ).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// EXECUTION_SL_MOVED
// ---------------------------------------------------------------------------

describe('PositionManager — EXECUTION_SL_MOVED', () => {
  test('actualiza stopLoss en memoria', async () => {
    const { manager, broker } = makeManager();
    await manager.start();

    await broker.emit('EXECUTION_TRADE_OPENED', makeTradeOpenedPayload());

    await broker.emit('EXECUTION_SL_MOVED', {
      tradeId:   'strat-a-BTCUSDT-1700000000000',
      oldSL:     29_700,
      newSL:     30_000,
      reason:    'breakeven',
      timestamp: FIXED_TS,
    });

    const position = manager.getPosition('strat-a-BTCUSDT-1700000000000');
    expect(position.stopLoss).toBe(30_000);
  });

  test('llama a repo.update con el nuevo stopLoss', async () => {
    const { manager, broker, repo } = makeManager();
    await manager.start();

    await broker.emit('EXECUTION_TRADE_OPENED', makeTradeOpenedPayload());
    repo.update.mockClear();

    await broker.emit('EXECUTION_SL_MOVED', {
      tradeId:   'strat-a-BTCUSDT-1700000000000',
      oldSL:     29_700,
      newSL:     30_000,
      reason:    'trailing',
      timestamp: FIXED_TS,
    });

    expect(repo.update).toHaveBeenCalledWith(
      'strat-a-BTCUSDT-1700000000000',
      { stopLoss: 30_000 }
    );
  });

  test('tradeId desconocido no lanza', async () => {
    const { manager, broker } = makeManager();
    await manager.start();

    await expect(
      broker.emit('EXECUTION_SL_MOVED', {
        tradeId:   'trade-no-existe',
        newSL:     30_000,
        timestamp: FIXED_TS,
      })
    ).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// EXECUTION_TRADE_CLOSED
// ---------------------------------------------------------------------------

describe('PositionManager — EXECUTION_TRADE_CLOSED', () => {
  test('elimina la posición del mapa en memoria', async () => {
    const { manager, broker } = makeManager();
    await manager.start();

    await broker.emit('EXECUTION_TRADE_OPENED', makeTradeOpenedPayload());
    expect(manager.getOpenPositions()).toHaveLength(1);

    await broker.emit('EXECUTION_TRADE_CLOSED', {
      tradeId:   'strat-a-BTCUSDT-1700000000000',
      exitPrice: 29_700,
      exitType:  'SL',
      pnl:       -30,
      timestamp: FIXED_TS,
    });

    expect(manager.getOpenPositions()).toHaveLength(0);
    expect(manager.getPosition('strat-a-BTCUSDT-1700000000000')).toBeNull();
  });

  test('llama a repo.update con CLOSED, exitPrice, exitType y pnl', async () => {
    const { manager, broker, repo } = makeManager();
    await manager.start();

    await broker.emit('EXECUTION_TRADE_OPENED', makeTradeOpenedPayload());
    repo.update.mockClear();

    await broker.emit('EXECUTION_TRADE_CLOSED', {
      tradeId:   'strat-a-BTCUSDT-1700000000000',
      exitPrice: 30_600,
      exitType:  'TP',
      pnl:       60,
      timestamp: FIXED_TS,
    });

    expect(repo.update).toHaveBeenCalledWith(
      'strat-a-BTCUSDT-1700000000000',
      expect.objectContaining({
        status:    'CLOSED',
        exitPrice: 30_600,
        exitType:  'TP',
        pnl:       60,
      })
    );
  });

  test('tradeId desconocido no lanza', async () => {
    const { manager, broker } = makeManager();
    await manager.start();

    await expect(
      broker.emit('EXECUTION_TRADE_CLOSED', {
        tradeId:   'trade-no-existe',
        exitPrice: 30_000,
        exitType:  'MANUAL',
        timestamp: FIXED_TS,
      })
    ).resolves.not.toThrow();
  });

  test('error de repo.update no propaga al emisor del evento', async () => {
    const repo = makeRepo();
    repo.update = vi.fn(async () => { throw new Error('BD no disponible'); });

    const { manager, broker } = makeManager({ repo });
    await manager.start();

    await broker.emit('EXECUTION_TRADE_OPENED', makeTradeOpenedPayload());

    await expect(
      broker.emit('EXECUTION_TRADE_CLOSED', {
        tradeId:   'strat-a-BTCUSDT-1700000000000',
        exitPrice: 29_700,
        exitType:  'SL',
        pnl:       -30,
        timestamp: FIXED_TS,
      })
    ).resolves.not.toThrow();

    // La posición fue eliminada de memoria aunque falle BD
    expect(manager.getOpenPositions()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getOpenPositions()
// ---------------------------------------------------------------------------

describe('PositionManager — getOpenPositions()', () => {
  test('retorna array vacío cuando no hay posiciones', async () => {
    const { manager } = makeManager();
    await manager.start();
    expect(manager.getOpenPositions()).toEqual([]);
  });

  test('retorna copias — mutar el resultado no afecta el estado interno', async () => {
    const { manager, broker } = makeManager();
    await manager.start();

    await broker.emit('EXECUTION_TRADE_OPENED', makeTradeOpenedPayload());

    const positions = manager.getOpenPositions();
    positions[0].stopLoss = 99_999; // mutar la copia

    // El estado interno no cambia
    const fresh = manager.getPosition('strat-a-BTCUSDT-1700000000000');
    expect(fresh.stopLoss).toBe(29_700);
  });

  test('retorna todas las posiciones abiertas y parciales', async () => {
    const positions = [
      makePosition({ tradeId: 'trade-1', status: 'OPEN' }),
      makePosition({ tradeId: 'trade-2', status: 'PARTIAL' }),
    ];
    const { manager } = makeManager({ openPositions: positions });
    await manager.start();

    expect(manager.getOpenPositions()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// getPosition()
// ---------------------------------------------------------------------------

describe('PositionManager — getPosition()', () => {
  test('retorna la posición cuando existe', async () => {
    const { manager, broker } = makeManager();
    await manager.start();

    await broker.emit('EXECUTION_TRADE_OPENED', makeTradeOpenedPayload());

    const position = manager.getPosition('strat-a-BTCUSDT-1700000000000');
    expect(position).not.toBeNull();
    expect(position.symbol).toBe('BTCUSDT');
  });

  test('retorna null para tradeId desconocido', async () => {
    const { manager } = makeManager();
    await manager.start();

    expect(manager.getPosition('no-existe')).toBeNull();
  });

  test('retorna copia — mutar el resultado no afecta el estado interno', async () => {
    const { manager, broker } = makeManager();
    await manager.start();

    await broker.emit('EXECUTION_TRADE_OPENED', makeTradeOpenedPayload());

    const copy = manager.getPosition('strat-a-BTCUSDT-1700000000000');
    copy.entryPrice = 1; // mutar la copia

    const fresh = manager.getPosition('strat-a-BTCUSDT-1700000000000');
    expect(fresh.entryPrice).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// syncWithBroker()
// ---------------------------------------------------------------------------

describe('PositionManager — syncWithBroker()', () => {
  test('no opera si no hay brokerAdapter', async () => {
    const { manager, broker } = makeManager({ adapter: null });
    await manager.start();

    await manager.syncWithBroker();

    const discrepancies = broker.published.filter(
      e => e.channel === 'SYSTEM_SYNC_DISCREPANCY'
    );
    expect(discrepancies).toHaveLength(0);
  });

  test('no emite discrepancia cuando broker y local coinciden', async () => {
    const tradeId = 'strat-a-BTCUSDT-1700000000000';

    // Broker conoce la misma posición local via clientOrderId
    const adapter = makeBrokerAdapter([
      { orderId: 'broker-1', clientOrderId: `${tradeId}-entry` },
    ]);

    const { manager, broker } = makeManager({ adapter });
    await manager.start();

    await broker.emit('EXECUTION_TRADE_OPENED', makeTradeOpenedPayload({ tradeId }));

    await manager.syncWithBroker();

    const discrepancies = broker.published.filter(
      e => e.channel === 'SYSTEM_SYNC_DISCREPANCY'
    );
    expect(discrepancies).toHaveLength(0);
  });

  test('emite SYSTEM_SYNC_DISCREPANCY cuando hay posición local sin órdenes en broker', async () => {
    // Broker no tiene órdenes
    const adapter = makeBrokerAdapter([]);

    const { manager, broker } = makeManager({ adapter });
    await manager.start();

    await broker.emit('EXECUTION_TRADE_OPENED', makeTradeOpenedPayload());

    await manager.syncWithBroker();

    const discrepancies = broker.published.filter(
      e => e.channel === 'SYSTEM_SYNC_DISCREPANCY'
    );
    expect(discrepancies).toHaveLength(1);
    expect(discrepancies[0].payload).toMatchObject({
      tradeId:     'strat-a-BTCUSDT-1700000000000',
      brokerState: null,
    });
    expect(discrepancies[0].payload.localState).not.toBeNull();
  });

  test('emite SYSTEM_SYNC_DISCREPANCY cuando broker tiene posición sin registro local', async () => {
    const phantomTradeId = 'phantom-ETHUSDT-9999';

    // Broker reporta una orden que no existe localmente
    const adapter = makeBrokerAdapter([
      { orderId: 'broker-99', clientOrderId: `${phantomTradeId}-sl` },
    ]);

    const { manager, broker } = makeManager({ adapter });
    await manager.start();

    // No hay posiciones locales

    await manager.syncWithBroker();

    const discrepancies = broker.published.filter(
      e => e.channel === 'SYSTEM_SYNC_DISCREPANCY'
    );
    expect(discrepancies).toHaveLength(1);
    expect(discrepancies[0].payload).toMatchObject({
      tradeId:    phantomTradeId,
      localState: null,
    });
  });

  test('el payload de SYSTEM_SYNC_DISCREPANCY incluye timestamp', async () => {
    const adapter = makeBrokerAdapter([]);

    const { manager, broker } = makeManager({ adapter });
    await manager.start();

    await broker.emit('EXECUTION_TRADE_OPENED', makeTradeOpenedPayload());
    await manager.syncWithBroker();

    const discrepancy = broker.published.find(
      e => e.channel === 'SYSTEM_SYNC_DISCREPANCY'
    );
    expect(discrepancy.payload.timestamp).toBe(FIXED_TS);
  });

  test('error de brokerAdapter.getOpenOrders no propaga', async () => {
    const adapter = makeBrokerAdapter();
    adapter.getOpenOrders = vi.fn(async () => {
      throw new Error('broker no disponible');
    });

    const { manager, broker } = makeManager({ adapter });
    await manager.start();

    await expect(manager.syncWithBroker()).resolves.not.toThrow();

    const discrepancies = broker.published.filter(
      e => e.channel === 'SYSTEM_SYNC_DISCREPANCY'
    );
    expect(discrepancies).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Ciclo de vida completo
// ---------------------------------------------------------------------------

describe('PositionManager — ciclo de vida completo', () => {
  test('abrir → mover SL → TP parcial → cerrar', async () => {
    const { manager, broker, repo } = makeManager();
    await manager.start();

    const tradeId = 'strat-a-BTCUSDT-1700000000000';

    // 1. Abrir
    await broker.emit('EXECUTION_TRADE_OPENED', makeTradeOpenedPayload({ tradeId }));
    expect(manager.getPosition(tradeId).status).toBe('OPEN');

    // 2. Mover SL
    await broker.emit('EXECUTION_SL_MOVED', {
      tradeId, oldSL: 29_700, newSL: 30_000, reason: 'breakeven', timestamp: FIXED_TS,
    });
    expect(manager.getPosition(tradeId).stopLoss).toBe(30_000);

    // 3. TP parcial
    await broker.emit('EXECUTION_PARTIAL_FILLED', {
      tradeId, tpLevel: 1, fillPrice: 30_600, remainingSize: 0.05, timestamp: FIXED_TS,
    });
    expect(manager.getPosition(tradeId).status).toBe('PARTIAL');
    expect(manager.getPosition(tradeId).size).toBe(0.05);

    // 4. Cerrar
    await broker.emit('EXECUTION_TRADE_CLOSED', {
      tradeId, exitPrice: 31_200, exitType: 'TP', pnl: 120, timestamp: FIXED_TS,
    });

    expect(manager.getOpenPositions()).toHaveLength(0);
    expect(manager.getPosition(tradeId)).toBeNull();

    // Verificar llamadas a BD
    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(repo.update).toHaveBeenCalledWith(tradeId, { stopLoss: 30_000 });
    expect(repo.update).toHaveBeenCalledWith(tradeId, { status: 'PARTIAL' });
    expect(repo.update).toHaveBeenCalledWith(
      tradeId,
      expect.objectContaining({ status: 'CLOSED', exitType: 'TP' })
    );
  });

  test('múltiples posiciones operan independientemente', async () => {
    const { manager, broker } = makeManager();
    await manager.start();

    const tradeA = 'strat-a-BTCUSDT-1700000000001';
    const tradeB = 'strat-b-ETHUSDT-1700000000002';

    await broker.emit('EXECUTION_TRADE_OPENED', makeTradeOpenedPayload({
      tradeId:   tradeA,
      symbol:    'BTCUSDT',
      entryPrice: 30_000,
      stopLoss:   29_700,
    }));

    await broker.emit('EXECUTION_TRADE_OPENED', makeTradeOpenedPayload({
      tradeId:    tradeB,
      symbol:     'ETHUSDT',
      strategyId: 'strat-b',
      entryPrice: 2_000,
      stopLoss:   1_970,
      takeProfits: [
        { price: 2_060, sizePercent: 50 },
        { price: 2_120, sizePercent: 50 },
      ],
    }));

    expect(manager.getOpenPositions()).toHaveLength(2);

    // Cerrar solo tradeA
    await broker.emit('EXECUTION_TRADE_CLOSED', {
      tradeId:   tradeA,
      exitPrice: 29_700,
      exitType:  'SL',
      pnl:       -30,
      timestamp: FIXED_TS,
    });

    expect(manager.getOpenPositions()).toHaveLength(1);
    expect(manager.getPosition(tradeA)).toBeNull();
    expect(manager.getPosition(tradeB)).not.toBeNull();
  });
});
