# Feature: Motor de Estadísticas de Mercado

**Fecha:** 2026-03-31
**Estado:** Diseño

---

## Problema

Queremos responder preguntas sobre el comportamiento del mercado:
- "Después de una vela con volumen > 500 BTC en 1m, ¿qué % de las siguientes 5 velas cierra por encima del high de esa vela?"
- "¿Cuántas rachas de 3 velas alcistas consecutivas hay en un mes? ¿Con qué frecuencia?"
- "¿Qué porcentaje de velas con rango > 0.5% del precio ocurren en horario europeo?"

Cada pregunta es diferente pero comparte el mismo patrón: cargar una serie de velas y ejecutar un análisis sobre ellas. El objetivo es un motor genérico donde agregar una nueva estadística no requiera modificar el núcleo.

---

## Arquitectura

### Principio central: Analyzer como plugin

El motor carga velas y las entrega a cada analyzer como una **ventana deslizante**. Cada analyzer es autónomo: declara cuántas velas necesita antes y después de la vela actual, acumula estado, y al final produce un resultado.

```
CandleLoader
    ↓ Candle[]
StatsEngine
    ↓ CandleWindow (por cada posición válida)
    ├── Analyzer 1  →  AnalyzerResult
    ├── Analyzer 2  →  AnalyzerResult
    └── Analyzer N  →  AnalyzerResult
        ↓
    Reporter (tabla, JSON, CSV)
```

### Ventana deslizante

Para cada posición `i` en la serie, el motor construye:

```
lookback[0..L-1]   candle[i]   lookahead[0..F-1]
←── pasado ───────  actual  ────── futuro ──────→
```

- `lookback`: las L velas anteriores (para contexto: medias, tendencia previa)
- `candle`: la vela en evaluación
- `lookahead`: las F velas siguientes (para medir consecuencias)

El motor salta posiciones donde no hay suficiente lookback o lookahead. Esto es determinístico y sin estado compartido entre analyzers.

---

## Interfaces

```typescript
// scripts/stats/types.ts

export interface CandleWindow {
  symbol:    string;
  timeframe: string;
  index:     number;       // posición en la serie completa
  candle:    Candle;       // vela en evaluación
  lookback:  Candle[];     // candle[-L .. -1], más reciente al final
  lookahead: Candle[];     // candle[+1 .. +F], más antiguo primero
}

export interface AnalyzerResult {
  name:     string;
  rows:     Record<string, unknown>[];   // filas de la tabla de resultados
  summary?: Record<string, unknown>;    // métricas agregadas opcionales
}

export interface Analyzer {
  readonly name:        string;
  readonly description: string;
  readonly lookback:    number;   // cuántas velas previas necesita
  readonly lookahead:   number;   // cuántas velas futuras necesita

  /** Llamado por el motor para cada ventana válida. */
  process(window: CandleWindow): void;

  /** Retorna el resultado acumulado. No modifica estado interno. */
  result(): AnalyzerResult;

  /** Reinicia el estado interno (para reutilizar el analyzer en otro rango). */
  reset(): void;
}
```

---

## Motor

```typescript
// scripts/stats/StatsEngine.ts

export interface StatsEngineConfig {
  symbol:    string;
  timeframe: string;        // '1m', '5m', '1h', etc.
  from:      number;        // timestamp ms
  to:        number;        // timestamp ms
}

class StatsEngine {
  constructor(private candleRepo: CandleRepository) {}

  async run(
    config: StatsEngineConfig,
    analyzers: Analyzer[],
  ): Promise<AnalyzerResult[]>
}
```

El motor:
1. Calcula `maxLookback = max(a.lookback for a in analyzers)`
2. Calcula `maxLookahead = max(a.lookahead for a in analyzers)`
3. Carga `[from - maxLookback*tf, to + maxLookahead*tf]` de velas
4. Itera desde `maxLookback` hasta `len - maxLookahead - 1`
5. Para cada posición construye `CandleWindow` y llama `analyzer.process(window)`
6. Retorna `analyzer.result()` para cada analyzer

