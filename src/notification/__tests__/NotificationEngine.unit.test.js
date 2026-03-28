/**
 * NotificationEngine.unit.test.js
 *
 * Tests unitarios del modulo Notification Engine.
 * Todas las dependencias externas se reemplazan por dobles de prueba.
 *
 * Casos cubiertos:
 *
 * Constructor:
 *   - Lanza si messageBroker no se provee
 *   - Lanza si timeProvider no se provee
 *   - Se instancia correctamente con las dependencias minimas
 *
 * start / stop:
 *   - start() suscribe al broker por cada evento del catalogo
 *   - start() duplicado no suscribe dos veces
 *   - stop() hace que los eventos entrantes sean ignorados
 *   - stop() limpia el estado de throttling
 *
 * addChannel:
 *   - Lanza si el canal no implementa send()
 *   - Acepta multiples canales
 *   - Se puede agregar canales antes y despues de start()
 *
 * Enrutamiento de eventos:
 *   - EXECUTION_TRADE_OPENED   → llama send() en todos los canales con level 'info'
 *   - EXECUTION_TRADE_CLOSED   → llama send() con el PnL formateado
 *   - EXECUTION_SL_MOVED       → llama send() con los precios de SL
 *   - STRATEGY_SIGNAL_GENERATED → llama send() con la senal
 *   - EXECUTION_SIGNAL_REJECTED → llama send() con level 'warn'
 *   - SYSTEM_CRITICAL_ERROR    → llama send() con level 'error'
 *   - SYSTEM_SYNC_DISCREPANCY  → llama send() con level 'warn'
 *
 * Throttling:
 *   - El mismo tipo de evento no genera dos notificaciones dentro del intervalo
 *   - Despues de que el intervalo expira, el evento vuelve a notificar
 *   - throttle: 0 desactiva el throttling para ese evento
 *   - Eventos de distinto tipo no se bloquean mutuamente
 *
 * Aislamiento de fallos de canales:
 *   - Un canal que lanza no impide que el otro canal reciba el mensaje
 *   - El fallo de canal se loggea pero no propaga ni emite SYSTEM_CRITICAL_ERROR
 *
 * Sin canales registrados:
 *   - No lanza — solo loggea una advertencia
 */

import NotificationEngine from '../NotificationEngine.js';
import ConsoleChannel     from '../channels/ConsoleChannel.js';
import TelegramChannel    from '../channels/TelegramChannel.js';
import * as TradeFormatter from '../formatters/TradeFormatter.js';
import * as ErrorFormatter from '../formatters/ErrorFormatter.js';

// ---------------------------------------------------------------------------
// Helpers / Factories
// ---------------------------------------------------------------------------

const FIXED_TS = 1_700_000_000_000;

function makeTimeProvider(fixedMs = FIXED_TS) {
  return { now: vi.fn(() => fixedMs) };
}

function makeBroker() {
  const subscribers = {};

  return {
    subscribe: vi.fn((event, handler) => {
      subscribers[event] = handler;
    }),
    // Simula la llegada de un evento
    emit: async (event, payload) => {
      if (subscribers[event]) {
        await subscribers[event](payload);
      }
    },
    subscribers,
  };
}

function makeLogger() {
  return {
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
  };
}

/** Canal de prueba que registra los mensajes recibidos */
function makeChannel(opts = {}) {
  return {
    send: vi.fn(opts.impl || (async () => {})),
    constructor: { name: opts.name || 'TestChannel' },
  };
}

/** Construye el engine con defaults de prueba */
function makeEngine(opts = {}) {
  const timeProvider = opts.timeProvider || makeTimeProvider();
  const broker       = opts.broker       || makeBroker();
  const logger       = opts.logger       || makeLogger();
  const throttle     = opts.throttle     || {};

  const engine = new NotificationEngine({
    messageBroker: broker,
    timeProvider,
    throttle,
    logger,
  });

  return { engine, broker, timeProvider, logger };
}

