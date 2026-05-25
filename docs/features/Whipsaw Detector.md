# Whipsaw Detector — Resumen para implementación en backtester

## ¿Qué es un whipsaw?

Un whipsaw es un movimiento violento de precio donde:
1. El precio se desplaza mucho en poco tiempo (alta volatilidad)
2. Pero **termina cerca de donde empezó** (sin desplazamiento neto)

Son típicamente causados por cascadas de liquidaciones en futuros. Se diferencian de un breakout tendencial en que el breakout sí produce desplazamiento neto.

---

## Algoritmo actual (versión final)

El detector usa **dos filtros secuenciales** y opera como una **máquina de estados**.

### Filtro 1 — Volatilidad alta (activa el tracking)

```
rango = high - low
smaRango = SMA(rangos_recientes, smaPeriod)
esVolatil = rango > volatilityMultiplier × smaRango
```

- Se mantiene un buffer circular de los últimos `smaPeriod` rangos.
- Si la vela actual tiene un rango que supera el umbral → se activa la fase `spike_active`.
- Si el SMA no está listo todavía (menos de `smaPeriod` velas acumuladas) → se ignora.

### Filtro 2 — Displacement ratio (clasifica whipsaw vs breakout)

```
ratio = |close_actual - open_del_spike| / (spikeHigh - spikeLow)
esWhipsaw = ratio < displacementThreshold
```

- `open_del_spike`: el precio de apertura de la **primera vela volátil** que activó el tracking.
- `spikeHigh` / `spikeLow`: los extremos acumulados desde que empezó el spike.
- Si el ratio es bajo → el precio volvió cerca del punto de partida → **whipsaw**.
- Si el ratio es alto → el precio se fue lejos → **breakout**, se descarta silenciosamente.

---

## Máquina de estados

```
monitoring → spike_active → evaluating → monitoring
                  ↓               ↓
            (whipsaw en       (whipsaw en
             minBars)       zona extendida)
                  ↓               ↓
              EVENTO           EVENTO
```

### Fase `monitoring`
Estado normal. Se evalúa cada vela para ver si es volátil. Si lo es, transiciona a `spike_active`.

### Fase `spike_active`
Se acumulan velas hasta llegar a `minBars`:
- Se actualizan los extremos (`spikeHigh`, `spikeLow`, `peakRange`) en cada vela.
- Al llegar a `minBars` se evalúa el displacement ratio.
  - Si `ratio < displacementThreshold` → **whipsaw confirmado**, emite evento, vuelve a `monitoring`.
  - Si no → transiciona a `evaluating`, guardando la vela actual como inicio del buffer de extensión.

### Fase `evaluating`
Se evalúa el displacement ratio en **cada nueva vela** hasta llegar a `maxBars`:
- Si `ratio < displacementThreshold` en cualquier vela → **whipsaw confirmado**, emite evento, vuelve a `monitoring`.
- Si llega a `maxBars` sin confirmar → se descarta como tendencial y se hace **replay** del buffer.

### Replay (al descartar en maxBars)
Cuando se llega a `maxBars` sin confirmar whipsaw:
1. Se guarda el `extensionBuffer` (todas las velas de la zona extendida).
2. Se resetea el state a `monitoring`.
3. Se re-procesan recursivamente las velas del buffer.
4. Si alguna vela del buffer activa un nuevo spike, se detecta normalmente.
5. Los eventos del replay se acumulan junto con los del ciclo principal.

> **Por qué replay**: las velas de la zona extendida pueden contener el inicio de un nuevo spike. Si solo reseteamos, esas velas se pierden.

---

## Parámetros de configuración

| Parámetro | Tipo | Default | Descripción |
|-----------|------|---------|-------------|
| `volatilityMultiplier` | `number` | `3` | Multiplicador sobre el SMA del rango. Cuanto más alto, más exigente. |
| `smaPeriod` | `number` | `50` | Ventana del SMA de rangos (buffer circular). |
| `displacementThreshold` | `number` | `0.3` | Ratio máximo para clasificar como whipsaw. Más bajo = más estricto. |
| `minBars` | `number` | `5` | Barras mínimas antes de evaluar el displacement. Debe ser entero ≥ 1. |
| `maxBars` | `number` | `20` | Barras máximas. Si llega aquí sin confirmar, se descarta. Debe ser > minBars. |

### Valores por timeframe (defaults del archivo)

