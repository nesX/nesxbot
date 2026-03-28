/**
 * ReplayProvider.unit.test.js
 *
 * Tests unitarios del ReplayProvider.
 * El repositorio se reemplaza por un doble en memoria.
 */

import ReplayProvider from '../ReplayProvider.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Crea un TimeProvider simulable: guarda el valor actual y permite avanzarlo */
function makeSimulatedTimeProvider(initialMs = 0) {
  let current = initialMs;
  return {
    now:     () => current,
    setTime: (ms) => { current = ms; },
    _getCurrent: () => current,
  };
}

function makeBroker() {
  const events = [];
  return {
    publish: vi.fn(async (channel, payload) => {
      events.push({ channel, payload });
    }),
    events,
  };
}

function makeLogger() {
  return {
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
  };
}

/** Genera una vela de prueba con openTime dado */
function candle(openTime, symbol = 'BTCUSDT', timeframe = '1m') {
  return {
    symbol,
    timeframe,
    openTime,
    open:     30000,
    high:     30500,
    low:      29900,
    close:    30200,
    volume:   100,
    isClosed: true,
  };
}

/** Crea un repositorio in-memory con las velas que se le proveen */
function makeRepository(candlesByRange) {
  return {
    getCandles: vi.fn(async (symbol, timeframe, from, to) => {
      return (candlesByRange || []).filter(
        c => c.symbol === symbol && c.timeframe === timeframe &&
             c.openTime >= from && c.openTime <= to
      );
    }),
  };
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe('ReplayProvider — constructor', () => {
  const validDeps = () => ({
    repository:    makeRepository([]),
    messageBroker: makeBroker(),
    timeProvider:  makeSimulatedTimeProvider(),
  });

  test('lanza si repository no se provee', () => {
    const deps = validDeps();
    delete deps.repository;
    expect(() => new ReplayProvider(deps)).toThrow('repository');
  });

  test('lanza si messageBroker no se provee', () => {
    const deps = validDeps();
    delete deps.messageBroker;
    expect(() => new ReplayProvider(deps)).toThrow('messageBroker');
  });

  test('lanza si timeProvider no se provee', () => {
    const deps = validDeps();
    delete deps.timeProvider;
    expect(() => new ReplayProvider(deps)).toThrow('timeProvider');
  });

  test('lanza si timeProvider no tiene setTime()', () => {
    const deps = validDeps();
    deps.timeProvider = { now: () => 0 }; // sin setTime
    expect(() => new ReplayProvider(deps)).toThrow('setTime');
  });

  test('se instancia correctamente con dependencias válidas', () => {
    expect(() => new ReplayProvider(validDeps())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// replay() — orden cronológico
// ---------------------------------------------------------------------------

describe('ReplayProvider.replay — orden cronológico', () => {
  test('emite eventos en orden cronológico estricto', async () => {
    const t1 = 1_000_000;
    const t2 = 2_000_000;
    const t3 = 3_000_000;

    const candles = [candle(t1), candle(t2), candle(t3)];
    const broker = makeBroker();
    const timeProvider = makeSimulatedTimeProvider();

    const replay = new ReplayProvider({
      repository:    makeRepository(candles),
      messageBroker: broker,
      timeProvider,
      logger:        makeLogger(),
    });

    await replay.replay('BTCUSDT', '1m', t1, t3);

    const emittedTimes = broker.events.map(e => e.payload.candle.openTime);
    expect(emittedTimes).toEqual([t1, t2, t3]);
  });

  test('devuelve la cantidad de eventos emitidos', async () => {
    const candles = [candle(1000), candle(2000), candle(3000)];
    const replay = new ReplayProvider({
      repository:    makeRepository(candles),
      messageBroker: makeBroker(),
      timeProvider:  makeSimulatedTimeProvider(),
      logger:        makeLogger(),
    });

    const count = await replay.replay('BTCUSDT', '1m', 1000, 3000);
    expect(count).toBe(3);
  });

  test('devuelve 0 si no hay velas en el rango', async () => {
    const replay = new ReplayProvider({
      repository:    makeRepository([]),
      messageBroker: makeBroker(),
      timeProvider:  makeSimulatedTimeProvider(),
      logger:        makeLogger(),
    });

    const count = await replay.replay('BTCUSDT', '1m', 1000, 2000);
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// replay() — TimeProvider avanza con cada vela
// ---------------------------------------------------------------------------

describe('ReplayProvider.replay — TimeProvider', () => {
  test('avanza el TimeProvider al openTime de cada vela antes de emitir', async () => {
    const t1 = 1_000_000;
    const t2 = 2_000_000;
    const t3 = 3_000_000;

    const candles = [candle(t1), candle(t2), candle(t3)];
    const timeProvider = makeSimulatedTimeProvider(0);
    const timesAtEmission = [];

    const broker = {
      publish: vi.fn(async (channel, payload) => {
        // Capturar el valor del TimeProvider en el momento de la emisión
        timesAtEmission.push(timeProvider.now());
      }),
    };

    const replay = new ReplayProvider({
      repository:    makeRepository(candles),
      messageBroker: broker,
      timeProvider,
      logger:        makeLogger(),
    });

    await replay.replay('BTCUSDT', '1m', t1, t3);

    expect(timesAtEmission).toEqual([t1, t2, t3]);
  });

  test('el timestamp del payload coincide con el openTime de la vela', async () => {
    const t1 = 1_600_000_000_000;
    const candles = [candle(t1)];
    const broker = makeBroker();

    const replay = new ReplayProvider({
      repository:    makeRepository(candles),
      messageBroker: broker,
      timeProvider:  makeSimulatedTimeProvider(0),
      logger:        makeLogger(),
    });

    await replay.replay('BTCUSDT', '1m', t1, t1);

    expect(broker.events[0].payload.timestamp).toBe(t1);
  });
});

// ---------------------------------------------------------------------------
// replay() — firma del payload (idéntica a DataProvider)
// ---------------------------------------------------------------------------

describe('ReplayProvider.replay — firma del payload', () => {
  test('emite en el canal MARKET_CANDLE_CLOSED', async () => {
    const t1 = 1_000_000;
    const broker = makeBroker();

    const replay = new ReplayProvider({
      repository:    makeRepository([candle(t1)]),
      messageBroker: broker,
      timeProvider:  makeSimulatedTimeProvider(),
      logger:        makeLogger(),
    });

    await replay.replay('BTCUSDT', '1m', t1, t1);

    expect(broker.events[0].channel).toBe('MARKET_CANDLE_CLOSED');
  });

  test('el payload contiene symbol, timeframe, timestamp y candle', async () => {
    const t1 = 1_000_000;
    const broker = makeBroker();

    const replay = new ReplayProvider({
      repository:    makeRepository([candle(t1, 'ETHUSDT', '15m')]),
      messageBroker: broker,
      timeProvider:  makeSimulatedTimeProvider(),
      logger:        makeLogger(),
    });

    await replay.replay('ETHUSDT', '15m', t1, t1);

    const { payload } = broker.events[0];
    expect(payload).toHaveProperty('symbol', 'ETHUSDT');
    expect(payload).toHaveProperty('timeframe', '15m');
    expect(payload).toHaveProperty('timestamp');
    expect(payload).toHaveProperty('candle');
    expect(payload.candle).toHaveProperty('openTime', t1);
  });
});

// ---------------------------------------------------------------------------
// replay() — validaciones de entrada
// ---------------------------------------------------------------------------

describe('ReplayProvider.replay — validaciones', () => {
  function makeReplay(candles = []) {
    return new ReplayProvider({
      repository:    makeRepository(candles),
      messageBroker: makeBroker(),
      timeProvider:  makeSimulatedTimeProvider(),
      logger:        makeLogger(),
    });
  }

  test('lanza si from > to', async () => {
    const replay = makeReplay();
    await expect(replay.replay('BTCUSDT', '1m', 2000, 1000)).rejects.toThrow('from');
  });

  test('lanza si from o to no son números', async () => {
    const replay = makeReplay();
    await expect(replay.replay('BTCUSDT', '1m', '2024-01-01', 2000)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// replayMulti() — orden cronológico global
// ---------------------------------------------------------------------------

describe('ReplayProvider.replayMulti', () => {
  test('intercala velas de múltiples símbolos en orden cronológico global', async () => {
    // BTC: t=1000, t=3000
    // ETH: t=2000, t=4000
    // Esperado: BTC(1000), ETH(2000), BTC(3000), ETH(4000)
    const allCandles = [
      candle(1000, 'BTCUSDT', '1m'),
      candle(3000, 'BTCUSDT', '1m'),
      candle(2000, 'ETHUSDT', '1m'),
      candle(4000, 'ETHUSDT', '1m'),
    ];

    const broker = makeBroker();

    const replay = new ReplayProvider({
      repository:    makeRepository(allCandles),
      messageBroker: broker,
      timeProvider:  makeSimulatedTimeProvider(),
      logger:        makeLogger(),
    });

    await replay.replayMulti(
      [{ symbol: 'BTCUSDT', timeframe: '1m' }, { symbol: 'ETHUSDT', timeframe: '1m' }],
      1000,
      4000
    );

    const order = broker.events.map(e => ({
      symbol:   e.payload.symbol,
      openTime: e.payload.candle.openTime,
    }));

    expect(order).toEqual([
      { symbol: 'BTCUSDT', openTime: 1000 },
      { symbol: 'ETHUSDT', openTime: 2000 },
      { symbol: 'BTCUSDT', openTime: 3000 },
      { symbol: 'ETHUSDT', openTime: 4000 },
    ]);
  });

  test('lanza si from > to', async () => {
    const replay = new ReplayProvider({
      repository:    makeRepository([]),
      messageBroker: makeBroker(),
      timeProvider:  makeSimulatedTimeProvider(),
      logger:        makeLogger(),
    });

    await expect(
      replay.replayMulti([{ symbol: 'BTCUSDT', timeframe: '1m' }], 5000, 1000)
    ).rejects.toThrow();
  });
});