**Una sola query a la BD.** Sin loops anidados en el motor.

---

## CLI

```typescript
// scripts/stats.ts

npm run stats -- \
  --symbol BTCUSDT \
  --timeframe 1m \
  --from 2025-01-01 \
  --to 2025-03-31 \
  --analyzer volume-followthrough --vol-threshold 500 --lookahead 5 \
  --analyzer consecutive-streaks --max-streak 10 \
  --output table          // table | json | csv
```

Flags comunes:
| Flag | Default | Descripción |
|------|---------|-------------|
| `--symbol` | `BTCUSDT` | Par |
| `--timeframe` | `1m` | Timeframe |
| `--from` | (requerido) | Fecha inicio |
| `--to` | (requerido) | Fecha fin |
| `--analyzer` | (requerido) | Nombre del analyzer. Repetible para usar varios |
| `--output` | `table` | Formato de salida: `table`, `json`, `csv` |

Cada `--analyzer` acepta sus propios parámetros que siguen inmediatamente en el CLI:
```bash
--analyzer volume-followthrough --vol-threshold 500 --lookahead 5
--analyzer volume-followthrough --vol-ma sma --vol-ma-period 20 --vol-ma-mult 2
```

---

## Analyzers de ejemplo

### 1. VolumeFollowthrough

**Pregunta:** Después de una vela con volumen destacado, ¿qué hace el precio en las siguientes N velas?

**Parámetros:**
- `--vol-threshold N` — volumen mínimo absoluto (BTC)
- `--vol-ma sma|ema` + `--vol-ma-period 20` + `--vol-ma-mult 2` — alternativa: volumen relativo
- `--lookahead 5` — cuántas velas futuras analizar

**Salida:**

```
VolumeFollowthrough — BTCUSDT 1m (2025-01-01 → 2025-03-31)
Condición: volumen >= SMA(20) × 2.0  |  Velas trigger: 847

Vela +N  | Cierra >High trigger | Cierra <Low trigger | Cierra dentro rango | Δ% promedio
---------|---------------------|---------------------|--------------------|-----------
  +1     |  23.4%              |  41.2%              |  35.4%             |  -0.08%
  +2     |  31.1%              |  38.7%              |  30.2%             |  -0.12%
  +3     |  35.6%              |  36.9%              |  27.5%             |  -0.15%
  +4     |  38.2%              |  35.8%              |  26.0%             |  -0.17%
  +5     |  40.1%              |  35.1%              |  24.8%             |  -0.19%
```

**Cómo funciona:**
- Para cada vela que cumple la condición de volumen, registra el `high` y `low` de esa vela
- Para cada vela `+N` del lookahead: compara el `close` contra ese high/low
- Acumula conteos y calcula % al final

---

### 2. ConsecutiveStreaks

**Pregunta:** ¿Con qué frecuencia ocurren rachas de N velas alcistas/bajistas consecutivas?

**Parámetros:**
- `--max-streak 10` — longitud máxima de racha a reportar
- `--direction both|bullish|bearish` — qué tipo de racha

**Criterio de vela alcista:** `close > open`. Bajista: `close < open`.

**Salida:**

```
ConsecutiveStreaks — BTCUSDT 1m (2025-01-01 → 2025-03-31)
Total velas: 131,400

Longitud | Alcistas (n) | % del total | Bajistas (n) | % del total
---------|--------------|-------------|--------------|------------
    1    |    18,432    |   14.03%    |    17,891    |   13.62%
    2    |     9,102    |    6.93%    |     8,876    |    6.76%
    3    |     4,498    |    3.43%    |     4,312    |    3.28%
    4    |     2,231    |    1.70%    |     2,108    |    1.61%
    5    |     1,089    |    0.83%    |     1,024    |    0.78%
    6    |       541    |    0.41%    |       498    |    0.38%
    7    |       263    |    0.20%    |       241    |    0.18%
    8    |       129    |    0.10%    |       118    |    0.09%
    9    |        61    |    0.05%    |        54    |    0.04%
   10+   |        58    |    0.04%    |        49    |    0.04%

Resumen:
  - Racha alcista promedio: 2.3 velas
  - Racha bajista promedio: 2.2 velas
  - Racha más larga alcista: 14 velas (2025-02-17 09:23)
  - Racha más larga bajista: 13 velas (2025-01-08 14:51)
```