| TF | enabled | minBars | maxBars |
|----|---------|---------|---------|
| 1m  | true  | 5 | 20 |
| 5m  | true  | 4 | 15 |
| 10m | false | 4 | 12 |
| 15m | true  | 3 | 10 |
| 30m | false | 3 | 8  |
| 1h  | false | 3 | 8  |

> `volatilityMultiplier`, `smaPeriod`, `displacementThreshold` usan el default global para todos los TFs.

---

## Estructuras de datos

### Config (`SpikeDetectorConfig`)

```js
{
  volatilityMultiplier: 3,    // number
  smaPeriod: 50,              // number
  displacementThreshold: 0.3, // number (0-1)
  minBars: 5,                 // integer >= 1
  maxBars: 20,                // integer > minBars
}
```

### State (`SpikeDetectorState`)

```js
{
  phase: 'monitoring' | 'spike_active' | 'evaluating',
  spikeHigh: null | number,         // extremo alto acumulado
  spikeLow: null | number,          // extremo bajo acumulado
  peakRange: null | number,         // rango máximo observado en el spike
  spikeStartTime: null | number,    // timestamp de la vela que activó el spike
  spikeOpenPrice: null | number,    // precio open de la vela que activó el spike
  spikeBars: 0,                     // cantidad de barras acumuladas en el spike
  recentRanges: [],                 // buffer circular de rangos (max smaPeriod)
  extensionBuffer: [],              // velas de la zona extendida (para replay)
  lastProcessedTime: null | number, // timestamp de la última vela procesada
}
```

### Evento emitido (`SpikeEvent`)

```js
{
  type: 'spike_range_detected',
  data: {
    spikeHigh: number,
    spikeLow: number,
    peakRange: number,
    spikeStartTime: number,       // timestamp de inicio del spike
    confirmationTime: number,     // timestamp de la vela que confirmó
    spikeBars: number,            // cantidad de barras que duró el spike
    spikeOpenPrice: number,
    spikeClosePrice: number,
    displacementRatio: number,    // el ratio calculado (útil para diagnóstico)
  }
}
```

---

## API de la función pura

### `processCandle(candle, state, config, [onDecision])`

Función pura sin side effects. Procesa una vela y retorna el nuevo estado y los eventos generados.

**Parámetros:**
- `candle`: objeto con `{ open, high, low, close, open_time }` (valores como string o number)
- `state`: estado actual del detector (usar `createInitialState()` para el primero)
- `config`: configuración de umbrales
- `onDecision` *(opcional)*: callback de debug llamado en cada punto de decisión

**Retorna:**
```js
{
  state: SpikeDetectorState,  // nuevo estado (inmutable respecto al input)
  events: SpikeEvent[],       // array vacío o con 1+ eventos (por el replay)
}
```

> **Importante**: retorna `events` como **array**, no un único evento. El replay puede generar múltiples eventos por vela.

### `createInitialState()`

Retorna un estado inicial limpio para empezar un nuevo símbolo.

### `createDefaultConfig(overrides = {})`

Retorna la config con defaults, opcionalmente sobreescribiendo valores.

---

## Implementación en backtester

### Flujo básico

```js
import { processCandle, createInitialState, createDefaultConfig } from './spikeDetector.js';

const config = createDefaultConfig({ minBars: 3, maxBars: 10 });
let state = createInitialState();
const allEvents = [];

// Primeras smaPeriod velas → calentamiento del buffer SMA
// El estado cambia pero los eventos se descartan
const warmupCandles = candles.slice(0, config.smaPeriod);
for (const candle of warmupCandles) {
  ({ state } = processCandle(candle, state, config));
}

// Velas posteriores → detección real
const detectionCandles = candles.slice(config.smaPeriod);
for (const candle of detectionCandles) {
  const result = processCandle(candle, state, config);
  state = result.state;
  allEvents.push(...result.events);
}

// allEvents contiene todos los whipsaws detectados
console.log(`Spikes detectados: ${allEvents.length}`);
```

### Calentamiento (warmup)

El SMA necesita `smaPeriod` velas para estar listo. Antes de eso, `smaRange` es `null` y el filtro de volatilidad nunca activa.

**En backtester**: pasar las primeras `smaPeriod` velas como warmup (sin registrar eventos). Las velas de detección empiezan desde la posición `smaPeriod`.

