/**
 * CandleRepository.integration.test.js
 *
 * Tests de integración del CandleRepository contra una base de datos PostgreSQL real.
 *
 * Requisitos:
 *   - Variable de entorno TEST_DATABASE_URL apuntando a una instancia PG de prueba.
 *   - Las tablas candles_1s, candles_1m, candles_1h y symbols deben existir.
 *
 * Si TEST_DATABASE_URL no está definida, los tests se omiten automáticamente.
 *
 * Setup/Teardown:
 *   - beforeAll: inserta datos de prueba en un namespace propio (símbolo TEST_SYMBOL)
 *   - afterAll:  limpia los datos de prueba (DELETE WHERE symbol = TEST_SYMBOL)
 */

import pg from 'pg';
import CandleRepository from '../CandleRepository.js';

const { Pool } = pg;

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TEST_SYMBOL       = 'TESTBTC_INTEGRATION';

// ---------------------------------------------------------------------------
// Skip si no hay base de datos configurada
// ---------------------------------------------------------------------------

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('CandleRepository — integración', () => {
  let pool;
  let repository;

  // Velas de prueba en formato de epoch ms
  const BASE_TIME = 1_700_000_000_000;
  const CANDLES_1M = Array.from({ length: 10 }, (_, i) => ({
    symbol:    TEST_SYMBOL,
    open_time: new Date(BASE_TIME + i * 60_000).toISOString(),
    open:      30000 + i * 10,
    high:      30100 + i * 10,
    low:       29900 + i * 10,
    close:     30050 + i * 10,
    volume:    100 + i,
  }));

  const CANDLES_1S = Array.from({ length: 5 }, (_, i) => ({
    symbol:    TEST_SYMBOL,
    open_time: new Date(BASE_TIME + i * 1_000).toISOString(),
    open:      30000,
    high:      30010,
    low:       29990,
    close:     30005,
    volume:    10,
  }));

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL });
    repository = new CandleRepository({ db: pool });

    // Insertar datos de prueba
    const insertCandle = async (table, row) => {
      await pool.query(
        `INSERT INTO ${table} (symbol, open_time, open, high, low, close, volume)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT DO NOTHING`,
        [row.symbol, row.open_time, row.open, row.high, row.low, row.close, row.volume]
      );
    };

    for (const c of CANDLES_1M) await insertCandle('candles_1m', c);
    for (const c of CANDLES_1S) await insertCandle('candles_1s', c);
  });

  afterAll(async () => {
    if (pool) {
      await pool.query('DELETE FROM candles_1m WHERE symbol = $1', [TEST_SYMBOL]);
      await pool.query('DELETE FROM candles_1s WHERE symbol = $1', [TEST_SYMBOL]);
      await pool.end();
    }
  });

  // -------------------------------------------------------------------------
  // getCandles
  // -------------------------------------------------------------------------

  describe('getCandles', () => {
    test('devuelve velas en el rango indicado ordenadas por openTime ASC', async () => {
      const from = BASE_TIME;
      const to   = BASE_TIME + 4 * 60_000;

      const candles = await repository.getCandles(TEST_SYMBOL, '1m', from, to);

      expect(candles.length).toBeGreaterThanOrEqual(5);
      expect(candles.length).toBeLessThanOrEqual(5);

      // Verificar orden ASC
      for (let i = 1; i < candles.length; i++) {
        expect(candles[i].openTime).toBeGreaterThan(candles[i - 1].openTime);
      }
    });

    test('convierte los campos al formato interno Candle', async () => {
      const candles = await repository.getCandles(
        TEST_SYMBOL, '1m', BASE_TIME, BASE_TIME
      );

      expect(candles).toHaveLength(1);
      const c = candles[0];

      expect(typeof c.openTime).toBe('number');
      expect(typeof c.open).toBe('number');
      expect(typeof c.high).toBe('number');
      expect(typeof c.low).toBe('number');
      expect(typeof c.close).toBe('number');
      expect(typeof c.volume).toBe('number');
      expect(c.isClosed).toBe(true);
      expect(c.symbol).toBe(TEST_SYMBOL);
      expect(c.timeframe).toBe('1m');
    });

    test('devuelve array vacío si no hay datos en el rango', async () => {
      const candles = await repository.getCandles(
        TEST_SYMBOL, '1m', BASE_TIME - 1_000_000, BASE_TIME - 500_000
      );
      expect(candles).toEqual([]);
    });

    test('lanza error descriptivo con timeframe inválido', async () => {
      await expect(
        repository.getCandles(TEST_SYMBOL, '999x', BASE_TIME, BASE_TIME)
      ).rejects.toThrow('999x');
    });
  });

  // -------------------------------------------------------------------------
  // getLastN
  // -------------------------------------------------------------------------

  describe('getLastN', () => {
    test('devuelve exactamente N velas ordenadas ASC', async () => {
      const candles = await repository.getLastN(TEST_SYMBOL, '1m', 3);

      expect(candles).toHaveLength(3);

      // Verificar orden ASC — las más antiguas primero
      for (let i = 1; i < candles.length; i++) {
        expect(candles[i].openTime).toBeGreaterThan(candles[i - 1].openTime);
      }
    });

    test('devuelve las ÚLTIMAS N velas (no las primeras)', async () => {
      const allCandles = await repository.getCandles(
        TEST_SYMBOL, '1m', BASE_TIME, BASE_TIME + 9 * 60_000
      );
      const lastN = await repository.getLastN(TEST_SYMBOL, '1m', 3);

      const expectedLastThree = allCandles.slice(-3);
      expect(lastN.map(c => c.openTime)).toEqual(expectedLastThree.map(c => c.openTime));
    });

    test('lanza si n no es un entero positivo', async () => {
      await expect(repository.getLastN(TEST_SYMBOL, '1m', 0)).rejects.toThrow('entero positivo');
      await expect(repository.getLastN(TEST_SYMBOL, '1m', -1)).rejects.toThrow('entero positivo');
      await expect(repository.getLastN(TEST_SYMBOL, '1m', 1.5)).rejects.toThrow('entero positivo');
    });

    test('lanza con timeframe inválido', async () => {
      await expect(repository.getLastN(TEST_SYMBOL, 'NOPE', 5)).rejects.toThrow('NOPE');
    });
  });

  // -------------------------------------------------------------------------
  // hasGranularData
  // -------------------------------------------------------------------------

  describe('hasGranularData', () => {
    test('devuelve has1s=true y has1m=true cuando hay datos en ambas tablas', async () => {
      const result = await repository.hasGranularData(
        TEST_SYMBOL,
        BASE_TIME,
        BASE_TIME + 60_000
      );

      expect(result.has1s).toBe(true);
      expect(result.has1m).toBe(true);
    });

    test('devuelve has1s=false y has1m=false fuera del rango de datos', async () => {
      const futureTime = BASE_TIME + 1_000_000_000;
      const result = await repository.hasGranularData(
        TEST_SYMBOL,
        futureTime,
        futureTime + 60_000
      );

      expect(result.has1s).toBe(false);
      expect(result.has1m).toBe(false);
    });

    test('devuelve has1s=false para un símbolo sin datos de 1s', async () => {
      // TEST_SYMBOL tiene 1s solo en el rango BASE_TIME .. BASE_TIME + 4s
      // Fuera de ese rango pero dentro de 1m
      const result = await repository.hasGranularData(
        TEST_SYMBOL,
        BASE_TIME + 5 * 60_000,  // más allá de los datos 1s insertados
        BASE_TIME + 9 * 60_000
      );

      // has1m debería ser true (insertamos 10 velas de 1m)
      expect(result.has1m).toBe(true);
      // has1s debería ser false
      expect(result.has1s).toBe(false);
    });

    test('devuelve objeto con exactamente las propiedades has1s y has1m', async () => {
      const result = await repository.hasGranularData(TEST_SYMBOL, BASE_TIME, BASE_TIME);

      expect(Object.keys(result).sort()).toEqual(['has1m', 'has1s'].sort());
    });
  });
});

