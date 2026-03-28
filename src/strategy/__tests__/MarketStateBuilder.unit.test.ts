/**
 * MarketStateBuilder.unit.test.ts
 *
 * Tests unitarios del MarketStateBuilder.
 */

import MarketStateBuilder from '../MarketStateBuilder.js';
import type { Candle } from '../../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTimeProvider(fixedMs = 1_700_000_000_000) {
  let current = fixedMs;
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

function makeCandlePayload(candle: Candle) {
  return {
    symbol:    candle.symbol,
    timeframe: candle.timeframe,
    candle,
  };
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe('MarketStateBuilder — constructor', () => {
  test('lanza si timeProvider no se provee', () => {
    expect(() => new MarketStateBuilder({} as never)).toThrow('timeProvider');
  });

  test('lanza si timeProvider no tiene método now()', () => {
    expect(() => new MarketStateBuilder({ timeProvider: { setTime: () => {} } as never }))
      .toThrow('timeProvider');
  });

  test('se instancia con dependencias válidas', () => {
    expect(() => new MarketStateBuilder({ timeProvider: makeTimeProvider() })).not.toThrow();
  });

  test('acepta maxCandles personalizado', () => {
    const builder = new MarketStateBuilder({ timeProvider: makeTimeProvider(), maxCandles: 10 });
    expect(builder._maxCandles).toBe(10);
  });

  test('usa maxCandles = 500 por defecto', () => {
    const builder = new MarketStateBuilder({ timeProvider: makeTimeProvider() });
    expect(builder._maxCandles).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// addCandle()
// ---------------------------------------------------------------------------

describe('MarketStateBuilder.addCandle', () => {
  test('acumula velas en el buffer del (symbol, timeframe) correcto', () => {
    const builder = new MarketStateBuilder({ timeProvider: makeTimeProvider() });
    const candle  = makeCandle();

    builder.addCandle(makeCandlePayload(candle));

    expect(builder.getCandleCount('BTCUSDT', '1m')).toBe(1);
  });

  test('buffers distintos para distintos timeframes', () => {
    const builder   = new MarketStateBuilder({ timeProvider: makeTimeProvider() });
    const candle1m  = makeCandle({ timeframe: '1m'  });
    const candle15m = makeCandle({ timeframe: '15m' });

    builder.addCandle(makeCandlePayload(candle1m));
    builder.addCandle(makeCandlePayload(candle15m));

    expect(builder.getCandleCount('BTCUSDT', '1m')).toBe(1);
    expect(builder.getCandleCount('BTCUSDT', '15m')).toBe(1);
  });

  test('buffers distintos para distintos símbolos', () => {
    const builder   = new MarketStateBuilder({ timeProvider: makeTimeProvider() });
    const btcCandle = makeCandle({ symbol: 'BTCUSDT' });
    const ethCandle = makeCandle({ symbol: 'ETHUSDT' });

    builder.addCandle(makeCandlePayload(btcCandle));
    builder.addCandle(makeCandlePayload(ethCandle));

    expect(builder.getCandleCount('BTCUSDT', '1m')).toBe(1);
    expect(builder.getCandleCount('ETHUSDT', '1m')).toBe(1);
  });

  test('mantiene ventana deslizante al superar maxCandles', () => {
    const maxCandles = 3;
    const builder    = new MarketStateBuilder({ timeProvider: makeTimeProvider(), maxCandles });

    for (let i = 0; i < 5; i++) {
      builder.addCandle(makeCandlePayload(makeCandle({ openTime: i * 60_000 })));
    }

    expect(builder.getCandleCount('BTCUSDT', '1m')).toBe(maxCandles);
  });

  test('la ventana deslizante conserva las velas más recientes', () => {
    const builder = new MarketStateBuilder({ timeProvider: makeTimeProvider(), maxCandles: 2 });

    const c1 = makeCandle({ openTime: 1000, close: 100 });
    const c2 = makeCandle({ openTime: 2000, close: 200 });
    const c3 = makeCandle({ openTime: 3000, close: 300 });

    builder.addCandle(makeCandlePayload(c1));
    builder.addCandle(makeCandlePayload(c2));
    builder.addCandle(makeCandlePayload(c3));

    const state = builder.build('BTCUSDT', ['1m']);
    const openTimes = state.candles['1m'].map(c => c.openTime);
    expect(openTimes).toEqual([2000, 3000]);
  });

  test('ignora payload sin symbol y loggea advertencia', () => {
    const logger  = makeLogger();
    const builder = new MarketStateBuilder({ timeProvider: makeTimeProvider(), logger });

    builder.addCandle({ timeframe: '1m', candle: makeCandle() }); // sin symbol

    expect(logger.warn).toHaveBeenCalled();
    expect(builder.getCandleCount('BTCUSDT', '1m')).toBe(0);
  });

  test('ignora payload sin candle y loggea advertencia', () => {
    const logger  = makeLogger();
    const builder = new MarketStateBuilder({ timeProvider: makeTimeProvider(), logger });

    builder.addCandle({ symbol: 'BTCUSDT', timeframe: '1m' }); // sin candle

    expect(logger.warn).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// build()
// ---------------------------------------------------------------------------

describe('MarketStateBuilder.build', () => {
  test('retorna MarketState con estructura correcta', () => {
    const tp      = makeTimeProvider(9999);
    const builder = new MarketStateBuilder({ timeProvider: tp });
    const candle  = makeCandle();

    builder.addCandle(makeCandlePayload(candle));
    const state = builder.build('BTCUSDT', ['1m']);

    expect(state).toMatchObject({
      symbol:       'BTCUSDT',
      timestamp:    9999,
      currentPrice: expect.any(Number),
      candles:      { '1m': expect.any(Array) },
    });
  });

  test('timestamp usa el TimeProvider (no Date.now())', () => {
    const tp      = makeTimeProvider(42_000);
    const builder = new MarketStateBuilder({ timeProvider: tp });

    builder.addCandle(makeCandlePayload(makeCandle()));
    const state = builder.build('BTCUSDT', ['1m']);

    expect(state.timestamp).toBe(42_000);
  });

  test('retorna array vacío para timeframe sin datos', () => {
    const builder = new MarketStateBuilder({ timeProvider: makeTimeProvider() });
    const state   = builder.build('BTCUSDT', ['1m', '4h']);

    expect(state.candles['1m']).toEqual([]);
    expect(state.candles['4h']).toEqual([]);
  });

  test('incluye solo los timeframes solicitados en candles', () => {
    const builder = new MarketStateBuilder({ timeProvider: makeTimeProvider() });
    builder.addCandle(makeCandlePayload(makeCandle({ timeframe: '1m' })));
    builder.addCandle(makeCandlePayload(makeCandle({ timeframe: '15m' })));

    const state = builder.build('BTCUSDT', ['1m']);
    expect(Object.keys(state.candles)).toEqual(['1m']);
  });

  test('retorna copia del buffer (mutarlo no afecta el estado interno)', () => {
    const builder = new MarketStateBuilder({ timeProvider: makeTimeProvider() });
    builder.addCandle(makeCandlePayload(makeCandle()));

    const state = builder.build('BTCUSDT', ['1m']);
    (state.candles['1m'] as unknown[]).push({ fake: true }); // mutar la copia

    const state2 = builder.build('BTCUSDT', ['1m']);
    expect(state2.candles['1m'].some(c => (c as unknown as { fake?: boolean }).fake)).toBe(false);
  });

  test('currentPrice es el close de la vela más reciente', () => {
    const builder = new MarketStateBuilder({ timeProvider: makeTimeProvider() });
    builder.addCandle(makeCandlePayload(makeCandle({ openTime: 1000, close: 100 })));
    builder.addCandle(makeCandlePayload(makeCandle({ openTime: 2000, close: 200 })));

    const state = builder.build('BTCUSDT', ['1m']);
    expect(state.currentPrice).toBe(200);
  });

  test('currentPrice usa la vela más reciente entre múltiples timeframes', () => {
    const builder = new MarketStateBuilder({ timeProvider: makeTimeProvider() });

    // 1m más reciente
    builder.addCandle(makeCandlePayload(makeCandle({ timeframe: '1m',  openTime: 3000, close: 300 })));
    // 4h más antigua
    builder.addCandle(makeCandlePayload(makeCandle({ timeframe: '4h',  openTime: 1000, close: 100 })));

    const state = builder.build('BTCUSDT', ['1m', '4h']);
    expect(state.currentPrice).toBe(300);
  });

  test('currentPrice es 0 si no hay datos', () => {
    const builder = new MarketStateBuilder({ timeProvider: makeTimeProvider() });
    const state   = builder.build('BTCUSDT', ['1m']);
    expect(state.currentPrice).toBe(0);
  });

  test('lanza si symbol no se provee', () => {
    const builder = new MarketStateBuilder({ timeProvider: makeTimeProvider() });
    expect(() => builder.build('', ['1m'])).toThrow('symbol');
  });

  test('lanza si timeframes es array vacío', () => {
    const builder = new MarketStateBuilder({ timeProvider: makeTimeProvider() });
    expect(() => builder.build('BTCUSDT', [])).toThrow('timeframes');
  });

  test('lanza si timeframes no es array', () => {
    const builder = new MarketStateBuilder({ timeProvider: makeTimeProvider() });
    expect(() => builder.build('BTCUSDT', '1m' as unknown as string[])).toThrow('timeframes');
  });
});

// ---------------------------------------------------------------------------
// reset()
// ---------------------------------------------------------------------------

describe('MarketStateBuilder.reset', () => {
  test('elimina todos los buffers', () => {
    const builder = new MarketStateBuilder({ timeProvider: makeTimeProvider() });
    builder.addCandle(makeCandlePayload(makeCandle({ symbol: 'BTCUSDT', timeframe: '1m' })));
    builder.addCandle(makeCandlePayload(makeCandle({ symbol: 'ETHUSDT', timeframe: '4h' })));

    builder.reset();

    expect(builder.getCandleCount('BTCUSDT', '1m')).toBe(0);
    expect(builder.getCandleCount('ETHUSDT', '4h')).toBe(0);
  });

  test('después de reset se puede volver a agregar velas', () => {
    const builder = new MarketStateBuilder({ timeProvider: makeTimeProvider() });
    builder.addCandle(makeCandlePayload(makeCandle()));
    builder.reset();
    builder.addCandle(makeCandlePayload(makeCandle()));

    expect(builder.getCandleCount('BTCUSDT', '1m')).toBe(1);
  });
});