**En tiempo real**: la primera vez que corre para un símbolo, obtener las últimas `smaPeriod + 10` velas históricas y pasar las primeras `smaPeriod` como warmup.

### Resultado por evento

Cada evento tiene toda la información necesaria:
- Rango del spike (`spikeHigh`, `spikeLow`, `peakRange`)
- Duración en barras (`spikeBars`)
- Timestamps de inicio y confirmación
- Precios de apertura y cierre del spike
- El ratio calculado (`displacementRatio`) — útil para calibrar el threshold

---

## Casos de borde importantes

### El replay puede generar múltiples eventos
Si se descarta en `maxBars` y el buffer contiene velas volátiles, pueden generarse eventos adicionales. Siempre iterar `result.events` con spread o `forEach`, nunca asumir que hay uno solo.

### Velas que expanden el rango no reinician el spike
Durante `spike_active` y `evaluating`, si una vela rompe `spikeHigh` o `spikeLow`, los extremos se actualizan pero el spike **no se reinicia**. El tracking sigue acumulando.

### El `displacementRatio` usa siempre el open del spike original
No el close de la vela anterior ni el open actual. Es el precio de apertura de la **primera vela volátil** que activó el tracking (`spikeOpenPrice`). Esto mide cuánto se desplazó el precio desde el inicio del spike.

### Rango cero
Si `spikeHigh === spikeLow` (imposible en la práctica pero defensivo), el ratio retorna `1` (no whipsaw).

---

## Calibración de parámetros

### `volatilityMultiplier`
- `2.0`: muy sensible, detecta movimientos moderados
- `3.0` (default): captura movimientos claramente anómalos
- `4.0+`: solo eventos extremos

### `smaPeriod`
- `20`: contexto de ~20 minutos en 1m, más reactivo
- `50` (default): ~50 minutos en 1m, balance estabilidad/reactividad
- Aumentar para TFs mayores si el "rango normal" varía mucho

### `displacementThreshold`
- `0.15`: muy estricto, solo whipsaws casi perfectos (precio vuelve exactamente al open)
- `0.3` (default): tolera hasta 30% de desplazamiento neto respecto al rango
- `0.5`: clasifica como whipsaw movimientos con desplazamiento moderado

### `minBars` / `maxBars`
- `minBars` pequeño: confirma rápido, puede confundir con volatilidad normal que rebota
- `maxBars` grande: da más tiempo al precio para regresar, aumenta detecciones pero baja precisión
- La diferencia `maxBars - minBars` define la "zona extendida" de evaluación

---

## Archivos en el proyecto

| Archivo | Rol |
|---------|-----|
| `backend/lib/indicators/spikeDetector.js` | Núcleo puro — la función `processCandle` |
| `backend/config/whipsawProfiles.js` | Defaults y merge de config por TF |
| `backend/db/whipsawProfileRepo.js` | Acceso a BD para overrides por TF |
| `backend/services/crypto/whipsawProfileService.js` | Lógica de negocio de perfiles + `scanSymbol` |
| `backend/services/crypto/spikeDetectorService.js` | Orquestador tiempo real (Redis + appEvents) |
| `backend/services/crypto/spikeBacktestRunner.js` | Orquestador backtest (todo en memoria) |
| `backend/controllers/whipsawProfileController.js` | API REST para configurar perfiles |
| `backend/jobs/detectSpikesJob.js` | Job PM2 que corre cada 2 min |
| `backend/cli/backtestSpikes.js` | CLI para backtest manual |
| `backend/tests/spikeDetector.test.js` | Tests unitarios del núcleo puro |

---

## Evolución del algoritmo (para entender decisiones)

El algoritmo pasó por tres iteraciones:

1. **v1** — Tres filtros: volatilidad + alternancia direccional (ratio neto/total sobre ventana de N velas) + contracción sostenida (confirmationBars velas con rango bajo).

2. **v2** — Se eliminó la alternancia. El filtro 2 pasó a ser el displacement ratio evaluado al final (solo en `confirmationBars`). Más simple y más robusto.

3. **v3 (actual)** — Se eliminó `confirmationBars` y la fase `confirming`. Se reemplazó por una ventana dinámica `minBars`/`maxBars` donde el displacement se evalúa en cada vela. Se agregó replay para no perder spikes nuevos al descartar. La firma de `processCandle` cambió de `{ state, event }` a `{ state, events }` (array) para soportar el replay.