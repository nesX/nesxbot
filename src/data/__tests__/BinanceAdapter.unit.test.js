/**
 * BinanceAdapter.unit.test.js
 *
 * Tests unitarios del BinanceAdapter.
 * No realiza peticiones reales a Binance — usa dobles de prueba.
 */

import BinanceAdapter from '../BinanceAdapter.js';

// ---------------------------------------------------------------------------
// Helpers / Fixtures
// ---------------------------------------------------------------------------

function makeBroker() {
  const published = [];
  return {
    publish: vi.fn(async (channel, payload) => { published.push({ channel, payload }); }),
    published,
  };
}

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
 * Construye un BinanceAdapter con el método _restGet mockeado.
 */
function makeAdapter(restGetImpl) {
  const adapter = new BinanceAdapter({
    messageBroker: makeBroker(),
    timeProvider:  makeTimeProvider(),
    logger:        makeLogger(),
  });
  if (restGetImpl) {
    adapter._restGet = vi.fn(restGetImpl);
  }
  return adapter;
}

/** Genera un array kline crudo de Binance para tests */
function rawKline(openTime = 1_700_000_000_000) {
  return [
    openTime,        // openTime
    '30000.50',      // open
    '30500.00',      // high
    '29900.25',      // low
    '30200.75',      // close
    '123.456',       // volume
    openTime + 59999,
    '3000000',
    100,
    '60.0',
    '1800000',
    '0',
  ];
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe('BinanceAdapter — constructor', () => {
  test('lanza si messageBroker no se provee', () => {
    expect(() => new BinanceAdapter({ timeProvider: makeTimeProvider() }))
      .toThrow('messageBroker');
  });

  test('lanza si timeProvider no se provee', () => {
    expect(() => new BinanceAdapter({ messageBroker: makeBroker() }))
      .toThrow('timeProvider');
  });

  test('se instancia correctamente con dependencias mínimas', () => {
    expect(() => new BinanceAdapter({
      messageBroker: makeBroker(),
      timeProvider:  makeTimeProvider(),
    })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// fetchKlines (REST)
// ---------------------------------------------------------------------------

describe('BinanceAdapter.fetchKlines', () => {
  test('llama a _restGet con la ruta correcta', async () => {
    const rawKlines = [rawKline(1_000), rawKline(2_000), rawKline(3_000)];
    const adapter = makeAdapter(async () => rawKlines);

    await adapter.fetchKlines('BTCUSDT', '1m', 3);

    expect(adapter._restGet).toHaveBeenCalledTimes(1);
    const [path] = adapter._restGet.mock.calls[0];
    expect(path).toContain('symbol=BTCUSDT');
    expect(path).toContain('interval=1m');
    expect(path).toContain('limit=3');
  });

  test('devuelve array de Candle en formato interno', async () => {
    const t0 = 1_700_000_000_000;
    const adapter = makeAdapter(async () => [rawKline(t0)]);

    const candles = await adapter.fetchKlines('BTCUSDT', '1m', 1);

    expect(candles).toHaveLength(1);
    expect(candles[0]).toMatchObject({
      symbol:    'BTCUSDT',
      timeframe: '1m',
      openTime:  t0,
      open:      30000.50,
      high:      30500.00,
      low:       29900.25,
      close:     30200.75,
      volume:    123.456,
      isClosed:  true,
    });
  });

  test('propaga error de red desde _restGet', async () => {
    const adapter = makeAdapter(async () => { throw new Error('timeout'); });

    await expect(adapter.fetchKlines('BTCUSDT', '1m')).rejects.toThrow('timeout');
  });

  test('lanza con timeframe inválido antes de llamar a la red', async () => {
    const adapter = makeAdapter(async () => []);

    await expect(adapter.fetchKlines('BTCUSDT', 'INVALID')).rejects.toThrow('INVALID');
    expect(adapter._restGet).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// fetchKlinesByRange (REST)
// ---------------------------------------------------------------------------

describe('BinanceAdapter.fetchKlinesByRange', () => {
  test('incluye startTime y endTime en la ruta', async () => {
    const adapter = makeAdapter(async () => []);

    await adapter.fetchKlinesByRange('ETHUSDT', '15m', 1_000_000, 2_000_000);

    const [path] = adapter._restGet.mock.calls[0];
    expect(path).toContain('startTime=1000000');
    expect(path).toContain('endTime=2000000');
    expect(path).toContain('symbol=ETHUSDT');
    expect(path).toContain('interval=15m');
  });

  test('devuelve array vacío si la API responde []', async () => {
    const adapter = makeAdapter(async () => []);
    const result = await adapter.fetchKlinesByRange('BTCUSDT', '1h', 0, 1000);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// WebSocket — reconnection + SYSTEM_CRITICAL_ERROR
// ---------------------------------------------------------------------------

describe('BinanceAdapter WebSocket — reconexión', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeAdapterWithFakeWs() {
    const broker = makeBroker();
    const adapter = new BinanceAdapter({
      messageBroker: broker,
      timeProvider:  makeTimeProvider(),
      logger:        makeLogger(),
    });

    // Reemplazar _openWebSocket para controlar el ciclo de reconexión sin WS real
    const wsCloseCallbacks = [];
    adapter._openWebSocket = vi.fn(() => {
      // Simular que el WS se abre y luego se cierra
      const fakeClose = (code = 1006, reason = 'test') => {
        if (!adapter._wsDestroyed) {
          adapter._scheduleReconnect();
        }
      };
      wsCloseCallbacks.push(fakeClose);
    });

    return { adapter, broker, wsCloseCallbacks };
  }

  test('reintenta la conexión ante desconexión temporal', () => {
    const { adapter, wsCloseCallbacks } = makeAdapterWithFakeWs();

    adapter.connectWebSocket([{ symbol: 'BTCUSDT', timeframe: '1m' }], vi.fn());

    expect(adapter._openWebSocket).toHaveBeenCalledTimes(1);

    // Simular cierre inesperado
    adapter._scheduleReconnect();

    vi.advanceTimersByTime(1500); // superar el primer backoff (1s)
    expect(adapter._openWebSocket).toHaveBeenCalledTimes(2);
  });

  test('emite SYSTEM_CRITICAL_ERROR después de MAX_RETRIES intentos', () => {
    const { adapter, broker } = makeAdapterWithFakeWs();

    adapter.connectWebSocket([{ symbol: 'BTCUSDT', timeframe: '1m' }], vi.fn());

    // Simular WS_MAX_RETRIES + 1 desconexiones
    for (let i = 0; i <= 5; i++) {
      adapter._wsRetries = i;
      adapter._wsReconnecting = false;
      adapter._scheduleReconnect();
      vi.advanceTimersByTime(70_000); // avanzar tiempo suficiente
    }

    expect(broker.publish).toHaveBeenCalledWith(
      'SYSTEM_CRITICAL_ERROR',
      expect.objectContaining({
        source:      'DataProvider',
        recoverable: false,
      })
    );
  });

  test('disconnectWebSocket detiene la reconexión', () => {
    const { adapter } = makeAdapterWithFakeWs();

    adapter.connectWebSocket([{ symbol: 'BTCUSDT', timeframe: '1m' }], vi.fn());
    adapter.disconnectWebSocket();

    adapter._scheduleReconnect(); // no debería programar nada
    vi.advanceTimersByTime(70_000);

    // Solo el primer _openWebSocket del connectWebSocket
    expect(adapter._openWebSocket).toHaveBeenCalledTimes(1);
  });

  test('backoff exponencial: el delay crece con cada reintento', () => {
    const delays = [];
    const { adapter } = makeAdapterWithFakeWs();

    // Interceptar setTimeout para capturar los delays
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = vi.fn((fn, delay) => {
      delays.push(delay);
      return originalSetTimeout(fn, delay);
    });

    adapter.connectWebSocket([{ symbol: 'BTCUSDT', timeframe: '1m' }], vi.fn());

    for (let i = 1; i <= 3; i++) {
      adapter._wsRetries      = i - 1;
      adapter._wsReconnecting = false;
      adapter._scheduleReconnect();
    }

    global.setTimeout = originalSetTimeout;

    // Los delays deben ser crecientes
    expect(delays[0]).toBeLessThan(delays[1]);
    expect(delays[1]).toBeLessThan(delays[2]);
  });
});

// ---------------------------------------------------------------------------
// WebSocket — procesamiento de mensajes
// ---------------------------------------------------------------------------

describe('BinanceAdapter WebSocket — manejo de mensajes', () => {
  function makeAdapterWithMessageCapture() {
    const broker = makeBroker();
    const adapter = new BinanceAdapter({
      messageBroker: broker,
      timeProvider:  makeTimeProvider(),
      logger:        makeLogger(),
    });
    return { adapter, broker };
  }

  test('_handleWsMessage llama al handler con vela cerrada', () => {
    const { adapter } = makeAdapterWithMessageCapture();
    const handler = vi.fn();
    adapter._candleHandler = handler;

    const wsEvent = JSON.stringify({
      stream: 'btcusdt@kline_1m',
      data: {
        e: 'kline',
        k: {
          s: 'BTCUSDT',
          i: '1m',
          t: 1_700_000_000_000,
          o: '30000.00',
          h: '30500.00',
          l: '29900.00',
          c: '30200.00',
          v: '100.0',
          x: true,  // vela cerrada
        },
      },
    });

    adapter._handleWsMessage(wsEvent);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({
      symbol:    'BTCUSDT',
      timeframe: '1m',
      isClosed:  true,
    });
  });

  test('_handleWsMessage llama al handler con vela abierta (isClosed=false)', () => {
    const { adapter } = makeAdapterWithMessageCapture();
    const handler = vi.fn();
    adapter._candleHandler = handler;

    const wsEvent = JSON.stringify({
      stream: 'btcusdt@kline_1m',
      data: {
        e: 'kline',
        k: {
          s: 'BTCUSDT',
          i: '1m',
          t: 1_700_000_000_000,
          o: '30000.00',
          h: '30100.00',
          l: '29950.00',
          c: '30050.00',
          v: '50.0',
          x: false, // vela en progreso
        },
      },
    });

    adapter._handleWsMessage(wsEvent);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].isClosed).toBe(false);
  });

  test('_handleWsMessage ignora mensajes no-kline', () => {
    const { adapter } = makeAdapterWithMessageCapture();
    const handler = vi.fn();
    adapter._candleHandler = handler;

    adapter._handleWsMessage(JSON.stringify({ e: 'trade', p: '30000' }));
    adapter._handleWsMessage(JSON.stringify({ stream: 'btcusdt@depth', data: {} }));

    expect(handler).not.toHaveBeenCalled();
  });

  test('_handleWsMessage no lanza ante JSON inválido', () => {
    const { adapter } = makeAdapterWithMessageCapture();
    adapter._candleHandler = vi.fn();

    expect(() => adapter._handleWsMessage('esto no es json')).not.toThrow();
    expect(adapter._candleHandler).not.toHaveBeenCalled();
  });
});
