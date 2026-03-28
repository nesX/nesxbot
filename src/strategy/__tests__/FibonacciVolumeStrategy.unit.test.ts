/**
 * FibonacciVolumeStrategy.unit.test.ts
 *
 * Tests unitarios de la estrategia FibonacciVolumeStrategy.
 * Sin dependencias externas — solo la estrategia y helpers de fixtures.
 */

import FibonacciVolumeStrategy from '../strategies/FibonacciVolumeStrategy.js';
import type { Candle, MarketState } from '../../types.js';

// ---------------------------------------------------------------------------
// Helpers / Fixtures
// ---------------------------------------------------------------------------

interface MakeCandlesOptions {
  count?: number;
  normalVolume?: number;
  highVolumeIndex?: number | null;
  multiplier?: number;
  baseOpenTime?: number;
  closeOverride?: number;
}

/**
 * Genera un array de velas con volumen "normal" (suficientes para SMA20).
 * Si se especifica `highVolumeIndex`, la vela en esa posición tendrá volumen
 * `multiplier` × normalVolume. Sin `highVolumeIndex` todas las velas son normales.
 */
function makeCandles({
  count           = 25,
  normalVolume    = 100,
  highVolumeIndex = null,
  multiplier      = 6,
  baseOpenTime    = 1_700_000_000_000,
  closeOverride,
}: MakeCandlesOptions = {}): Candle[] {
  const realHighIndex = highVolumeIndex === null
    ? null
    : (highVolumeIndex < 0 ? count + highVolumeIndex : highVolumeIndex);

  return Array.from({ length: count }, (_, i): Candle => ({
    symbol:    'BTCUSDT',
    timeframe: '1m',
    openTime:  baseOpenTime + i * 60_000,
    open:      30000,
    high:      30500,
    low:       29900,
    close:     closeOverride !== undefined ? closeOverride : 30200,
    volume:    (realHighIndex !== null && i === realHighIndex)
                 ? normalVolume * multiplier
                 : normalVolume,
    isClosed:  true,
  }));
}

/**
 * Construye un MarketState mínimo.
 */
function makeState(candles: Candle[], currentPrice?: number): MarketState {
  const lastCandle = candles.length > 0 ? candles[candles.length - 1] : null;
  return {
    symbol:       'BTCUSDT',
    timestamp:    lastCandle ? lastCandle.openTime : 0,
    candles:      { '1m': candles },
    currentPrice: currentPrice !== undefined
      ? currentPrice
      : (lastCandle ? lastCandle.close : 0),
  };
}

// ---------------------------------------------------------------------------
// Constructor / Contrato StrategyBase
// ---------------------------------------------------------------------------