// Payloads de ejemplo para cada evento

const PAYLOAD_TRADE_OPENED = {
  tradeId:     'strat-a-BTCUSDT-1700000000000',
  symbol:      'BTCUSDT',
  direction:   'LONG',
  entryPrice:  30_000,
  size:        0.033,
  stopLoss:    29_700,
  takeProfits: [
    { price: 30_600, sizePercent: 50 },
    { price: 31_200, sizePercent: 50 },
  ],
  timestamp:   FIXED_TS,
};

const PAYLOAD_TRADE_CLOSED = {
  tradeId:    'strat-a-BTCUSDT-1700000000000',
  exitPrice:  30_600,
  exitType:   'TP',
  pnl:        19.8,
  timestamp:  FIXED_TS,
};

const PAYLOAD_SL_MOVED = {
  tradeId: 'strat-a-BTCUSDT-1700000000000',
  oldSL:   29_700,
  newSL:   30_000,
  reason:  'breakeven',
  timestamp: FIXED_TS,
};

const PAYLOAD_SIGNAL_GENERATED = {
  tradePlan: {
    strategyId: 'fib-v1',
    symbol:     'BTCUSDT',
    direction:  'LONG',
    entryPrice: 30_000,
  },
};

const PAYLOAD_SIGNAL_REJECTED = {
  strategyId: 'fib-v1',
  symbol:     'BTCUSDT',
  reason:     'exposicion maxima alcanzada',
  timestamp:  FIXED_TS,
};

const PAYLOAD_CRITICAL_ERROR = {
  source:      'ExecutionEngine',
  error:       'insufficient balance',
  symbol:      'BTCUSDT',
  recoverable: false,
  timestamp:   FIXED_TS,
};