**Cómo funciona:**
- `lookback = 0`, `lookahead = 0` — no necesita contexto externo
- Mantiene un contador de racha actual
- Cuando la racha se rompe, registra su longitud en un mapa `longitud → conteo`

---

### 3. MarubozuContinuation

**Pregunta:** Después de una vela sin mecha con rango significativo, ¿cuántas veces el precio llega al objetivo 1:1 sin romper el stop?

**Parámetros:**
- `--min-range-pct 0.5` — rango mínimo como % del precio (default 0.5)
- `--max-wick-pct 10` — mecha máxima como % del rango (default 10)
- `--lookahead 20` — velas para verificar TP/SL (default 20)
- `--direction both|bullish|bearish` — dirección a analizar (default both)

**Definición de trigger:**
- Alcista (`close > open`): mechas superior (`high - close`) e inferior (`open - low`) ambas < `maxWickPct`% del rango. Entry = close, SL = low, TP = close + (close - low).
- Bajista (`close < open`): mechas superior (`high - open`) e inferior (`close - low`) ambas < `maxWickPct`% del rango. Entry = close, SL = high, TP = close - (high - close).

**Salida:**

```
marubozu-continuation — BTCUSDT 1m (2025-01-01 → 2026-01-01)
  config: rango >= 0.5% | mecha <= 10% del rango | lookahead 20 velas
  triggers_alcistas: 1234
  triggers_bajistas: 1187

Seccion         | Count  | %
----------------|--------|-------
--- ALCISTA --- |        |
TP 1:1 hit      |    823 | 66.7%
SL hit          |    312 | 25.3%
Sin resolucion  |     99 |  8.0%
Metricas ALCISTA| velas_tp:4.2 velas_sl:2.1 rango_avg:0.73% |
--- BAJISTA --- |        |
...
```

**Cómo funciona:**
- `lookback = 0`, `lookahead = N` (configurable)
- Itera el lookahead vela a vela: si `low <= SL` (alcista) o `high >= SL` (bajista) → SL primero. Si `high >= TP` (alcista) o `low <= TP` (bajista) → TP primero. Si ninguno en el lookahead → sin resolución.

---

### 4. RangeByHour *(ejemplo de analyzer futuro)*

**Pregunta:** ¿En qué hora UTC las velas tienen mayor rango promedio?

```
RangeByHour — BTCUSDT 1m
Hora UTC | Velas | Rango % promedio | Vol promedio
---------|-------|-----------------|-------------
  00:00  |  3,900|     0.08%       |   42.3
  01:00  |  3,900|     0.07%       |   38.1
  ...
  09:00  |  3,900|     0.18%       |   98.4   ← apertura Londres
  14:00  |  3,900|     0.22%       |  142.6   ← apertura NY
  ...
```

---

## Ubicación en el proyecto

```
scripts/
├── stats.ts                           ← CLI principal
└── stats/
    ├── types.ts                       ← interfaces Analyzer, CandleWindow, etc.
    ├── StatsEngine.ts                 ← motor genérico
    ├── reporters/
    │   ├── TableReporter.ts           ← imprime tabla en terminal
    │   ├── JsonReporter.ts            ← vuelca JSON
    │   └── CsvReporter.ts            ← exporta CSV
    └── analyzers/
        ├── VolumeFollowthrough.ts
        ├── ConsecutiveStreaks.ts
        └── RangeByHour.ts            ← ejemplo futuro
```

