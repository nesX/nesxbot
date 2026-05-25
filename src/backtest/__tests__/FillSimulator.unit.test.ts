/**
 * FillSimulator.unit.test.ts
 *
 * Tests unitarios del FillSimulator.
 * Todas las dependencias son dobles en memoria.
 */

import FillSimulator from '../FillSimulator.js';
import type { Candle, TradePlan, GranularDataInfo } from '../../types.js';

// ---------------------------------------------------------------------------
// Factories
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

function makeRepo({ has1s = false, has1m = false, candles = [] as Candle[] } = {}) {
  return {
    hasGranularData: vi.fn(async (): Promise<GranularDataInfo> => ({ has1s, has1m })),
    getCandles:      vi.fn(async (): Promise<Candle[]> => candles),
  };
}

function makeCandle(overrides: Partial<Candle> = {}): Candle {
  return {
    symbol:    'BTCUSDT',
    timeframe: '1m',
    openTime:  1_700_000_000_000,
    open:      30000,
    high:      30500,
    low:       29500,
    close:     30200,
    volume:    100,
    isClosed:  true,
    ...overrides,
  };
}

function makeTradePlan(overrides: Partial<TradePlan> = {}): TradePlan {
  return {
    strategyId: 'test-strategy',
    symbol:     'BTCUSDT',
    direction:  'LONG',
    entryPrice: 30000,
    stopLoss:   29000,
    takeProfits: [
      { price: 31000, sizePercent: 50 },
      { price: 32000, sizePercent: 30 },
      { price: 33000, sizePercent: 20 },
    ],
    riskPercent: 1,
    metadata: {},
    ...overrides,
  };
}

