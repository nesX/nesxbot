# Feature: Indicadores Técnicos Reutilizables

**Fecha:** 2026-03-31
**Estado:** Diseño

---

## Problema

Las estrategias calculan indicadores de forma inline y ad-hoc. FibonacciVolumeStrategy
calcula SMA(20) de volumen manualmente con `slice(-20).reduce(...)`. Si otra estrategia
necesita SMA o cualquier otro indicador, duplica el cálculo.

Queremos agregar RSI, MACD, EMA, SMA (y futuros indicadores) como módulos reutilizables
que cualquier estrategia pueda consumir sin duplicar lógica.

**Caso de uso concreto:** En SpinningTopFibStrategy, filtrar entradas con condiciones como:
- SHORT solo si RSI > 70 (sobrecompra)
- LONG solo si RSI < 30 (sobreventa)
- SHORT solo si MACD histograma > 0 (momentum alcista agotándose)
- LONG solo si MACD histograma < 0 (momentum bajista agotándose)

---

## Principios de diseño

1. **Funciones puras** — un indicador recibe velas, retorna valores. Sin estado, sin IO.
2. **Sin acoplamiento al sistema** — los indicadores no conocen MarketState, MessageBroker,
   ni TimeProvider. Son funciones matemáticas sobre arrays de números.
3. **Composición, no herencia** — las estrategias componen indicadores llamando funciones.
   No heredan de una clase "StrategyWithIndicators".
4. **Incremental cuando sea posible** — para uso en live (vela a vela), los indicadores
   con estado (EMA, RSI) ofrecen versión incremental además de la versión batch.
5. **Un archivo por indicador** — facilita testing y tree-shaking.

---

## Ubicación

```
src/
├── indicators/
│   ├── index.ts            ← re-exports públicos
│   ├── sma.ts              ← Simple Moving Average
│   ├── ema.ts              ← Exponential Moving Average
│   ├── rsi.ts              ← Relative Strength Index
│   ├── macd.ts             ← MACD + Signal + Histogram
│   └── __tests__/
│       ├── sma.test.ts
│       ├── ema.test.ts
│       ├── rsi.test.ts
│       └── macd.test.ts
```

**Por qué `src/indicators/` y no `src/strategy/indicators/`:**
Los indicadores son cálculos matemáticos genéricos. No pertenecen al módulo strategy
conceptualmente, aunque las estrategias son su consumidor principal. Otros módulos
(NotificationEngine, dashboards, métricas) podrían usarlos también.

---

## API propuesta

### SMA

```typescript
// src/indicators/sma.ts

/** Calcula SMA sobre los últimos `period` valores del array. */
export function sma(values: number[], period: number): number | null;

/** Calcula SMA para cada posición del array (retorna array del mismo largo, con nulls iniciales). */
export function smaArray(values: number[], period: number): (number | null)[];
```

### EMA

```typescript
// src/indicators/ema.ts

/** Calcula EMA sobre los últimos valores. Usa SMA como semilla de los primeros `period` valores. */
export function ema(values: number[], period: number): number | null;

/** Serie completa de EMA. */
export function emaArray(values: number[], period: number): (number | null)[];

/**
 * EMA incremental: dado el EMA anterior y un nuevo valor, calcula el siguiente EMA.
 * Útil en modo live donde llega una vela a la vez.
 */
export function emaStep(prevEma: number, newValue: number, period: number): number;
```

### RSI

```typescript
// src/indicators/rsi.ts

export interface RSIResult {
  rsi: number;
  avgGain: number;
  avgLoss: number;
}

/** Calcula RSI (Wilder) sobre los últimos valores de close. Period por defecto: 14. */
export function rsi(closes: number[], period?: number): number | null;

/** Serie completa de RSI. */
export function rsiArray(closes: number[], period?: number): (number | null)[];

/**
 * RSI incremental: dado avgGain/avgLoss anteriores y el cambio actual,
 * retorna el nuevo RSI. Para uso vela a vela en live.
 */
export function rsiStep(prev: RSIResult, change: number, period?: number): RSIResult;
```

### MACD

```typescript
// src/indicators/macd.ts

export interface MACDResult {
  macd: number;       // EMA(fast) - EMA(slow)
  signal: number;     // EMA(signalPeriod) del MACD
  histogram: number;  // macd - signal
}

export interface MACDConfig {
  fastPeriod?: number;    // default 12
  slowPeriod?: number;    // default 26
  signalPeriod?: number;  // default 9
}

/** Calcula MACD del último punto. */
export function macd(closes: number[], config?: MACDConfig): MACDResult | null;

/** Serie completa de MACD. */
export function macdArray(closes: number[], config?: MACDConfig): (MACDResult | null)[];
```

---

## Cómo consume una estrategia

Los indicadores son funciones puras. La estrategia extrae closes (u otros valores)
del array de velas y los pasa al indicador. No hay setup, no hay suscripciones.

### Ejemplo: SpinningTopFibStrategy con filtro RSI + MACD

```typescript
import { rsi } from '../../indicators/rsi.js';
import { macd } from '../../indicators/macd.js';

// Dentro de evaluate():
async evaluate(state: MarketState): Promise<TradePlan | null> {
  const candles1m = state.candles['1m'];
  if (!candles1m || candles1m.length < 30) return null;

  // ... detección del trompo y zonas (lógica existente) ...

  // Antes de emitir el TradePlan, verificar condiciones de indicadores
  const plan = this._buildTradePlan(zone, state);
  if (!plan) return null;

  // Extraer closes para indicadores
  const closes = candles1m.map(c => c.close);

  // Filtro RSI
  const currentRsi = rsi(closes, 14);
  if (currentRsi !== null) {
    if (plan.direction === 'SHORT' && currentRsi < 70) return null;  // no shortear sin sobrecompra
    if (plan.direction === 'LONG'  && currentRsi > 30) return null;  // no comprar sin sobreventa
  }

  // Filtro MACD
  const currentMacd = macd(closes);
  if (currentMacd !== null) {
    if (plan.direction === 'SHORT' && currentMacd.histogram < 0) return null;  // momentum ya bajista
    if (plan.direction === 'LONG'  && currentMacd.histogram > 0) return null;  // momentum ya alcista
  }

  return plan;
}
```