Cada archivo de analyzer es independiente y no conoce al motor. Para agregar una estadística nueva: crear un archivo en `analyzers/`, implementar la interfaz `Analyzer`, y registrarlo en el CLI.

---

## Cómo agregar un nuevo analyzer

1. Crear `scripts/stats/analyzers/MiAnalyzer.ts`
2. Implementar la interfaz `Analyzer`:

```typescript
export class MiAnalyzer implements Analyzer {
  readonly name        = 'mi-analyzer';
  readonly description = 'Qué hace este analyzer';
  readonly lookback    = 20;   // necesito 20 velas previas
  readonly lookahead   = 3;    // necesito 3 velas futuras

  private _counts = new Map<string, number>();

  process(window: CandleWindow): void {
    // window.lookback  — velas previas
    // window.candle    — vela actual
    // window.lookahead — velas siguientes
    // acumular en this._counts
  }

  result(): AnalyzerResult {
    const rows = [...this._counts.entries()].map(([key, count]) => ({ key, count }));
    return { name: this.name, rows };
  }

  reset(): void {
    this._counts.clear();
  }
}
```

3. Registrarlo en `scripts/stats.ts`:

```typescript
case 'mi-analyzer':
  analyzers.push(new MiAnalyzer(parseAnalyzerArgs(args)));
  break;
```

---

## Notas de implementación

- **Una sola query a la BD** por ejecución, sin importar cuántos analyzers se activen.
- **Analyzers en paralelo** — el motor itera una vez y alimenta todos los analyzers en el mismo pass. O(N) donde N = número de velas.
- **Sin dependencias entre analyzers** — cada uno es independiente. Si se necesitara encadenamiento (output de uno como input de otro), se puede agregar un `PipelineAnalyzer` wrapper sin tocar el motor.
- **Múltiples rangos** — el CLI puede llamarse varias veces o, en el futuro, aceptar `--compare-period` para comparar dos rangos en una sola ejecución.
- **Timeframes agregados** — si se pide `--timeframe 5m` y los datos son de `candles_1m`, el `CandleLoader` agrega usando `aggregateCandles()` antes de entregar al motor. El motor no sabe de dónde vienen las velas.




● El módulo está implementado con 0 errores de TypeScript. Resumen de lo creado:

  Estructura:
  scripts/
  ├── stats.ts                          ← CLI principal
  └── stats/
      ├── types.ts                      ← interfaces Analyzer, CandleWindow, AnalyzerResult
      ├── StatsEngine.ts                ← motor genérico, un pass O(N)
      ├── reporters/
      │   ├── TableReporter.ts          ← tabla ASCII
      │   ├── JsonReporter.ts           ← JSON indentado
      │   └── CsvReporter.ts            ← CSV con separadores por analyzer
      └── analyzers/
          ├── VolumeFollowthrough.ts    ← volumen absoluto o relativo (SMA/EMA)
          └── ConsecutiveStreaks.ts     ← rachas alcistas/bajistas

  Uso:
  # Volumen con umbral absoluto
  npm run stats -- --symbol BTCUSDT --timeframe 1m --from 2025-01-01 --to 2025-03-31 \
    --analyzer volume-followthrough --vol-threshold 500 --lookahead 5

  # Volumen relativo (SMA × 2)
  npm run stats -- --symbol BTCUSDT --timeframe 1m --from 2025-01-01 --to 2025-03-31 \
    --analyzer volume-followthrough --vol-ma sma --vol-ma-period 20 --vol-ma-mult 2

  # Rachas consecutivas
  npm run stats -- --symbol BTCUSDT --timeframe 1m --from 2025-01-01 --to 2025-01-31 \
    --analyzer consecutive-streaks --max-streak 10

  # Múltiples analyzers + salida JSON
  npm run stats -- --symbol BTCUSDT --timeframe 1m --from 2025-01-01 --to 2025-01-31 \
    --analyzer volume-followthrough --vol-threshold 500 \
    --analyzer consecutive-streaks \
    --output json

  También se creó tsconfig.scripts.json para poder hacer npx tsc -p tsconfig.scripts.json --noEmit sobre src/ + scripts/ juntos.