describe('FibonacciVolumeStrategy — contrato StrategyBase', () => {
  test('id retorna "fibonacci-volume-v1"', () => {
    const s = new FibonacciVolumeStrategy();
    expect(s.id).toBe('fibonacci-volume-v1');
  });

  test('requiredTimeframes retorna ["1m"]', () => {
    const s = new FibonacciVolumeStrategy();
    expect(s.requiredTimeframes).toEqual(['1m']);
  });

  test('evaluate() es async y retorna null cuando no hay señal', async () => {
    const s      = new FibonacciVolumeStrategy();
    const candles = makeCandles(); // sin alto volumen
    const result  = await s.evaluate(makeState(candles));
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Detección de vela de alto volumen
// ---------------------------------------------------------------------------

describe('FibonacciVolumeStrategy — detección de alto volumen', () => {
  test('no detecta alto volumen con velas normales', async () => {
    const s      = new FibonacciVolumeStrategy();
    const candles = makeCandles({ count: 25 }); // todas con volumen normal
    await s.evaluate(makeState(candles));
    expect(s.armedZone).toBeNull();
  });

  test('detecta vela con volumen > 5x SMA(20)', async () => {
    const s = new FibonacciVolumeStrategy();
    // Alta última vela (índice -1): 6x el volumen normal
    const candles = makeCandles({ highVolumeIndex: -1, multiplier: 6 });
    await s.evaluate(makeState(candles));
    expect(s.armedZone).not.toBeNull();
  });

  test('no detecta si volumen es exactamente 5x SMA (no supera)', async () => {
    const s = new FibonacciVolumeStrategy();
    // Exactamente 5x: 5 * 100 = 500 — no debe superar
    const candles = makeCandles({ highVolumeIndex: -1, multiplier: 5 });
    await s.evaluate(makeState(candles));
    expect(s.armedZone).toBeNull();
  });

  test('detecta si volumen es 5.01x SMA', async () => {
    const s           = new FibonacciVolumeStrategy();
    const normalVolume = 100;
    const candles      = makeCandles({ normalVolume, count: 25 });
    candles[candles.length - 1].volume = 501; // 5.01x

    await s.evaluate(makeState(candles));
    expect(s.armedZone).not.toBeNull();
  });

  test('no activa zona si no hay suficientes velas para SMA(20)', async () => {
    const s      = new FibonacciVolumeStrategy();
    // Solo 15 velas — menos que SMA(20) + 1
    const candles = makeCandles({ count: 15, highVolumeIndex: -1, multiplier: 10 });
    await s.evaluate(makeState(candles));
    expect(s.armedZone).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// STRATEGY_ZONE_ARMED: callback onZoneArmed
// ---------------------------------------------------------------------------

describe('FibonacciVolumeStrategy — onZoneArmed', () => {
  test('llama onZoneArmed cuando detecta vela de alto volumen', async () => {
    const onZoneArmed = vi.fn();
    const s           = new FibonacciVolumeStrategy({ onZoneArmed });
    const candles     = makeCandles({ highVolumeIndex: -1, multiplier: 6 });

    await s.evaluate(makeState(candles));

    expect(onZoneArmed).toHaveBeenCalledTimes(1);
  });

  test('payload de onZoneArmed contiene strategyId, symbol, levels y triggerCandle', async () => {
    const onZoneArmed = vi.fn();
    const s           = new FibonacciVolumeStrategy({ onZoneArmed });
    const candles     = makeCandles({ highVolumeIndex: -1, multiplier: 6 });

    await s.evaluate(makeState(candles));

    const payload = onZoneArmed.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toHaveProperty('strategyId', 'fibonacci-volume-v1');
    expect(payload).toHaveProperty('symbol', 'BTCUSDT');
    expect(payload).toHaveProperty('levels');
    expect(payload).toHaveProperty('triggerCandle');
    expect(Array.isArray(payload.levels)).toBe(true);
  });

  test('no lanza si onZoneArmed no se provee', async () => {
    const s       = new FibonacciVolumeStrategy(); // sin callbacks
    const candles = makeCandles({ highVolumeIndex: -1, multiplier: 6 });

    await expect(s.evaluate(makeState(candles))).resolves.not.toThrow();
  });

  test('retorna null en la vela de activación (no señal inmediata)', async () => {
    const s       = new FibonacciVolumeStrategy();
    const candles = makeCandles({ highVolumeIndex: -1, multiplier: 6 });
    const result  = await s.evaluate(makeState(candles));
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cálculo de niveles Fibonacci
// ---------------------------------------------------------------------------

describe('FibonacciVolumeStrategy — cálculo de niveles Fibonacci', () => {
  /**
   * Vela disparadora: high=30500, low=29900, range=600
   *
   * Niveles esperados:
   *   Por encima (low + range * mult):
   *     1.8   → 29900 + 1080 = 30980
   *     2.1   → 29900 + 1260 = 31160
   *     2.618 → 29900 + 1570.8 = 31470.8
   *     3.0   → 29900 + 1800 = 31700
   *   Por debajo:
   *    -0.8   → 29900 + (-480) = 29420
   *    -1.1   → 29900 + (-660) = 29240
   *    -1.618 → 29900 + (-970.8) = 28929.2
   *    -2.0   → 29900 + (-1200) = 28700
   */
  function triggerCandles(): Candle[] {
    const candles = makeCandles({ count: 25, normalVolume: 100, highVolumeIndex: -1 });
    // Fijar high y low de la última vela para cálculos deterministas
    const last    = candles[candles.length - 1];
    last.high      = 30500;
    last.low       = 29900;
    last.volume    = 601; // 6.01x → supera 5x SMA(100) = 500
    return candles;
  }

  test('genera 8 niveles (4 por encima + 4 por debajo)', async () => {
    const s      = new FibonacciVolumeStrategy();
    await s.evaluate(makeState(triggerCandles()));
    expect(s.armedZone!.levels).toHaveLength(8);
  });

  test('los 4 niveles por encima tienen direction LONG', async () => {
    const s = new FibonacciVolumeStrategy();
    await s.evaluate(makeState(triggerCandles()));
    const longs = s.armedZone!.levels.filter(l => l.direction === 'LONG');
    expect(longs).toHaveLength(4);
  });

  test('los 4 niveles por debajo tienen direction SHORT', async () => {
    const s = new FibonacciVolumeStrategy();
    await s.evaluate(makeState(triggerCandles()));
    const shorts = s.armedZone!.levels.filter(l => l.direction === 'SHORT');
    expect(shorts).toHaveLength(4);
  });

  test('nivel 1.8 calculado correctamente', async () => {
    const s = new FibonacciVolumeStrategy();
    await s.evaluate(makeState(triggerCandles()));
    const level = s.armedZone!.levels.find(l => l.multiplier === 1.8);
    expect(level).toBeDefined();
    expect(level!.price).toBeCloseTo(30980, 5);
    expect(level!.direction).toBe('LONG');
  });

  test('nivel 2.618 calculado correctamente', async () => {
    const s = new FibonacciVolumeStrategy();
    await s.evaluate(makeState(triggerCandles()));
    const level = s.armedZone!.levels.find(l => l.multiplier === 2.618);
    expect(level).toBeDefined();
    expect(level!.price).toBeCloseTo(29900 + 600 * 2.618, 5);
  });

  test('nivel -1.618 calculado correctamente', async () => {
    const s = new FibonacciVolumeStrategy();
    await s.evaluate(makeState(triggerCandles()));
    const level = s.armedZone!.levels.find(l => l.multiplier === -1.618);
    expect(level).toBeDefined();
    expect(level!.price).toBeCloseTo(29900 + 600 * (-1.618), 5);
    expect(level!.direction).toBe('SHORT');
  });
});

// ---------------------------------------------------------------------------
// STRATEGY_ZONE_DISARMED: desarmado por nueva vela de alto volumen
// ---------------------------------------------------------------------------

describe('FibonacciVolumeStrategy — onZoneDisarmed', () => {
  test('desarma zona cuando llega nueva vela de alto volumen', async () => {
    const s       = new FibonacciVolumeStrategy();
    // Ronda 1: armar zona
    const round1  = makeCandles({ highVolumeIndex: -1, multiplier: 6 });
    await s.evaluate(makeState(round1));
    expect(s.armedZone).not.toBeNull();

    // Ronda 2: nueva vela de alto volumen agrega una vela más al final
    const lastRound1 = round1[round1.length - 1];
    const round2: Candle[] = [...round1, {
      ...lastRound1,
      openTime: lastRound1.openTime + 60_000,
      volume:   600 * 6, // 6x el promedio anterior
    }];
    await s.evaluate(makeState(round2));
    // La zona anterior fue desarmada y se armó una nueva
    expect(s.armedZone).not.toBeNull();
    // El triggerCandle de la nueva zona debe ser la última vela
    expect(s.armedZone!.triggerCandle.openTime).toBe(round2[round2.length - 1].openTime);
  });

  test('llama onZoneDisarmed cuando nueva vela de alto volumen invalida zona', async () => {
    const onZoneArmed    = vi.fn();
    const onZoneDisarmed = vi.fn();
    const s = new FibonacciVolumeStrategy({ onZoneArmed, onZoneDisarmed });

    // Ronda 1: armar zona
    const round1 = makeCandles({ highVolumeIndex: -1, multiplier: 6 });
    await s.evaluate(makeState(round1));
    expect(onZoneArmed).toHaveBeenCalledTimes(1);
    expect(onZoneDisarmed).toHaveBeenCalledTimes(0);

    // Ronda 2: otra vela de alto volumen
    const lastRound1 = round1[round1.length - 1];
    const round2: Candle[] = [...round1, {
      ...lastRound1,
      openTime: lastRound1.openTime + 60_000,
      volume:   600 * 6,
    }];
    await s.evaluate(makeState(round2));

    expect(onZoneDisarmed).toHaveBeenCalledTimes(1);
    const disarmPayload = onZoneDisarmed.mock.calls[0][0] as Record<string, unknown>;
    expect(disarmPayload).toHaveProperty('strategyId', 'fibonacci-volume-v1');
    expect(disarmPayload).toHaveProperty('symbol', 'BTCUSDT');
    expect(disarmPayload).toHaveProperty('reason');
  });

  test('llama onZoneDisarmed cuando nivel es tocado y señal generada', async () => {
    const onZoneDisarmed = vi.fn();
    const s = new FibonacciVolumeStrategy({ onZoneDisarmed });

    // Armar zona con vela high=30500, low=29900, range=600
    const candles = makeCandles({ count: 25, normalVolume: 100 });
    candles[candles.length - 1].high   = 30500;
    candles[candles.length - 1].low    = 29900;
    candles[candles.length - 1].volume = 601;

    await s.evaluate(makeState(candles));
    expect(s.armedZone).not.toBeNull();
    expect(onZoneDisarmed).toHaveBeenCalledTimes(0);

    // Vela siguiente con precio en nivel 1.8 = 30980
    const lastCandle = candles[candles.length - 1];
    const nextCandles: Candle[] = [...candles, {
      ...candles[0],
      openTime: lastCandle.openTime + 60_000,
      close:    30980,
      volume:   100,
    }];
    const result = await s.evaluate(makeState(nextCandles, 30980));

    expect(result).not.toBeNull();
    expect(onZoneDisarmed).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Generación de TradePlan
// ---------------------------------------------------------------------------

describe('FibonacciVolumeStrategy — TradePlan', () => {
  /**
   * Escenario: vela disparadora high=30500, low=29900, range=600
   * Nivel 1.8 LONG = 30980
   */
  async function armAndTouch(touchPrice: number) {
    const s       = new FibonacciVolumeStrategy();
    const candles = makeCandles({ count: 25, normalVolume: 100 });
    const last    = candles[candles.length - 1];
    last.high   = 30500;
    last.low    = 29900;
    last.volume = 601;

    await s.evaluate(makeState(candles));

    const nextCandles: Candle[] = [...candles, {
      ...last,
      openTime: last.openTime + 60_000,
      close:    touchPrice,
      volume:   100,
    }];

    return s.evaluate(makeState(nextCandles, touchPrice));
  }

  test('retorna TradePlan cuando precio toca nivel Fibonacci', async () => {
    const result = await armAndTouch(30980); // nivel 1.8
    expect(result).not.toBeNull();
  });

  test('TradePlan tiene todos los campos requeridos del contrato', async () => {
    const result = await armAndTouch(30980);
    expect(result).toMatchObject({
      strategyId:  'fibonacci-volume-v1',
      symbol:      'BTCUSDT',
      direction:   expect.stringMatching(/^(LONG|SHORT)$/),
      entryPrice:  expect.any(Number),
      stopLoss:    expect.any(Number),
      takeProfits: expect.any(Array),
      riskPercent: expect.any(Number),
      metadata:    expect.any(Object),
    });
  });

  test('direction es LONG para niveles por encima del high', async () => {
    const result = await armAndTouch(30980); // nivel 1.8 LONG
    expect(result!.direction).toBe('LONG');
  });

  test('direction es SHORT para niveles por debajo del low', async () => {
    // Nivel -0.8 = 29900 + (600 * -0.8) = 29900 - 480 = 29420
    const result = await armAndTouch(29420);
    expect(result!.direction).toBe('SHORT');
  });

  test('stopLoss LONG es el low de la vela disparadora', async () => {
    const result = await armAndTouch(30980);
    expect(result!.stopLoss).toBe(29900);
  });

  test('stopLoss SHORT es el high de la vela disparadora', async () => {
    const result = await armAndTouch(29420);
    expect(result!.stopLoss).toBe(30500);
  });

  test('entryPrice es el precio del nivel tocado', async () => {
    const level18 = 29900 + 600 * 1.8; // 30980
    const result  = await armAndTouch(level18);
    expect(result!.entryPrice).toBeCloseTo(level18, 5);
  });

  test('takeProfits es array no vacío con sizePercent sumando 100', async () => {
    const result = await armAndTouch(30980);
    expect(result!.takeProfits.length).toBeGreaterThan(0);
    const total = result!.takeProfits.reduce((sum, tp) => sum + tp.sizePercent, 0);
    expect(total).toBe(100);
  });

  test('metadata contiene triggerCandle y fibLevels', async () => {
    const result = await armAndTouch(30980);
    const meta = result!.metadata as Record<string, unknown>;
    expect(meta).toHaveProperty('triggerCandle');
    expect(meta).toHaveProperty('fibLevels');
    expect(meta.fibLevels as Record<string, unknown>).toHaveProperty('touched');
    expect(meta.fibLevels as Record<string, unknown>).toHaveProperty('allLevels');
  });

  test('retorna null si precio no toca ningún nivel', async () => {
    const s       = new FibonacciVolumeStrategy();
    const candles = makeCandles({ count: 25, normalVolume: 100 });
    candles[candles.length - 1].volume = 601;

    await s.evaluate(makeState(candles));

    // Precio lejos de cualquier nivel
    const nextCandles: Candle[] = [...candles, {
      ...candles[0],
      openTime: candles[candles.length - 1].openTime + 60_000,
      close:    30200, // precio neutro
      volume:   100,
    }];
    const result = await s.evaluate(makeState(nextCandles, 30200));
    expect(result).toBeNull();
  });

  test('zona queda desarmada después de generar señal', async () => {
    const s       = new FibonacciVolumeStrategy();
    const candles = makeCandles({ count: 25, normalVolume: 100 });
    const last    = candles[candles.length - 1];
    last.high   = 30500;
    last.low    = 29900;
    last.volume = 601;

    await s.evaluate(makeState(candles));

    const nextCandles: Candle[] = [...candles, {
      ...last,
      openTime: last.openTime + 60_000,
      close:    30980,
      volume:   100,
    }];
    await s.evaluate(makeState(nextCandles, 30980));

    expect(s.armedZone).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Casos de borde
// ---------------------------------------------------------------------------

describe('FibonacciVolumeStrategy — casos de borde', () => {
  test('retorna null con array de velas vacío', async () => {
    const s      = new FibonacciVolumeStrategy();
    const result = await s.evaluate(makeState([]));
    expect(result).toBeNull();
  });

  test('retorna null con exactamente 20 velas (SMA20 requiere 21+)', async () => {
    const s       = new FibonacciVolumeStrategy();
    const candles = makeCandles({ count: 20, highVolumeIndex: -1, multiplier: 10 });
    const result  = await s.evaluate(makeState(candles));
    expect(result).toBeNull();
  });

  test('retorna null si candles["1m"] no existe en el state', async () => {
    const s      = new FibonacciVolumeStrategy();
    const result = await s.evaluate({
      symbol:       'BTCUSDT',
      timestamp:    0,
      candles:      {}, // sin "1m"
      currentPrice: 30000,
    });
    expect(result).toBeNull();
  });
});
