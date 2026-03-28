/**
 * MetricsCalculator.unit.test.ts
 *
 * Tests unitarios del MetricsCalculator.
 * No tiene dependencias externas — todo síncrono.
 */

import MetricsCalculator from '../MetricsCalculator.js';
import type { FillResult } from '../../types.js';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeFill(overrides: Partial<FillResult> = {}): FillResult {
  return {
    tradeId: 'trade-' + Math.random(),
    entryFill: {
      price:     30000,
      timestamp: 1_700_000_000_000,
      slippage:  15,
    },
    exitFill: {
      price:     31000,
      timestamp: 1_700_000_000_000 + 3600_000,
      type:      'TP1',
      tpLevel:   1,
    },
    pnl:             1.0,
    pnlPercent:      3.33,
    resolution_mode: 'PRECISE_1S',
    had_ambiguity:   false,
    ...overrides,
  };
}

function makeWin(pnl = 1.0, exitType = 'TP1'): FillResult {
  return makeFill({ pnl, exitFill: { price: 31000, timestamp: 0, type: exitType, tpLevel: 1 } });
}

function makeLoss(pnl = -1.0): FillResult {
  return makeFill({ pnl, exitFill: { price: 29000, timestamp: 0, type: 'SL', tpLevel: null } });
}

// ---------------------------------------------------------------------------
// Constructor y validaciones
// ---------------------------------------------------------------------------

describe('MetricsCalculator — validaciones', () => {
  const calc = new MetricsCalculator();

  test('lanza si fills no es un array', () => {
    expect(() => calc.calculate(null as unknown as FillResult[], 10000)).toThrow('array');
    expect(() => calc.calculate('string' as unknown as FillResult[], 10000)).toThrow('array');
  });

  test('lanza si initialCapital no es un número positivo', () => {
    expect(() => calc.calculate([], 0)).toThrow('initialCapital');
    expect(() => calc.calculate([], -1000)).toThrow('initialCapital');
    expect(() => calc.calculate([], 'abc' as unknown as number)).toThrow('initialCapital');
  });
});

// ---------------------------------------------------------------------------
// Métricas vacías
// ---------------------------------------------------------------------------