Con los dos analyzers actuales puedes responder estas preguntas:                                                                                                                                                                                            
                                                                                                                                                                                                                                                            
  ---                                                                                                                                                                                                                                                         
  VolumeFollowthrough                                                                                                                                                                                                                                         
                                                                                                                                                                                                                                                              
  "Después de una vela con volumen anormalmente alto, ¿el precio sube o baja?"                                                                                                                                                                                
  npm run stats -- --symbol BTCUSDT --timeframe 1m --from 2025-01-01 --to 2025-03-31 \                                                                                                                                                                        
    --analyzer volume-followthrough --vol-ma sma --vol-ma-period 20 --vol-ma-mult 2 --lookahead 5                                                                                                                                                             
                                                                                                                                                                                                                                                              
  "¿Las velas con más de 500 BTC de volumen predicen dirección en los próximos 3 minutos?"                                                                                                                                                                    
  --analyzer volume-followthrough --vol-threshold 500 --lookahead 3                                                                                                                                                                                           
                                                                                                                                                                                                                                                              
  "¿Las velas de volumen extremo (×3 la media) tienen mayor follow-through que las de ×1.5?"                                                                                                                                                                  
  → Correr dos veces cambiando --vol-ma-mult y comparar las tablas.                                                                                                                                                                                           
                                                                                                                                                                                                                                                              
  ---                                                                                                                                                                                                                                                         
  ConsecutiveStreaks                                                                                                                                                                                                                                          
                                                                                                                                                                                                                                                              
  "¿Qué tan frecuentes son las rachas de 5+ velas verdes seguidas en 1m?"                                                                                                                                                                                     
  npm run stats -- --symbol BTCUSDT --timeframe 1m --from 2025-01-01 --to 2025-03-31 \                                                                                                                                                                        
    --analyzer consecutive-streaks --max-streak 10                                                                                                                                                                                                            
                                                                                                                                                                                                                                                              
  "¿Las rachas bajistas son más largas que las alcistas en BTC?"                                                                                                                                                                                              
  → La tabla muestra ambas columnas en paralelo.                                                                                                                                                                                                              
                                                                                                                                                                                                                                                              
  "En ETHUSDT, ¿hay más rachas bajistas que en BTCUSDT?"                                                                                                                                                                                                      
  → Repetir con --symbol ETHUSDT.                                                                                                                                                                                                                             
                                                                                                                                                                                                                                                              
  "¿Las rachas son más largas en velas de 5m que en 1m?" (efecto timeframe)                                                                                                                                                                                   
  → Correr con --timeframe 5m y comparar.
                                                                                                                                                                                                                                                              
  ---                                                       
  Comparaciones cross-período
                                                                                                                                                                                                                                                              
  "¿El comportamiento de volumen de enero 2025 se repite en febrero?"
  → Correr el mismo comando dos veces cambiando --from/--to.                                                                                                                                                                                                  
                                                                                                                                                                                                                                                              
  "¿Las rachas en mercado bajista (Q1 2025) son diferentes a mercado alcista (Q4 2024)?"                                                                                                                                                                      
  → Dos ejecuciones, comparar summary.                                                                                                                                                                                                                        
                                                                                                                                                                                                                                                              
  ---                                                       
  Lo que vendría con analyzers futuros                                                                                                                                                                                                                        
                                                            
  - RangeByHour — "¿A qué hora UTC tiene BTC el mayor rango? ¿Coincide con apertura de Londres/NY?"
  - ReversalAfterStreak — "Después de 4 velas rojas, ¿qué % de las siguientes 3 son verdes?"                                                                                                                                                                  
  - VolatilityByDay — "¿Los lunes son más volátiles que los viernes?"                                                                                                                                                                                         
                                                                       
                                                                       