### Por qué funciones y no clases

- **Sin estado compartido** — cada llamada a `rsi(closes, 14)` es independiente.
  No hay riesgo de que dos estrategias interfieran entre sí.
- **Testeable trivialmente** — `expect(rsi([44, 44.34, ...], 14)).toBeCloseTo(70.53)`.
- **Funciona en backtest y live sin cambios** — en backtest recibe 500 closes acumulados,
  en live recibe las mismas velas del buffer del MarketStateBuilder.
- **Composición libre** — una estrategia puede usar RSI(14), RSI(7), MACD y SMA(200)
  sin necesidad de "registrar" indicadores en ningún lado.

---

## Patrón para hacer los filtros configurables

Para no hardcodear umbrales (RSI > 70, MACD > 0), los filtros se configuran como
parte del config de la estrategia:

```typescript
export interface SpinningTopFibConfig {
  // ... campos existentes ...

  /** Filtros opcionales de indicadores. Si undefined, no se aplican. */
  filters?: {
    rsi?: {
      period: number;       // default 14
      overbought: number;   // ej: 70 — SHORT solo si RSI > este valor
      oversold: number;     // ej: 30 — LONG solo si RSI < este valor
    };
    macd?: {
      fastPeriod?: number;
      slowPeriod?: number;
      signalPeriod?: number;
      /** 'histogram' = filtrar por signo del histograma. 'signal' = filtrar por cruce. */
      mode: 'histogram' | 'signal';
    };
  };
}
```

De esta forma los filtros son opcionales (backwards compatible), configurables desde
el CLI del backtest, y variables en el grid search.

---

## Impacto en grid search

Nuevas dimensiones que se pueden agregar al GRID:

```typescript
const GRID = {
  // ... parámetros existentes ...
  rsiPeriod:      [null, 14],         // null = sin filtro RSI
  rsiOverbought:  [65, 70, 75, 80],
  rsiOversold:    [20, 25, 30, 35],
  macdFilter:     [null, 'histogram'], // null = sin filtro MACD
};
```

Esto se haría en una nueva fase de optimización (Fase 8+), después de validar
la estrategia base sin indicadores.

---

## Validación de fórmulas

Cada indicador debe tener tests que validen contra valores conocidos de referencia.
Fuentes confiables para valores de referencia:

- **TradingView** — exportar serie de RSI/MACD y comparar con nuestra implementación
- **Investopedia** — ejemplos paso a paso con valores numéricos
- **ta-lib / pandas-ta** — correr los mismos datos en Python y comparar outputs

### RSI — fórmula Wilder (la estándar)

```
change = close[i] - close[i-1]
gain   = max(change, 0)
loss   = max(-change, 0)

avgGain[0..period] = SMA(gains, period)
avgLoss[0..period] = SMA(losses, period)

avgGain[i] = (avgGain[i-1] * (period-1) + gain[i]) / period   // smoothing de Wilder
avgLoss[i] = (avgLoss[i-1] * (period-1) + loss[i]) / period

RS  = avgGain / avgLoss
RSI = 100 - (100 / (1 + RS))
```

### MACD — fórmula estándar

```
MACD line = EMA(close, fast) - EMA(close, slow)          // default fast=12, slow=26
Signal    = EMA(MACD line, signalPeriod)                  // default signalPeriod=9
Histogram = MACD line - Signal
```

### EMA — fórmula estándar

```
multiplier = 2 / (period + 1)
EMA[0]     = SMA(values[0..period])                       // semilla
EMA[i]     = (value[i] - EMA[i-1]) * multiplier + EMA[i-1]
```

---

## Plan de implementación

| Paso | Qué | Dependencia |
|------|-----|------------|
| 1 | Crear `src/indicators/sma.ts` + tests | Ninguna |
| 2 | Crear `src/indicators/ema.ts` + tests | SMA (usa SMA como semilla) |
| 3 | Crear `src/indicators/rsi.ts` + tests | Ninguna (usa EMA de Wilder internamente) |
| 4 | Crear `src/indicators/macd.ts` + tests | EMA |
| 5 | Crear `src/indicators/index.ts` (barrel) | Pasos 1-4 |
| 6 | Agregar `filters?` al config de SpinningTopFibStrategy | Pasos 3-4 |
| 7 | Agregar flags CLI: `--rsi-period`, `--rsi-ob`, `--rsi-os`, `--macd` | Paso 6 |
| 8 | Agregar dimensiones al grid search | Paso 7 |

Los pasos 1-5 son independientes del proceso de optimización en curso.
El paso 6+ se hace después de completar las fases de optimización de la estrategia base.

---

## Notas

- **Performance:** RSI(14) sobre 500 closes es ~0.01ms. No es un cuello de botella.
  En grid search con miles de evaluaciones, el costo acumulado sigue siendo despreciable
  comparado con el FillSimulator y las queries a BD.
- **No usar librerías externas** — son funciones de <50 líneas cada una. Una dependencia
  como `technicalindicators` o `ta-lib` agrega complejidad de instalación (native bindings)
  sin beneficio real.
- **Indicadores futuros** — Bollinger Bands, ATR, Stochastic, VWAP siguen el mismo
  patrón (función pura, un archivo, tests con valores de referencia). El directorio
  `src/indicators/` escala sin cambios de arquitectura.
