/**
 * scripts/lib/strategyFactory.ts
 *
 * Punto único de registro de estrategias para la CLI y el bucle de iteración.
 * Mapea un "tipo" estable (string) → constructor que recibe un objeto de params.
 *
 * Cuando la IA crea una estrategia nueva en src/strategy/strategies/, la
 * registra aquí con una línea: su tipo, sus defaults y cómo construirla.
 * El `id` real de la corrida lo sigue dando la estrategia (suele incluir el
 * timeframe, p.ej. `spinning-top-fib-1m`).
 */

import SpinningTopFibStrategy   from '../../src/strategy/strategies/SpinningTopFibStrategy.js';
import WhipsawReversionStrategy from '../../src/strategy/strategies/WhipsawReversionStrategy.js';
import MarubozuLongStrategy     from '../../src/strategy/strategies/MarubozuLongStrategy.js';
import type StrategyBase        from '../../src/strategy/StrategyBase.js';

type Params = Record<string, unknown>;

interface StrategyEntry {
  /** Params por defecto. `--params` se mergea (deep) sobre estos. */
  defaults: Params;
  /** Construye la instancia con los params ya mergeados. */
  build: (params: Params) => StrategyBase;
}

export const STRATEGY_TYPES: Record<string, StrategyEntry> = {
  'spinning-top-fib': {
    defaults: {
      candleInterval:    1,
      maxBodyPercent:    30,
      minRangePercent:   0.3,
      zone1:             { min: 1.8, max: 2.1 },
      zone2:             { min: 2.618, max: 3.0 },
      spinningTopMode:   'SINGLE_LAST',
      tp1SizePercent:    50,
      tp1RR:             1.0,
      tp2RR:             null,
      moveSlToBreakeven: true,
    },
    build: (p) => new SpinningTopFibStrategy(p as never),
  },

  'whipsaw-reversion': {
    defaults: {
      candleInterval:        1,
      volatilityMultiplier:  3,
      smaPeriod:             50,
      displacementThreshold: 0.3,
      minBars:               5,
      maxBars:               20,
      projMin:               1.8,
      projMax:               2.1,
      tp1SizePercent:        50,
      tp1RR:                 1.0,
      tp2RR:                 null,
      moveSlToBreakeven:     true,
      riskPercent:           1,
    },
    build: (p) => new WhipsawReversionStrategy(p as never),
  },

  'marubozu-long': {
    defaults: {
      minRangePercent:   0.3,
      maxWickPercent:    15,
      slMult:            1.0,
      tp1RR:             1.0,
      tp1SizePercent:    100,
      tp2RR:             null,
      moveSlToBreakeven: false,
      riskPercent:       1,
    },
    build: (p) => new MarubozuLongStrategy(p as never),
  },
};

/** Merge profundo simple: los objetos planos se fusionan, el resto se reemplaza. */
function deepMerge(base: Params, override: Params): Params {
  const out: Params = { ...base };
  for (const [k, v] of Object.entries(override)) {
    const bv = out[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && bv && typeof bv === 'object' && !Array.isArray(bv)) {
      out[k] = deepMerge(bv as Params, v as Params);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Construye una estrategia por tipo, mergeando params sobre los defaults.
 * Lanza si el tipo no está registrado.
 */
export function buildStrategy(type: string, params: Params = {}): { strategy: StrategyBase; resolvedParams: Params } {
  const entry = STRATEGY_TYPES[type];
  if (!entry) {
    const known = Object.keys(STRATEGY_TYPES).join(', ');
    throw new Error(`Estrategia desconocida: "${type}". Tipos registrados: ${known}`);
  }
  const resolvedParams = deepMerge(entry.defaults, params);
  return { strategy: entry.build(resolvedParams), resolvedParams };
}