describe('MetricsCalculator — sin trades', () => {
  const calc = new MetricsCalculator();

  test('devuelve métricas válidas con fills vacío', () => {
    const metrics = calc.calculate([], 10000);

    expect(metrics.totalTrades).toBe(0);
    expect(metrics.winRate).toBe(0);
    expect(metrics.profitFactor).toBe(0);
    expect(metrics.maxDrawdown).toBe(0);
    expect(metrics.finalCapital).toBe(10000);
    expect(metrics.expectancy).toBe(0);
  });

  test('resolution_confidence es todo 0 con fills vacío', () => {
    const metrics = calc.calculate([], 10000);
    const conf = metrics.resolution_confidence;

    expect(conf.PRECISE_1S).toBe(0);
    expect(conf.PRECISE_1M).toBe(0);
    expect(conf.PESSIMISTIC).toBe(0);
  });

  test('tpBreakdown tiene TP1/TP2/TP3 en 0 con fills vacío', () => {
    const metrics = calc.calculate([], 10000);

    expect(metrics.tpBreakdown.tp1.hits).toBe(0);
    expect(metrics.tpBreakdown.tp2.hits).toBe(0);
    expect(metrics.tpBreakdown.tp3.hits).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// winRate
// ---------------------------------------------------------------------------

describe('MetricsCalculator — winRate', () => {
  const calc = new MetricsCalculator();

  test('winRate = 100% cuando todos los trades ganan', () => {
    const fills = [makeWin(), makeWin(), makeWin()];
    const metrics = calc.calculate(fills, 10000);
    expect(metrics.winRate).toBe(100);
  });

  test('winRate = 0% cuando todos los trades pierden', () => {
    const fills = [makeLoss(), makeLoss()];
    const metrics = calc.calculate(fills, 10000);
    expect(metrics.winRate).toBe(0);
  });

  test('winRate = 50% con mitad ganancias y mitad pérdidas', () => {
    const fills = [makeWin(), makeLoss(), makeWin(), makeLoss()];
    const metrics = calc.calculate(fills, 10000);
    expect(metrics.winRate).toBe(50);
  });

  test('winRate = 66.67% con 2 ganancias y 1 pérdida', () => {
    const fills = [makeWin(), makeWin(), makeLoss()];
    const metrics = calc.calculate(fills, 10000);
    expect(metrics.winRate).toBeCloseTo(66.67, 1);
  });

  test('trades con pnl = 0 no cuentan como ganadores', () => {
    const neutralFill = makeFill({ pnl: 0 });
    const fills = [makeWin(), neutralFill, makeLoss()];
    const metrics = calc.calculate(fills, 10000);
    expect(metrics.winRate).toBeCloseTo(33.33, 1);
  });
});

// ---------------------------------------------------------------------------
// profitFactor
// ---------------------------------------------------------------------------

describe('MetricsCalculator — profitFactor', () => {
  const calc = new MetricsCalculator();

  test('profitFactor = suma_ganancias / suma_perdidas', () => {
    const fills = [
      makeWin(2), makeWin(3),
      makeLoss(-1), makeLoss(-1),
    ];
    const metrics = calc.calculate(fills, 10000);
    expect(metrics.profitFactor).toBeCloseTo(2.5, 5);
  });

  test('profitFactor = Infinity si no hay pérdidas', () => {
    const fills = [makeWin(1), makeWin(2)];
    const metrics = calc.calculate(fills, 10000);
    expect(metrics.profitFactor).toBe(Infinity);
  });

  test('profitFactor = 0 si no hay ganancias', () => {
    const fills = [makeLoss(-1), makeLoss(-2)];
    const metrics = calc.calculate(fills, 10000);
    expect(metrics.profitFactor).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// maxDrawdown
// ---------------------------------------------------------------------------

describe('MetricsCalculator — maxDrawdown', () => {
  const calc = new MetricsCalculator();

  test('maxDrawdown = 0 si solo hay ganancias', () => {
    const fills = [makeWin(1), makeWin(2), makeWin(3)];
    const metrics = calc.calculate(fills, 10000);
    expect(metrics.maxDrawdown).toBe(0);
  });

  test('maxDrawdown es positivo con pérdidas', () => {
    const fills = [makeWin(5), makeLoss(-10), makeWin(5)];
    const metrics = calc.calculate(fills, 10000);
    expect(metrics.maxDrawdown).toBeGreaterThan(0);
  });

  test('maxDrawdown captura la mayor caída relativa', () => {
    const fills = [
      makeFill({ pnl: 10 }),
      makeFill({ pnl: -20 }),
      makeFill({ pnl: 15 }),
    ];
    const metrics = calc.calculate(fills, 10000);
    expect(metrics.maxDrawdown).toBeCloseTo(20, 0);
  });
});

// ---------------------------------------------------------------------------
// resolution_confidence — suma 100%
// ---------------------------------------------------------------------------

describe('MetricsCalculator — resolution_confidence', () => {
  const calc = new MetricsCalculator();

  test('suma de los tres modos es 100% con trades mixtos', () => {
    const fills = [
      makeFill({ resolution_mode: 'PRECISE_1S' }),
      makeFill({ resolution_mode: 'PRECISE_1S' }),
      makeFill({ resolution_mode: 'PRECISE_1M' }),
      makeFill({ resolution_mode: 'PESSIMISTIC' }),
    ];

    const metrics = calc.calculate(fills, 10000);
    const conf = metrics.resolution_confidence;
    const sum  = conf.PRECISE_1S + conf.PRECISE_1M + conf.PESSIMISTIC;

    expect(sum).toBeCloseTo(100, 5);
  });

  test('PRECISE_1S = 50%, PRECISE_1M = 25%, PESSIMISTIC = 25%', () => {
    const fills = [
      makeFill({ resolution_mode: 'PRECISE_1S' }),
      makeFill({ resolution_mode: 'PRECISE_1S' }),
      makeFill({ resolution_mode: 'PRECISE_1M' }),
      makeFill({ resolution_mode: 'PESSIMISTIC' }),
    ];

    const { resolution_confidence } = calc.calculate(fills, 10000);

    expect(resolution_confidence.PRECISE_1S).toBe(50);
    expect(resolution_confidence.PRECISE_1M).toBe(25);
    expect(resolution_confidence.PESSIMISTIC).toBe(25);
  });

  test('suma sigue siendo 100% con todos los trades en un solo modo', () => {
    const fills = [
      makeFill({ resolution_mode: 'PESSIMISTIC' }),
      makeFill({ resolution_mode: 'PESSIMISTIC' }),
    ];

    const { resolution_confidence } = calc.calculate(fills, 10000);
    const sum = resolution_confidence.PRECISE_1S
              + resolution_confidence.PRECISE_1M
              + resolution_confidence.PESSIMISTIC;

    expect(sum).toBe(100);
    expect(resolution_confidence.PESSIMISTIC).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// tpBreakdown
// ---------------------------------------------------------------------------

describe('MetricsCalculator — tpBreakdown', () => {
  const calc = new MetricsCalculator();

  test('tpBreakdown cuenta hits por nivel', () => {
    const fills = [
      makeFill({ pnl: 1, exitFill: { type: 'TP1', tpLevel: 1, price: 31000, timestamp: 0 } }),
      makeFill({ pnl: 2, exitFill: { type: 'TP1', tpLevel: 1, price: 31000, timestamp: 0 } }),
      makeFill({ pnl: 3, exitFill: { type: 'TP2', tpLevel: 2, price: 32000, timestamp: 0 } }),
      makeFill({ pnl: -1, exitFill: { type: 'SL',  tpLevel: null, price: 29000, timestamp: 0 } }),
    ];

    const { tpBreakdown } = calc.calculate(fills, 10000);

    expect(tpBreakdown.tp1.hits).toBe(2);
    expect(tpBreakdown.tp2.hits).toBe(1);
    expect(tpBreakdown.tp3.hits).toBe(0);
  });

  test('tpBreakdown winRate = 100% si todos los TP1 ganan', () => {
    const fills = [
      makeFill({ pnl: 1, exitFill: { type: 'TP1', tpLevel: 1, price: 31000, timestamp: 0 } }),
      makeFill({ pnl: 2, exitFill: { type: 'TP1', tpLevel: 1, price: 31000, timestamp: 0 } }),
    ];

    const { tpBreakdown } = calc.calculate(fills, 10000);
    expect(tpBreakdown.tp1.winRate).toBe(100);
  });

  test('SL no aparece en tpBreakdown', () => {
    const fills = [
      makeLoss(-1),
      makeLoss(-2),
    ];

    const { tpBreakdown } = calc.calculate(fills, 10000);
    expect(tpBreakdown.tp1.hits).toBe(0);
    expect(tpBreakdown.tp2.hits).toBe(0);
    expect(tpBreakdown.tp3.hits).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// pessimistic_penalties
// ---------------------------------------------------------------------------

describe('MetricsCalculator — pessimistic_penalties', () => {
  const calc = new MetricsCalculator();

  test('cuenta los trades con had_ambiguity=true', () => {
    const fills = [
      makeFill({ had_ambiguity: true }),
      makeFill({ had_ambiguity: false }),
      makeFill({ had_ambiguity: true }),
    ];

    const { pessimistic_penalties } = calc.calculate(fills, 10000);
    expect(pessimistic_penalties).toBe(2);
  });

  test('pessimistic_penalties = 0 si ningún trade tiene ambigüedad', () => {
    const fills = [
      makeFill({ had_ambiguity: false }),
      makeFill({ had_ambiguity: false }),
    ];

    const { pessimistic_penalties } = calc.calculate(fills, 10000);
    expect(pessimistic_penalties).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// sharpeRatio y sortinoRatio
// ---------------------------------------------------------------------------

describe('MetricsCalculator — sharpeRatio y sortinoRatio', () => {
  const calc = new MetricsCalculator();

  test('sharpeRatio = 0 con un solo trade', () => {
    const fills  = [makeWin(1)];
    const metrics = calc.calculate(fills, 10000);
    expect(metrics.sharpeRatio).toBe(0);
  });

  test('sharpeRatio > 0 cuando la media es positiva', () => {
    const fills = [makeWin(2), makeWin(2), makeWin(2)];
    const metrics = calc.calculate(fills, 10000);
    expect(metrics.sharpeRatio).toBe(0);
  });

  test('sharpeRatio calculado con serie mixta', () => {
    const fills = [
      makeWin(2), makeLoss(-1), makeWin(3), makeLoss(-1), makeWin(2),
    ];
    const metrics = calc.calculate(fills, 10000);
    expect(typeof metrics.sharpeRatio).toBe('number');
    expect(metrics.sharpeRatio).toBeGreaterThan(0);
  });

  test('sortinoRatio = 0 si no hay pérdidas', () => {
    const fills   = [makeWin(1), makeWin(2), makeWin(3)];
    const metrics = calc.calculate(fills, 10000);
    expect(metrics.sortinoRatio).toBe(0);
  });

  test('sortinoRatio calculado con serie mixta', () => {
    const fills = [makeWin(2), makeLoss(-1), makeWin(3), makeLoss(-1)];
    const metrics = calc.calculate(fills, 10000);
    expect(typeof metrics.sortinoRatio).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// finalCapital y expectancy
// ---------------------------------------------------------------------------

describe('MetricsCalculator — finalCapital y expectancy', () => {
  const calc = new MetricsCalculator();

  test('finalCapital > initialCapital con trades ganadores', () => {
    const fills  = [makeWin(5), makeWin(5)];
    const metrics = calc.calculate(fills, 10000);
    expect(metrics.finalCapital).toBeGreaterThan(10000);
  });

  test('finalCapital < initialCapital con trades perdedores', () => {
    const fills  = [makeLoss(-5), makeLoss(-5)];
    const metrics = calc.calculate(fills, 10000);
    expect(metrics.finalCapital).toBeLessThan(10000);
  });

  test('expectancy es la media aritmética de los PnL', () => {
    const fills = [makeWin(2), makeLoss(-1), makeWin(3)];
    const metrics = calc.calculate(fills, 10000);
    expect(metrics.expectancy).toBeCloseTo(4 / 3, 5);
  });
});
