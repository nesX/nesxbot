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

  test('_tableFor lanza con timeframe no soportado', () => {
    const repo = new CandleRepository({ db: makeDb() });
    expect(() => repo._tableFor('5m')).toThrow("'5m' no existe");
    expect(() => repo._tableFor('4h')).toThrow("'4h' no existe");
  });

  test('_tableFor retorna tabla correcta para timeframes válidos', () => {
    const repo = new CandleRepository({ db: makeDb() });
    expect(repo._tableFor('1s')).toBe('candles_1s');
    expect(repo._tableFor('1m')).toBe('candles_1m');
    expect(repo._tableFor('1h')).toBe('candles_1h');
  });

  test('getCandles construye query con los parámetros correctos', async () => {
    const db = makeDb([]);
    const repo = new CandleRepository({ db });

    await repo.getCandles('BTCUSDT', '1m', 1000, 2000);

    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('candles_1m');
    expect(params).toContain('BTCUSDT');
    expect(params).toContain(1000);
    expect(params).toContain(2000);
  });

  test('getLastN lanza si n = 0', async () => {
    const repo = new CandleRepository({ db: makeDb() });
    await expect(repo.getLastN('BTCUSDT', '1m', 0)).rejects.toThrow('entero positivo');
  });

  test('_rowToCandle convierte tipos correctamente', () => {
    const repo = new CandleRepository({ db: makeDb() });
    const row = {
      symbol:    'BTCUSDT',
      open_time: new Date(1_700_000_000_000).toISOString(),
      open:      '30000.5',
      high:      '30500.0',
      low:       '29900.25',
      close:     '30200.75',
      volume:    '123.456',
    };

    const c = repo._rowToCandle(row, '1m');

    expect(c.openTime).toBe(1_700_000_000_000);
    expect(c.open).toBe(30000.5);
    expect(typeof c.high).toBe('number');
    expect(c.isClosed).toBe(true);
    expect(c.timeframe).toBe('1m');
  });
});