function makeFillSimulator(repoOverrides: Parameters<typeof makeRepo>[0] = {}) {
  return new FillSimulator({
    candleRepository: makeRepo(repoOverrides),
    timeProvider:     makeTimeProvider(),
    logger:           makeLogger(),
  });
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

type FillSimulatorDeps = ConstructorParameters<typeof FillSimulator>[0];

describe('FillSimulator — constructor', () => {
  test('lanza si candleRepository no tiene hasGranularData()', () => {
    expect(() => new FillSimulator({
      candleRepository: { getCandles: vi.fn() } as unknown as FillSimulatorDeps['candleRepository'],
      timeProvider:     makeTimeProvider(),
    })).toThrow('hasGranularData');
  });

  test('lanza si timeProvider no tiene now()', () => {
    expect(() => new FillSimulator({
      candleRepository: makeRepo(),
      timeProvider:     {} as FillSimulatorDeps['timeProvider'],
    })).toThrow('timeProvider');
  });

  test('se instancia correctamente con dependencias válidas', () => {
    expect(() => new FillSimulator({
      candleRepository: makeRepo(),
      timeProvider:     makeTimeProvider(),
    })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Validaciones de entrada
// ---------------------------------------------------------------------------

describe('FillSimulator — validaciones de entrada', () => {
  let sim: FillSimulator;
  beforeEach(() => { sim = makeFillSimulator(); });

  test('lanza si contextCandle no tiene OHLC completo (falta high)', async () => {
    const candle = makeCandle();
    delete (candle as Partial<Candle>).high;
    await expect(sim.simulateFill(makeTradePlan(), candle)).rejects.toThrow('high');
  });

  test('lanza si contextCandle no tiene OHLC completo (falta low)', async () => {
    const candle = makeCandle();
    delete (candle as Partial<Candle>).low;
    await expect(sim.simulateFill(makeTradePlan(), candle)).rejects.toThrow('low');
  });

  test('lanza si contextCandle no tiene openTime', async () => {
    const candle = makeCandle();
    delete (candle as Partial<Candle>).openTime;
    await expect(sim.simulateFill(makeTradePlan(), candle)).rejects.toThrow('openTime');
  });

  test('lanza si contextCandle es null', async () => {
    await expect(sim.simulateFill(makeTradePlan(), null as unknown as Candle)).rejects.toThrow('contextCandle');
  });

  test('lanza si tradePlan es null', async () => {
    await expect(sim.simulateFill(null as unknown as TradePlan, makeCandle())).rejects.toThrow('tradePlan');
  });

  test('lanza si tradePlan.direction es inválido', async () => {
    const plan = makeTradePlan({ direction: 'SIDEWAYS' as TradePlan['direction'] });
    await expect(sim.simulateFill(plan, makeCandle())).rejects.toThrow('direction');
  });

  test('lanza si tradePlan.takeProfits está vacío', async () => {
    const plan = makeTradePlan({ takeProfits: [] });
    await expect(sim.simulateFill(plan, makeCandle())).rejects.toThrow('takeProfits');
  });

  test('lanza si tradePlan.stopLoss falta', async () => {
    const plan = makeTradePlan();
    delete (plan as Partial<TradePlan>).stopLoss;
    await expect(sim.simulateFill(plan, makeCandle())).rejects.toThrow('stopLoss');
  });
});

// ---------------------------------------------------------------------------
// Resolución adaptativa — selección de modo
// ---------------------------------------------------------------------------

describe('FillSimulator — selección de modo', () => {
  test('usa PRECISE_1S cuando has1s=true', async () => {
    const candleTs = 1_700_000_000_000;
    const granularCandle = makeCandle({
      openTime: candleTs + 60_000,   // tras el cierre de la vela de señal (anti-lookahead)
      open:     30050,
      high:     31100,
      low:      30000,
      close:    31000,
    });

    const repo = makeRepo({ has1s: true, candles: [granularCandle] });
    const sim  = new FillSimulator({
      candleRepository: repo,
      timeProvider:     makeTimeProvider(candleTs),
      logger:           makeLogger(),
    });

    const result = await sim.simulateFill(makeTradePlan(), makeCandle({ openTime: candleTs }));

    expect(result.resolution_mode).toBe('PRECISE_1S');
    expect(repo.hasGranularData).toHaveBeenCalledTimes(1);
    expect(repo.getCandles).toHaveBeenCalledWith('BTCUSDT', '1s', expect.any(Number), expect.any(Number));
  });

  test('usa PRECISE_1M cuando has1s=false y has1m=true', async () => {
    const candleTs = 1_700_000_000_000;
    const granularCandle = makeCandle({
      openTime: candleTs + 60_000,   // tras el cierre de la vela de señal (anti-lookahead)
      open:     30050,
      high:     31100,
      low:      30000,
      close:    31000,
    });

    const repo = makeRepo({ has1s: false, has1m: true, candles: [granularCandle] });
    const sim  = new FillSimulator({
      candleRepository: repo,
      timeProvider:     makeTimeProvider(candleTs),
      logger:           makeLogger(),
    });

    const result = await sim.simulateFill(makeTradePlan(), makeCandle({ openTime: candleTs }));

    expect(result.resolution_mode).toBe('PRECISE_1M');
    expect(repo.getCandles).toHaveBeenCalledWith('BTCUSDT', '1m', expect.any(Number), expect.any(Number));
  });

  test('usa PESSIMISTIC cuando has1s=false y has1m=false', async () => {
    const repo = makeRepo({ has1s: false, has1m: false });
    const sim  = new FillSimulator({
      candleRepository: repo,
      timeProvider:     makeTimeProvider(),
      logger:           makeLogger(),
    });

    const context = makeCandle({
      open:  30050,
      high:  31200,
      low:   30000,
      close: 31000,
    });

    const result = await sim.simulateFill(makeTradePlan(), context);

    expect(result.resolution_mode).toBe('PESSIMISTIC');
    expect(repo.getCandles).not.toHaveBeenCalled();
  });

  test('consulta hasGranularData exactamente una vez por simulateFill', async () => {
    const repo = makeRepo({ has1s: false, has1m: false });
    const sim  = new FillSimulator({
      candleRepository: repo,
      timeProvider:     makeTimeProvider(),
      logger:           makeLogger(),
    });

    await sim.simulateFill(makeTradePlan(), makeCandle());

    expect(repo.hasGranularData).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// PESSIMISTIC — lógica de ambigüedad
// ---------------------------------------------------------------------------

describe('FillSimulator — modo PESSIMISTIC', () => {
  function makePessimisticSim() {
    return new FillSimulator({
      candleRepository: makeRepo({ has1s: false, has1m: false }),
      timeProvider:     makeTimeProvider(),
      logger:           makeLogger(),
    });
  }

  test('had_ambiguity=true cuando high>TP y low<SL en la misma vela (LONG)', async () => {
    const sim = makePessimisticSim();
    const plan = makeTradePlan({
      entryPrice:  30000,
      stopLoss:    29000,
      takeProfits: [{ price: 31000, sizePercent: 100 }],
    });

    const context = makeCandle({
      open:  30000,
      high:  31100,
      low:   28500,
      close: 30500,
    });

    const result = await sim.simulateFill(plan, context);

    expect(result.had_ambiguity).toBe(true);
    expect(result.exitFill.type).toBe('SL');
    expect(result.pnl).toBeLessThan(0);
  });

  test('had_ambiguity=false cuando solo el TP es alcanzable (LONG)', async () => {
    const sim = makePessimisticSim();
    const plan = makeTradePlan({
      entryPrice:  30000,
      stopLoss:    29000,
      takeProfits: [{ price: 31000, sizePercent: 100 }],
    });

    const context = makeCandle({
      open:  30050,
      high:  31100,
      low:   29100,
      close: 31000,
    });

    const result = await sim.simulateFill(plan, context);

    expect(result.had_ambiguity).toBe(false);
    expect(result.exitFill.type).toMatch(/^TP/);
    expect(result.pnl).toBeGreaterThan(0);
  });

  test('had_ambiguity=false cuando solo el SL es alcanzable (LONG)', async () => {
    const sim = makePessimisticSim();
    const plan = makeTradePlan({
      entryPrice:  30000,
      stopLoss:    29000,
      takeProfits: [{ price: 31000, sizePercent: 100 }],
    });

    const context = makeCandle({
      open:  30000,
      high:  30800,
      low:   28800,
      close: 29500,
    });

    const result = await sim.simulateFill(plan, context);

    expect(result.had_ambiguity).toBe(false);
    expect(result.exitFill.type).toBe('SL');
    expect(result.pnl).toBeLessThan(0);
  });

  test('PESSIMISTIC SHORT: had_ambiguity=true cuando low<TP y high>SL', async () => {
    const sim = makePessimisticSim();
    const plan = makeTradePlan({
      direction:   'SHORT',
      entryPrice:  30000,
      stopLoss:    31000,
      takeProfits: [{ price: 29000, sizePercent: 100 }],
    });

    const context = makeCandle({
      open:  30000,
      high:  31500,
      low:   28500,
      close: 30000,
    });

    const result = await sim.simulateFill(plan, context);

    expect(result.had_ambiguity).toBe(true);
    expect(result.exitFill.type).toBe('SL');
  });
});

// ---------------------------------------------------------------------------
// FillResult — estructura de respuesta
// ---------------------------------------------------------------------------

describe('FillSimulator — estructura del FillResult', () => {
  test('FillResult contiene todos los campos requeridos', async () => {
    const ts = 1_700_000_000_000;
    const context = makeCandle({
      openTime: ts,
      open:  30050,
      high:  31200,
      low:   29500,
      close: 31000,
    });

    const sim = new FillSimulator({
      candleRepository: makeRepo({ has1s: false, has1m: false }),
      timeProvider:     makeTimeProvider(ts),
      logger:           makeLogger(),
    });

    const result = await sim.simulateFill(makeTradePlan(), context);

    expect(result).toHaveProperty('tradeId');
    expect(typeof result.tradeId).toBe('string');
    expect(result.tradeId.length).toBeGreaterThan(0);

    expect(result).toHaveProperty('entryFill');
    expect(result.entryFill).toHaveProperty('price');
    expect(result.entryFill).toHaveProperty('timestamp');
    expect(result.entryFill).toHaveProperty('slippage');

    expect(result).toHaveProperty('exitFill');
    expect(result.exitFill).toHaveProperty('price');
    expect(result.exitFill).toHaveProperty('timestamp');
    expect(result.exitFill).toHaveProperty('type');

    expect(result).toHaveProperty('pnl');
    expect(result).toHaveProperty('pnlPercent');
    expect(result).toHaveProperty('resolution_mode');
    expect(result).toHaveProperty('had_ambiguity');
    expect(typeof result.had_ambiguity).toBe('boolean');
  });

  test('tradeId es único entre llamadas', async () => {
    const sim = new FillSimulator({
      candleRepository: makeRepo({ has1s: false, has1m: false }),
      timeProvider:     makeTimeProvider(),
      logger:           makeLogger(),
    });

    const context = makeCandle({ open: 30050, high: 31200, low: 29500, close: 31000 });
    const [r1, r2] = await Promise.all([
      sim.simulateFill(makeTradePlan(), context),
      sim.simulateFill(makeTradePlan(), context),
    ]);

    expect(r1.tradeId).not.toBe(r2.tradeId);
  });

  test('entryFill.slippage es un número no negativo', async () => {
    const sim = new FillSimulator({
      candleRepository: makeRepo({ has1s: false, has1m: false }),
      timeProvider:     makeTimeProvider(),
      logger:           makeLogger(),
    });

    const result = await sim.simulateFill(
      makeTradePlan(),
      makeCandle({ open: 30050, high: 31200, low: 29500, close: 31000 })
    );

    expect(typeof result.entryFill.slippage).toBe('number');
    expect(result.entryFill.slippage).toBeGreaterThanOrEqual(0);
  });

  test('exitFill.type es uno de los valores permitidos', async () => {
    const sim = new FillSimulator({
      candleRepository: makeRepo({ has1s: false, has1m: false }),
      timeProvider:     makeTimeProvider(),
      logger:           makeLogger(),
    });

    const context = makeCandle({
      open:  30050,
      high:  31200,
      low:   29100,
      close: 31000,
    });

    const result = await sim.simulateFill(makeTradePlan(), context);

    const validTypes = ['TP1', 'TP2', 'TP3', 'SL', 'MANUAL', 'TP'];
    expect(validTypes).toContain(result.exitFill.type);
  });
});

// ---------------------------------------------------------------------------
// PRECISE — comportamiento con datos granulares
// ---------------------------------------------------------------------------

describe('FillSimulator — modo PRECISE', () => {
  test('PRECISE_1S: el exitType es TP1 cuando el TP es alcanzable sin SL', async () => {
    const ts = 1_700_000_000_000;
    const granularCandles = [
      makeCandle({ openTime: ts + 60_000, open: 30050, high: 30200, low: 30000, close: 30150 }),
      makeCandle({ openTime: ts + 61_000, open: 30150, high: 31100, low: 30100, close: 31050 }),
    ];

    const repo = makeRepo({ has1s: true, candles: granularCandles });
    const sim  = new FillSimulator({
      candleRepository: repo,
      timeProvider:     makeTimeProvider(ts),
      logger:           makeLogger(),
    });

    const result = await sim.simulateFill(
      makeTradePlan({ entryPrice: 30000, stopLoss: 29000, takeProfits: [{ price: 31000, sizePercent: 100 }] }),
      makeCandle({ openTime: ts })
    );

    expect(result.resolution_mode).toBe('PRECISE_1S');
    expect(result.exitFill.type).toBe('TP1');
    expect(result.pnl).toBeGreaterThan(0);
  });

  test('PRECISE_1M: el exitType es SL cuando solo el SL es tocado', async () => {
    const ts = 1_700_000_000_000;
    const granularCandles = [
      makeCandle({ openTime: ts + 60_000, open: 30050, high: 30500, low: 28500, close: 29000 }),
    ];

    const repo = makeRepo({ has1s: false, has1m: true, candles: granularCandles });
    const sim  = new FillSimulator({
      candleRepository: repo,
      timeProvider:     makeTimeProvider(ts),
      logger:           makeLogger(),
    });

    const result = await sim.simulateFill(
      makeTradePlan({ entryPrice: 30000, stopLoss: 29000, takeProfits: [{ price: 31000, sizePercent: 100 }] }),
      makeCandle({ openTime: ts })
    );

    expect(result.resolution_mode).toBe('PRECISE_1M');
    expect(result.exitFill.type).toBe('SL');
    expect(result.pnl).toBeLessThan(0);
  });

  test('PRECISE: si no se toca ningún nivel, cierra en MANUAL con el último close', async () => {
    const ts = 1_700_000_000_000;
    const granularCandles = [
      makeCandle({ openTime: ts + 60_000, open: 30050, high: 30400, low: 29500, close: 30200 }),
      makeCandle({ openTime: ts + 61_000, open: 30200, high: 30500, low: 29800, close: 30300 }),
    ];

    const repo = makeRepo({ has1s: true, candles: granularCandles });
    const sim  = new FillSimulator({
      candleRepository: repo,
      timeProvider:     makeTimeProvider(ts),
      logger:           makeLogger(),
    });

    const result = await sim.simulateFill(
      makeTradePlan({
        entryPrice:  30000,
        stopLoss:    29000,
        takeProfits: [{ price: 31000, sizePercent: 100 }],
      }),
      makeCandle({ openTime: ts })
    );

    expect(result.exitFill.type).toBe('MANUAL');
    expect(result.exitFill.price).toBe(30300);
  });

  test('PRECISE: fallback a PESSIMISTIC si getCandles devuelve 0 velas', async () => {
    const repo = makeRepo({ has1s: true, candles: [] });
    const sim  = new FillSimulator({
      candleRepository: repo,
      timeProvider:     makeTimeProvider(),
      logger:           makeLogger(),
    });

    const context = makeCandle({
      open:  30050,
      high:  31200,
      low:   29100,
      close: 31000,
    });

    const result = await sim.simulateFill(makeTradePlan(), context);

    expect(result.resolution_mode).toBe('PESSIMISTIC');
  });
});

// ---------------------------------------------------------------------------
// PnL — dirección
// ---------------------------------------------------------------------------

describe('FillSimulator — cálculo de PnL', () => {
  function makePessimisticSim() {
    return new FillSimulator({
      candleRepository: makeRepo({ has1s: false, has1m: false }),
      timeProvider:     makeTimeProvider(),
      logger:           makeLogger(),
    });
  }

  test('PnL positivo cuando el trade gana (LONG TP)', async () => {
    const sim = makePessimisticSim();
    const plan = makeTradePlan({
      entryPrice:  30000,
      stopLoss:    29000,
      takeProfits: [{ price: 31000, sizePercent: 100 }],
      riskPercent: 1,
    });

    const context = makeCandle({ open: 30050, high: 31200, low: 29100, close: 31000 });
    const result  = await sim.simulateFill(plan, context);

    expect(result.pnl).toBeGreaterThan(0);
  });

  test('PnL negativo cuando el trade pierde (LONG SL)', async () => {
    const sim = makePessimisticSim();
    const plan = makeTradePlan({
      entryPrice:  30000,
      stopLoss:    29000,
      takeProfits: [{ price: 31000, sizePercent: 100 }],
      riskPercent: 1,
    });

    const context = makeCandle({ open: 30000, high: 30500, low: 28500, close: 29500 });
    const result  = await sim.simulateFill(plan, context);

    expect(result.pnl).toBeLessThan(0);
  });

  test('pnlPercent es coherente con el precio de entrada y salida', async () => {
    const sim = makePessimisticSim();
    const plan = makeTradePlan({
      direction:   'LONG',
      entryPrice:  30000,
      stopLoss:    29000,
      takeProfits: [{ price: 31000, sizePercent: 100 }],
      riskPercent: 1,
    });

    const context = makeCandle({ open: 30050, high: 31200, low: 29100, close: 31000 });
    const result  = await sim.simulateFill(plan, context);

    expect(result.pnlPercent).toBeGreaterThan(0);
    expect(result.pnlPercent).toBeLessThan(20);
  });
});