// ---------------------------------------------------------------------------
// Tests unitarios del CandleRepository (sin BD real) — siempre se ejecutan
// ---------------------------------------------------------------------------

describe('CandleRepository — unitarios (sin BD)', () => {
  function makeDb(rows = []) {
    return {
      query: vi.fn(async () => ({ rows })),
    };
  }

  test('lanza si db no tiene método query()', () => {
    expect(() => new CandleRepository({ db: {} })).toThrow('query');
    expect(() => new CandleRepository({ db: null })).toThrow('query');
  });

  test('lanza con timeframe no soportado', async () => {
    const repo = new CandleRepository({ db: makeDb() });
    await expect(repo.getCandles('BTCUSDT', '3d', 0, 1)).rejects.toThrow("'3d' no soportado");
    await expect(repo.getCandles('BTCUSDT', '999x', 0, 1)).rejects.toThrow("'999x' no soportado");
  });

  test('getCandles 1m usa binance_candles con timestamp en segundos', async () => {
    const db = makeDb([]);
    const repo = new CandleRepository({ db });

    await repo.getCandles('BTCUSDT', '1m', 1_700_000_000_000, 1_700_003_600_000);

    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('binance_candles');
    expect(sql).toContain('timeframe');
    expect(params).toContain('BTCUSDT');
    expect(params).toContain('1m');
    // timestamps convertidos a segundos
    expect(params).toContain(1_700_000_000);
    expect(params).toContain(1_700_003_600);
  });

  test('getCandles 1s usa binance_klines_1s con open_time en ms', async () => {
    const db = makeDb([]);
    const repo = new CandleRepository({ db });

    await repo.getCandles('BTCUSDT', '1s', 1_700_000_000_000, 1_700_003_600_000);

    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('binance_klines_1s');
    expect(params).toContain(1_700_000_000_000);
    expect(params).toContain(1_700_003_600_000);
  });

  test('getLastN lanza si n = 0', async () => {
    const repo = new CandleRepository({ db: makeDb() });
    await expect(repo.getLastN('BTCUSDT', '1m', 0)).rejects.toThrow('entero positivo');
  });

  test('_rowToCandle convierte binance_candles (timestamp en segundos) correctamente', async () => {
    const timestampSec = 1_700_000_000;
    const db = makeDb([{
      symbol:    'BTCUSDT',
      timeframe: '1m',
      timestamp: timestampSec,
      open:      '30000.5',
      high:      '30500.0',
      low:       '29900.25',
      close:     '30200.75',
      volume:    '123.456',
    }]);
    const repo = new CandleRepository({ db });

    const candles = await repo.getCandles('BTCUSDT', '1m', 0, 9_999_999_999_999);

    expect(candles[0].openTime).toBe(timestampSec * 1000);
    expect(candles[0].open).toBe(30000.5);
    expect(typeof candles[0].high).toBe('number');
    expect(candles[0].isClosed).toBe(true);
    expect(candles[0].timeframe).toBe('1m');
  });

  test('_rowToCandle1s convierte binance_klines_1s (open_time en ms) correctamente', async () => {
    const openTimeMs = 1_700_000_000_000;
    const db = makeDb([{
      symbol:      'BTCUSDT',
      open_time:   openTimeMs,
      open_price:  '30000.5',
      high_price:  '30500.0',
      low_price:   '29900.25',
      close_price: '30200.75',
      volume:      '123.456',
    }]);
    const repo = new CandleRepository({ db });

    const candles = await repo.getCandles('BTCUSDT', '1s', 0, 9_999_999_999_999);

    expect(candles[0].openTime).toBe(openTimeMs);
    expect(candles[0].open).toBe(30000.5);
    expect(candles[0].timeframe).toBe('1s');
    expect(candles[0].isClosed).toBe(true);
  });
});