const PAYLOAD_SYNC_DISCREPANCY = {
  tradeId:     'strat-a-BTCUSDT-1700000000000',
  reason:      'posicion local sin ordenes en el broker',
  localState:  { symbol: 'BTCUSDT', direction: 'LONG', entryPrice: 30_000 },
  brokerState: null,
  timestamp:   FIXED_TS,
};

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe('NotificationEngine — constructor', () => {
  test('lanza si messageBroker no se provee', () => {
    expect(() => new NotificationEngine({
      timeProvider: makeTimeProvider(),
    })).toThrow('messageBroker');
  });

  test('lanza si timeProvider no se provee', () => {
    expect(() => new NotificationEngine({
      messageBroker: makeBroker(),
    })).toThrow('timeProvider');
  });

  test('se instancia correctamente con las dependencias minimas', () => {
    expect(() => new NotificationEngine({
      messageBroker: makeBroker(),
      timeProvider:  makeTimeProvider(),
    })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// start / stop
// ---------------------------------------------------------------------------

describe('NotificationEngine — start / stop', () => {
  test('start() suscribe al broker por cada evento del catalogo', () => {
    const { engine, broker } = makeEngine();
    engine.start();

    const expectedEvents = [
      'STRATEGY_SIGNAL_GENERATED',
      'STRATEGY_ZONE_ARMED',
      'STRATEGY_ZONE_DISARMED',
      'EXECUTION_TRADE_OPENED',
      'EXECUTION_TRADE_CLOSED',
      'EXECUTION_SL_MOVED',
      'EXECUTION_SIGNAL_REJECTED',
      'SYSTEM_CRITICAL_ERROR',
      'SYSTEM_SYNC_DISCREPANCY',
    ];

    for (const event of expectedEvents) {
      expect(broker.subscribe).toHaveBeenCalledWith(event, expect.any(Function));
    }
  });

  test('start() duplicado no suscribe dos veces', () => {
    const { engine, broker } = makeEngine();
    engine.start();
    engine.start();

    // 9 eventos en el catalogo → exactamente 9 suscripciones
    expect(broker.subscribe).toHaveBeenCalledTimes(9);
  });

  test('stop() hace que los eventos entrantes sean ignorados', async () => {
    const { engine, broker } = makeEngine();
    const channel = makeChannel();
    engine.addChannel(channel);
    engine.start();
    engine.stop();

    await broker.emit('EXECUTION_TRADE_OPENED', PAYLOAD_TRADE_OPENED);

    expect(channel.send).not.toHaveBeenCalled();
  });

  test('stop() limpia el estado de throttling y permite reiniciar contadores', async () => {
    // throttle de 60s para EXECUTION_TRADE_OPENED
    const timeProvider = makeTimeProvider(FIXED_TS);
    const { engine, broker } = makeEngine({ timeProvider, throttle: { EXECUTION_TRADE_OPENED: 60_000 } });
    const channel = makeChannel();
    engine.addChannel(channel);
    engine.start();

    // Primer evento — se envia
    await broker.emit('EXECUTION_TRADE_OPENED', PAYLOAD_TRADE_OPENED);
    expect(channel.send).toHaveBeenCalledTimes(1);

    // Segundo evento dentro del throttle — suprimido
    await broker.emit('EXECUTION_TRADE_OPENED', PAYLOAD_TRADE_OPENED);
    expect(channel.send).toHaveBeenCalledTimes(1);

    // stop() limpia los contadores
    engine.stop();
    engine.start();

    // Evento de nuevo — se envia porque el estado fue limpiado
    await broker.emit('EXECUTION_TRADE_OPENED', PAYLOAD_TRADE_OPENED);
    expect(channel.send).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// addChannel
// ---------------------------------------------------------------------------

describe('NotificationEngine — addChannel', () => {
  test('lanza si el canal no implementa send()', () => {
    const { engine } = makeEngine();
    expect(() => engine.addChannel({ noSend: true })).toThrow('send');
  });

  test('lanza si se pasa null', () => {
    const { engine } = makeEngine();
    expect(() => engine.addChannel(null)).toThrow();
  });

  test('acepta multiples canales', () => {
    const { engine } = makeEngine();
    expect(() => {
      engine.addChannel(makeChannel({ name: 'C1' }));
      engine.addChannel(makeChannel({ name: 'C2' }));
      engine.addChannel(makeChannel({ name: 'C3' }));
    }).not.toThrow();
  });

  test('se puede agregar canales antes de start()', async () => {
    const { engine, broker } = makeEngine();
    const channel = makeChannel();
    engine.addChannel(channel);
    engine.start();

    await broker.emit('EXECUTION_TRADE_OPENED', PAYLOAD_TRADE_OPENED);

    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  test('se puede agregar canales despues de start()', async () => {
    const { engine, broker } = makeEngine();
    engine.start();
    const channel = makeChannel();
    engine.addChannel(channel);

    await broker.emit('EXECUTION_TRADE_OPENED', PAYLOAD_TRADE_OPENED);

    expect(channel.send).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Enrutamiento de eventos
// ---------------------------------------------------------------------------

describe('NotificationEngine — enrutamiento de eventos', () => {
  async function emitAndCapture(event, payload, opts = {}) {
    const { engine, broker } = makeEngine({
      throttle: { [event]: 0 }, // deshabilitar throttling para el test
      ...opts,
    });
    const channel = makeChannel();
    engine.addChannel(channel);
    engine.start();

    await broker.emit(event, payload);

    return channel.send.mock.calls;
  }

  test('EXECUTION_TRADE_OPENED → send() con level "info" y texto que menciona el simbolo', async () => {
    const calls = await emitAndCapture('EXECUTION_TRADE_OPENED', PAYLOAD_TRADE_OPENED);

    expect(calls).toHaveLength(1);
    const msg = calls[0][0];
    expect(msg.level).toBe('info');
    expect(msg.text).toContain('BTCUSDT');
    expect(msg.text).toContain('LONG');
  });

  test('EXECUTION_TRADE_CLOSED → send() con el PnL en el texto', async () => {
    const calls = await emitAndCapture('EXECUTION_TRADE_CLOSED', PAYLOAD_TRADE_CLOSED);

    expect(calls).toHaveLength(1);
    const msg = calls[0][0];
    expect(msg.level).toBe('info');
    expect(msg.text).toContain('19.8');
  });

  test('EXECUTION_TRADE_CLOSED con PnL negativo → texto con signo negativo', async () => {
    const calls = await emitAndCapture('EXECUTION_TRADE_CLOSED', {
      ...PAYLOAD_TRADE_CLOSED,
      exitType: 'SL',
      pnl:      -50.25,
    });

    const msg = calls[0][0];
    expect(msg.text).toContain('-50.25');
  });

  test('EXECUTION_SL_MOVED → send() con precio anterior y nuevo', async () => {
    const calls = await emitAndCapture('EXECUTION_SL_MOVED', PAYLOAD_SL_MOVED);

    expect(calls).toHaveLength(1);
    const msg = calls[0][0];
    expect(msg.text).toContain('29,700.00');
    expect(msg.text).toContain('30,000.00');
  });

  test('STRATEGY_SIGNAL_GENERATED → send() con level "info"', async () => {
    const calls = await emitAndCapture('STRATEGY_SIGNAL_GENERATED', PAYLOAD_SIGNAL_GENERATED);

    expect(calls).toHaveLength(1);
    const msg = calls[0][0];
    expect(msg.level).toBe('info');
    expect(msg.text).toContain('BTCUSDT');
  });

  test('EXECUTION_SIGNAL_REJECTED → send() con level "warn"', async () => {
    const calls = await emitAndCapture('EXECUTION_SIGNAL_REJECTED', PAYLOAD_SIGNAL_REJECTED);

    expect(calls).toHaveLength(1);
    const msg = calls[0][0];
    expect(msg.level).toBe('warn');
    expect(msg.text).toContain('fib-v1');
  });

  test('SYSTEM_CRITICAL_ERROR → send() con level "error"', async () => {
    const calls = await emitAndCapture('SYSTEM_CRITICAL_ERROR', PAYLOAD_CRITICAL_ERROR);

    expect(calls).toHaveLength(1);
    const msg = calls[0][0];
    expect(msg.level).toBe('error');
    expect(msg.text).toContain('ExecutionEngine');
    expect(msg.text).toContain('insufficient balance');
  });

  test('SYSTEM_SYNC_DISCREPANCY → send() con level "warn"', async () => {
    const calls = await emitAndCapture('SYSTEM_SYNC_DISCREPANCY', PAYLOAD_SYNC_DISCREPANCY);

    expect(calls).toHaveLength(1);
    const msg = calls[0][0];
    expect(msg.level).toBe('warn');
    expect(msg.text).toContain(PAYLOAD_SYNC_DISCREPANCY.tradeId);
  });

  test('evento con dos canales → ambos reciben el mensaje', async () => {
    const { engine, broker } = makeEngine({ throttle: { EXECUTION_TRADE_OPENED: 0 } });
    const ch1 = makeChannel({ name: 'C1' });
    const ch2 = makeChannel({ name: 'C2' });
    engine.addChannel(ch1);
    engine.addChannel(ch2);
    engine.start();

    await broker.emit('EXECUTION_TRADE_OPENED', PAYLOAD_TRADE_OPENED);

    expect(ch1.send).toHaveBeenCalledTimes(1);
    expect(ch2.send).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Throttling
// ---------------------------------------------------------------------------

describe('NotificationEngine — throttling', () => {
  test('el mismo evento no genera dos notificaciones dentro del intervalo', async () => {
    const timeProvider = makeTimeProvider(FIXED_TS);
    const { engine, broker } = makeEngine({
      timeProvider,
      throttle: { EXECUTION_TRADE_OPENED: 60_000 },
    });
    const channel = makeChannel();
    engine.addChannel(channel);
    engine.start();

    // Primer evento — dentro del window, se envia
    await broker.emit('EXECUTION_TRADE_OPENED', PAYLOAD_TRADE_OPENED);
    // Segundo evento — mismo timestamp, throttled
    await broker.emit('EXECUTION_TRADE_OPENED', PAYLOAD_TRADE_OPENED);

    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  test('despues del intervalo de throttle, el evento vuelve a notificar', async () => {
    let currentTs = FIXED_TS;
    const timeProvider = { now: vi.fn(() => currentTs) };
    const { engine, broker } = makeEngine({
      timeProvider,
      throttle: { EXECUTION_TRADE_OPENED: 60_000 },
    });
    const channel = makeChannel();
    engine.addChannel(channel);
    engine.start();

    // Primer evento
    await broker.emit('EXECUTION_TRADE_OPENED', PAYLOAD_TRADE_OPENED);
    expect(channel.send).toHaveBeenCalledTimes(1);

    // Avanzar el tiempo 61 segundos
    currentTs = FIXED_TS + 61_000;

    // Segundo evento — fuera del throttle
    await broker.emit('EXECUTION_TRADE_OPENED', PAYLOAD_TRADE_OPENED);
    expect(channel.send).toHaveBeenCalledTimes(2);
  });

  test('throttle: 0 desactiva el throttling para ese evento', async () => {
    const timeProvider = makeTimeProvider(FIXED_TS);
    const { engine, broker } = makeEngine({
      timeProvider,
      throttle: { EXECUTION_TRADE_OPENED: 0 },
    });
    const channel = makeChannel();
    engine.addChannel(channel);
    engine.start();

    await broker.emit('EXECUTION_TRADE_OPENED', PAYLOAD_TRADE_OPENED);
    await broker.emit('EXECUTION_TRADE_OPENED', PAYLOAD_TRADE_OPENED);
    await broker.emit('EXECUTION_TRADE_OPENED', PAYLOAD_TRADE_OPENED);

    expect(channel.send).toHaveBeenCalledTimes(3);
  });

  test('eventos de distinto tipo no se bloquean mutuamente por throttling', async () => {
    const timeProvider = makeTimeProvider(FIXED_TS);
    const { engine, broker } = makeEngine({
      timeProvider,
      throttle: {
        EXECUTION_TRADE_OPENED: 60_000,
        EXECUTION_TRADE_CLOSED: 60_000,
      },
    });
    const channel = makeChannel();
    engine.addChannel(channel);
    engine.start();

    await broker.emit('EXECUTION_TRADE_OPENED', PAYLOAD_TRADE_OPENED);
    await broker.emit('EXECUTION_TRADE_CLOSED', PAYLOAD_TRADE_CLOSED);

    // Ambos deben haberse enviado — son tipos distintos
    expect(channel.send).toHaveBeenCalledTimes(2);
  });

  test('el throttle por defecto es de 60 segundos para eventos no configurados', async () => {
    let currentTs = FIXED_TS;
    const timeProvider = { now: vi.fn(() => currentTs) };
    // Sin configuracion de throttle → se aplica el default de 60s
    const { engine, broker } = makeEngine({ timeProvider, throttle: {} });
    const channel = makeChannel();
    engine.addChannel(channel);
    engine.start();

    // Primer evento
    await broker.emit('EXECUTION_TRADE_OPENED', PAYLOAD_TRADE_OPENED);
    expect(channel.send).toHaveBeenCalledTimes(1);

    // Segundo evento a los 30s — suprimido por default throttle
    currentTs = FIXED_TS + 30_000;
    await broker.emit('EXECUTION_TRADE_OPENED', PAYLOAD_TRADE_OPENED);
    expect(channel.send).toHaveBeenCalledTimes(1);

    // Tercer evento a los 61s — ya paso el throttle
    currentTs = FIXED_TS + 61_000;
    await broker.emit('EXECUTION_TRADE_OPENED', PAYLOAD_TRADE_OPENED);
    expect(channel.send).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Aislamiento de fallos de canales
// ---------------------------------------------------------------------------

describe('NotificationEngine — aislamiento de fallos de canales', () => {
  test('un canal que lanza no impide que el otro canal reciba el mensaje', async () => {
    const { engine, broker } = makeEngine({ throttle: { EXECUTION_TRADE_OPENED: 0 } });
    const logger = makeLogger();
    engine._logger = logger;

    const brokenChannel = makeChannel({
      name: 'Broken',
      impl: async () => { throw new Error('fallo de red simulado'); },
    });
    const goodChannel = makeChannel({ name: 'Good' });

    engine.addChannel(brokenChannel);
    engine.addChannel(goodChannel);
    engine.start();

    await broker.emit('EXECUTION_TRADE_OPENED', PAYLOAD_TRADE_OPENED);

    // El canal bueno SI recibio el mensaje
    expect(goodChannel.send).toHaveBeenCalledTimes(1);
  });

  test('el fallo de canal se loggea como error', async () => {
    const logger = makeLogger();
    const { engine, broker } = makeEngine({
      throttle: { EXECUTION_TRADE_OPENED: 0 },
      logger,
    });

    const brokenChannel = makeChannel({
      name: 'BrokenChannel',
      impl: async () => { throw new Error('connexion refused'); },
    });
    engine.addChannel(brokenChannel);
    engine.start();

    await broker.emit('EXECUTION_TRADE_OPENED', PAYLOAD_TRADE_OPENED);

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('fallo al enviar notificacion')
    );
  });

  test('el fallo de canal no propaga al broker ni lanza en el caller', async () => {
    const { engine, broker } = makeEngine({ throttle: { EXECUTION_TRADE_OPENED: 0 } });
    const brokenChannel = makeChannel({
      impl: async () => { throw new Error('crash'); },
    });
    engine.addChannel(brokenChannel);
    engine.start();

    await expect(
      broker.emit('EXECUTION_TRADE_OPENED', PAYLOAD_TRADE_OPENED)
    ).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Sin canales registrados
// ---------------------------------------------------------------------------

describe('NotificationEngine — sin canales registrados', () => {
  test('no lanza cuando no hay canales y llega un evento', async () => {
    const { engine, broker } = makeEngine({ throttle: { EXECUTION_TRADE_OPENED: 0 } });
    engine.start();

    await expect(
      broker.emit('EXECUTION_TRADE_OPENED', PAYLOAD_TRADE_OPENED)
    ).resolves.not.toThrow();
  });

  test('loggea advertencia cuando no hay canales', async () => {
    const logger = makeLogger();
    const { engine, broker } = makeEngine({
      throttle: { EXECUTION_TRADE_OPENED: 0 },
      logger,
    });
    engine.start();

    await broker.emit('EXECUTION_TRADE_OPENED', PAYLOAD_TRADE_OPENED);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no hay canales registrados')
    );
  });
});

// ---------------------------------------------------------------------------
// ConsoleChannel
// ---------------------------------------------------------------------------

describe('ConsoleChannel', () => {
  let consoleSpy;

  beforeEach(() => {
    consoleSpy = {
      log:   vi.spyOn(console, 'log').mockImplementation(() => {}),
      warn:  vi.spyOn(console, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    consoleSpy.log.mockRestore();
    consoleSpy.warn.mockRestore();
    consoleSpy.error.mockRestore();
  });

  test('send() con level "info" llama console.log', async () => {
    const ch = new ConsoleChannel({ timeProvider: makeTimeProvider() });
    await ch.send({ text: 'hola mundo', level: 'info' });
    expect(consoleSpy.log).toHaveBeenCalledWith(expect.stringContaining('hola mundo'));
  });

  test('send() con level "warn" llama console.warn', async () => {
    const ch = new ConsoleChannel({ timeProvider: makeTimeProvider() });
    await ch.send({ text: 'advertencia', level: 'warn' });
    expect(consoleSpy.warn).toHaveBeenCalledWith(expect.stringContaining('advertencia'));
  });

  test('send() con level "error" llama console.error', async () => {
    const ch = new ConsoleChannel({ timeProvider: makeTimeProvider() });
    await ch.send({ text: 'error critico', level: 'error' });
    expect(consoleSpy.error).toHaveBeenCalledWith(expect.stringContaining('error critico'));
  });

  test('el prefijo incluye el nivel y la marca de tiempo', async () => {
    const ch = new ConsoleChannel({ timeProvider: makeTimeProvider(FIXED_TS) });
    await ch.send({ text: 'msg', level: 'info' });
    const call = consoleSpy.log.mock.calls[0][0];
    expect(call).toContain('[NOTIFICATION]');
    expect(call).toContain('[INFO]');
    // La marca de tiempo ISO debe estar presente
    expect(call).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  test('funciona sin timeProvider (usa Date interno)', async () => {
    const ch = new ConsoleChannel();
    await expect(ch.send({ text: 'sin tp', level: 'info' })).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// TelegramChannel — constructor
// ---------------------------------------------------------------------------

describe('TelegramChannel — constructor', () => {
  test('lanza si botToken no se provee', () => {
    expect(() => new TelegramChannel({ chatId: '123' })).toThrow('botToken');
  });

  test('lanza si chatId no se provee', () => {
    expect(() => new TelegramChannel({ botToken: 'abc:def' })).toThrow('chatId');
  });

  test('se instancia correctamente con botToken y chatId', () => {
    expect(() => new TelegramChannel({
      botToken: '123456:ABC-DEF',
      chatId:   '-100123456789',
    })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// TradeFormatter
// ---------------------------------------------------------------------------

describe('TradeFormatter', () => {
  const { formatTradeOpened, formatTradeClosed, formatSLMoved, formatSignalGenerated, formatSignalRejected } =
    TradeFormatter;

  describe('formatTradeOpened', () => {
    test('incluye simbolo, direccion y precio de entrada', () => {
      const text = formatTradeOpened(PAYLOAD_TRADE_OPENED);
      expect(text).toContain('BTCUSDT');
      expect(text).toContain('LONG');
      expect(text).toContain('30,000.00');
    });

    test('incluye SL y TPs cuando estan presentes', () => {
      const text = formatTradeOpened(PAYLOAD_TRADE_OPENED);
      expect(text).toContain('29,700.00');
      expect(text).toContain('TP1');
      expect(text).toContain('TP2');
    });

    test('incluye el tradeId', () => {
      const text = formatTradeOpened(PAYLOAD_TRADE_OPENED);
      expect(text).toContain(PAYLOAD_TRADE_OPENED.tradeId);
    });

    test('funciona sin takeProfits opcionales', () => {
      const text = formatTradeOpened({ ...PAYLOAD_TRADE_OPENED, takeProfits: undefined });
      expect(text).toContain('BTCUSDT');
    });
  });

  describe('formatTradeClosed', () => {
    test('incluye tipo de salida y precio', () => {
      const text = formatTradeClosed(PAYLOAD_TRADE_CLOSED);
      expect(text).toContain('Take Profit');
      expect(text).toContain('30,600.00');
    });

    test('incluye PnL con signo positivo', () => {
      const text = formatTradeClosed({ ...PAYLOAD_TRADE_CLOSED, pnl: 50 });
      expect(text).toContain('+50');
    });

    test('incluye PnL con signo negativo', () => {
      const text = formatTradeClosed({ ...PAYLOAD_TRADE_CLOSED, exitType: 'SL', pnl: -30 });
      expect(text).toContain('-30');
      expect(text).toContain('Stop Loss');
    });

    test('funciona sin PnL', () => {
      const { pnl, ...withoutPnL } = PAYLOAD_TRADE_CLOSED;
      expect(() => formatTradeClosed(withoutPnL)).not.toThrow();
    });
  });

  describe('formatSLMoved', () => {
    test('incluye precios anterior y nuevo', () => {
      const text = formatSLMoved(PAYLOAD_SL_MOVED);
      expect(text).toContain('29,700.00');
      expect(text).toContain('30,000.00');
    });

    test('incluye la razon del movimiento', () => {
      const text = formatSLMoved(PAYLOAD_SL_MOVED);
      expect(text).toContain('breakeven');
    });

    test('indica si el SL subio', () => {
      const text = formatSLMoved({ ...PAYLOAD_SL_MOVED, oldSL: 29_700, newSL: 30_000 });
      expect(text).toContain('subio');
    });

    test('indica si el SL bajo', () => {
      const text = formatSLMoved({ ...PAYLOAD_SL_MOVED, oldSL: 31_000, newSL: 30_000 });
      expect(text).toContain('bajo');
    });
  });

  describe('formatSignalGenerated', () => {
    test('incluye simbolo, direccion y strategyId', () => {
      const text = formatSignalGenerated(PAYLOAD_SIGNAL_GENERATED);
      expect(text).toContain('BTCUSDT');
      expect(text).toContain('LONG');
      expect(text).toContain('fib-v1');
    });

    test('maneja payload sin tradePlan', () => {
      const text = formatSignalGenerated({});
      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);
    });
  });

  describe('formatSignalRejected', () => {
    test('incluye strategyId, simbolo y razon', () => {
      const text = formatSignalRejected(PAYLOAD_SIGNAL_REJECTED);
      expect(text).toContain('fib-v1');
      expect(text).toContain('BTCUSDT');
      expect(text).toContain('exposicion maxima alcanzada');
    });
  });
});

// ---------------------------------------------------------------------------
// ErrorFormatter
// ---------------------------------------------------------------------------

describe('ErrorFormatter', () => {
  const { formatCriticalError, formatSyncDiscrepancy } = ErrorFormatter;

  describe('formatCriticalError', () => {
    test('incluye el modulo fuente y el mensaje de error', () => {
      const text = formatCriticalError(PAYLOAD_CRITICAL_ERROR);
      expect(text).toContain('ExecutionEngine');
      expect(text).toContain('insufficient balance');
    });

    test('indica si el error NO es recuperable', () => {
      const text = formatCriticalError({ ...PAYLOAD_CRITICAL_ERROR, recoverable: false });
      expect(text).toContain('NO recuperable');
    });

    test('indica si el error es recuperable', () => {
      const text = formatCriticalError({ ...PAYLOAD_CRITICAL_ERROR, recoverable: true });
      expect(text).toContain('recuperable');
    });

    test('incluye el simbolo si esta presente', () => {
      const text = formatCriticalError(PAYLOAD_CRITICAL_ERROR);
      expect(text).toContain('BTCUSDT');
    });

    test('funciona sin campo opcional symbol', () => {
      const { symbol, ...withoutSymbol } = PAYLOAD_CRITICAL_ERROR;
      expect(() => formatCriticalError(withoutSymbol)).not.toThrow();
    });
  });

  describe('formatSyncDiscrepancy', () => {
    test('incluye el tradeId y la razon', () => {
      const text = formatSyncDiscrepancy(PAYLOAD_SYNC_DISCREPANCY);
      expect(text).toContain(PAYLOAD_SYNC_DISCREPANCY.tradeId);
      expect(text).toContain('posicion local sin ordenes en el broker');
    });

    test('describe que el broker no tiene registro cuando localState existe pero brokerState es null', () => {
      const text = formatSyncDiscrepancy(PAYLOAD_SYNC_DISCREPANCY);
      expect(text).toContain('Broker: sin registro');
    });

    test('describe que el estado local no tiene registro cuando brokerState existe pero localState es null', () => {
      const text = formatSyncDiscrepancy({
        ...PAYLOAD_SYNC_DISCREPANCY,
        localState:  null,
        brokerState: { tradeId: PAYLOAD_SYNC_DISCREPANCY.tradeId },
      });
      expect(text).toContain('sin registro');
    });
  });
});
