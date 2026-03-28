# NesxTrader — Documentación de Implementación

## Índice

1. [Visión General](#1-visión-general)
2. [Arquitectura](#2-arquitectura)
3. [Módulo Shared](#3-módulo-shared)
4. [Módulo Data](#4-módulo-data)
5. [Módulo Strategy](#5-módulo-strategy)
6. [Módulo Execution](#6-módulo-execution)
7. [Módulo Position](#7-módulo-position)
8. [Módulo Backtest](#8-módulo-backtest)
9. [Módulo Notification](#9-módulo-notification)
10. [Catálogo de Eventos](#10-catálogo-de-eventos)
11. [Contratos de Datos](#11-contratos-de-datos)
12. [Flujos de Ejecución](#12-flujos-de-ejecución)

---

## 1. Visión General

NesxTrader es un bot de trading de criptomonedas construido en Node.js con PostgreSQL (TimescaleDB). Su propósito principal es **validar estrategias mediante backtesting** antes de operar con capital real.

El sistema opera en tres modos intercambiables sin cambiar código:

| Modo | Descripción |
|------|-------------|
| **Backtest** | Replay de velas históricas + FillSimulator |
| **Dry Run** | Streaming en vivo + DryRunAdapter (sin órdenes reales) |
| **Live** | Streaming en vivo + BinanceAdapter (órdenes reales) |

### Principios de diseño

- **TimeProvider siempre inyectado** — ningún módulo llama `Date.now()` directamente
- **Datos solo via repositorios** — la lógica de negocio no accede a SQL directamente
- **Toda estrategia implementa StrategyBase** — contrato formal sin excepciones
- **Eventos tipados** — toda comunicación entre módulos usa el MessageBroker
- **Los módulos no saben el modo** — Live, Dry Run y Backtest emiten los mismos eventos

---

## 2. Arquitectura

### Diagrama de módulos

```
┌─────────────────────────────────────────────────────────────────┐
│                         MessageBroker                           │
│              (bus de eventos central — EventEmitter)            │
└───┬──────────────┬─────────────────┬──────────────┬────────────┘
    │              │                 │              │
    ▼              ▼                 ▼              ▼
┌───────┐   ┌──────────┐    ┌──────────────┐  ┌──────────────┐
│ Data  │   │ Strategy │    │  Execution   │  │ Notification │
│       │   │  Engine  │    │   Engine     │  │   Engine     │
│ • DataProvider     │    │ • ExposureManager│  │ • Canales    │
│ • BinanceAdapter   │    │ • OrderManager   │  │ • Formatters │
│ • CandleRepository │    │ • BrokerAdapter  │  └──────────────┘
│ • ReplayProvider   │    └──────────────┘
└───────┘   └──────────┘
                                    │
                             ┌──────┴──────┐
                             │  Position   │
                             │  Manager    │
                             └─────────────┘

Modo Backtest:
  ReplayProvider → MARKET_CANDLE_CLOSED → StrategyEngine
                                        → BacktestRunner
                                          → FillSimulator
                                          → MetricsCalculator
```

### Convenciones de inyección de dependencias

Todos los módulos reciben dependencias por constructor:

```js
constructor({ messageBroker, timeProvider, someRepository, logger }) { ... }
```

- `messageBroker` — bus de eventos (siempre requerido en módulos con comunicación)
- `timeProvider` — proveedor de tiempo (siempre requerido)
- `logger` — logger opcional; todos los módulos tienen fallback a `console.*`

---

## 3. Módulo Shared

Utilidades transversales usadas por todos los módulos.

### MessageBroker

Bus de comunicación interna basado en EventEmitter. Desacopla emisores de consumidores.

**Interfaz pública:**

| Método | Firma | Descripción |
|--------|-------|-------------|
| `subscribe` | `(event: string, handler: Function) → void` | Registra un listener |
| `publish` | `(event: string, payload: Object) → Promise<void>` | Emite un evento a todos los listeners |
| `unsubscribe` | `(event: string, handler: Function) → void` | Elimina un listener |

### TimeProvider

Abstracción sobre `Date.now()` que permite controlar el tiempo en backtest.

**Interfaz pública:**

| Método | Descripción |
|--------|-------------|
| `now()` | Retorna el timestamp actual en ms |
| `setTime(ms)` | Avanza el reloj (solo en backtest) |

### Logger

```js
{
  info(...args),
  warn(...args),
  error(...args)
}
```

Todos los módulos aceptan un logger inyectado y tienen fallback a `console.*`.

---

## 4. Módulo Data

**Directorio:** `src/data/`

Responsable de obtener velas del mercado — tanto históricas (REST) como en tiempo real (WebSocket) — y exponerlas al resto del sistema via el evento `MARKET_CANDLE_CLOSED`.

### 4.1 DataProvider

Orquestador del módulo Data. Gestiona bootstrap REST seguido de streaming WebSocket.

**Dependencias:**
- `adapter` (BinanceAdapter)
- `repository` (CandleRepository)
- `messageBroker` (MessageBroker)
- `timeProvider` (TimeProvider)

**Métodos públicos:**

| Método | Descripción |
|--------|-------------|
| `async start(symbols, timeframes)` | Bootstrap REST de N velas históricas, luego inicia WebSocket |
| `async stop()` | Detiene el streaming |

**Flujo interno:**
1. Bootstrap: carga `bootstrapCandles` (default 500) velas históricas via REST para cada (symbol, timeframe)
2. Emite `MARKET_CANDLE_CLOSED` por cada vela del bootstrap
3. Conecta WebSocket y emite `MARKET_CANDLE_CLOSED` solo para velas con `isClosed=true`

**Eventos emitidos:** `MARKET_CANDLE_CLOSED`

---

### 4.2 BinanceAdapter

Acceso a datos de Binance via REST y WebSocket.

**Dependencias:**
- `messageBroker` — para emitir `SYSTEM_CRITICAL_ERROR` en fallos WS
- `timeProvider`

**Métodos públicos:**

| Método | Firma | Descripción |
|--------|-------|-------------|
| `fetchKlines` | `(symbol, timeframe, limit?) → Candle[]` | Descarga velas via REST |
| `fetchKlinesByRange` | `(symbol, timeframe, startTime, endTime, limit?) → Candle[]` | Descarga velas en rango |
| `connectWebSocket` | `(subscriptions, onCandle) → void` | Inicia streaming |
| `disconnectWebSocket` | `() → void` | Cierra conexión |

**Reconexión WebSocket:** backoff exponencial (base 1s, máx 60s, hasta 5 intentos). Emite `SYSTEM_CRITICAL_ERROR` si supera los reintentos.

---

### 4.3 CandleRepository

Lectura de velas desde TimescaleDB. Solo lectura — no escribe.

**Dependencias:** `db` (pg Pool)

**Métodos públicos:**

| Método | Firma | Descripción |
|--------|-------|-------------|
| `getCandles` | `(symbol, timeframe, from, to) → Candle[]` | Velas en rango [from, to] ms, ordenadas ASC |
| `getLastN` | `(symbol, timeframe, n) → Candle[]` | Últimas N velas, ordenadas ASC |
| `hasGranularData` | `(symbol, from, to) → {has1s, has1m}` | Verifica disponibilidad para FillSimulator |

**Tablas:**

| Tabla | Timeframe | Uso |
|-------|-----------|-----|
| `candles_1s` | 1 segundo | FillSimulator PRECISE_1S |
| `candles_1m` | 1 minuto | FillSimulator PRECISE_1M, bootstrap |
| `candles_1h` | 1 hora | Estrategias multi-timeframe |

---

### 4.4 ReplayProvider

Reproduce datos históricos cronológicamente para backtest. Reemplaza al DataProvider en modo Backtest.

**Dependencias:**
- `repository` (CandleRepository)
- `messageBroker`
- `timeProvider` — debe implementar `setTime(ms)` para avanzar el reloj

**Métodos públicos:**

| Método | Firma | Descripción |
|--------|-------|-------------|
| `replay` | `(symbol, timeframe, from, to) → number` | Emite todas las velas en orden cronológico; retorna total emitido |
| `replayMulti` | `(subscriptions, from, to) → number` | Intercala múltiples (symbol, timeframe) en orden cronológico global |

**Invariante:** `timeProvider.setTime()` se avanza antes de emitir cada evento, garantizando coherencia temporal en todo el sistema.

**Eventos emitidos:** `MARKET_CANDLE_CLOSED`

---

### 4.5 normalizers.js

Funciones puras de conversión entre formato Binance y formato interno.

| Función | Descripción |
|---------|-------------|
| `normalizeRestKline(rawKline, symbol, timeframe)` | Array de 12 campos REST → Candle |
| `normalizeWsKline(wsKline)` | Objeto k de WebSocket → Candle |
| `timeframeToBinanceInterval(timeframe)` | `'1m'` → `'1m'`, `'1h'` → `'1h'`, etc. |

---

## 5. Módulo Strategy

**Directorio:** `src/strategy/`

Responsable de analizar el mercado y generar señales de trading (`TradePlan`).

### 5.1 StrategyBase

Clase base abstracta. Toda estrategia debe extenderla.

**Contrato obligatorio:**

```js
class MiEstrategia extends StrategyBase {
  get id()                  // String — ID único (ej. 'mi-estrategia-v1')
  get requiredTimeframes()  // String[] — timeframes que necesita (ej. ['1m', '4h'])
  async evaluate(state)     // MarketState → TradePlan | null
}
```

---

### 5.2 StrategyRegistry

Registro central de todas las estrategias activas. Valida el contrato al registrar.

**Métodos públicos:**

| Método | Descripción |
|--------|-------------|
| `register(strategy)` | Registra una estrategia; lanza si no cumple StrategyBase o ID duplicado |
| `resolve(id)` | Retorna la estrategia por ID; lanza si no existe |
| `getAll()` | Retorna todas las estrategias registradas |
| `has(id)` | Verifica si una estrategia está registrada |
| `get size` | Cantidad de estrategias registradas |

---

### 5.3 StrategyEngine

Orquestador del módulo. En cada `MARKET_CANDLE_CLOSED`, actualiza el estado del mercado y evalúa todas las estrategias registradas.

**Dependencias:**
- `messageBroker`
- `strategyRegistry` (StrategyRegistry)
- `marketStateBuilder` (MarketStateBuilder)
- `timeProvider`

**Métodos públicos:**

| Método | Descripción |
|--------|-------------|
| `start()` | Suscribe a `MARKET_CANDLE_CLOSED`; idempotente |
| `stop()` | Detiene el engine |
| `async emitZoneArmed(payload)` | Emite `STRATEGY_ZONE_ARMED` (llamado por estrategias via callback) |
| `async emitZoneDisarmed(payload)` | Emite `STRATEGY_ZONE_DISARMED` |

**Flujo por vela:**
1. Recibe `MARKET_CANDLE_CLOSED`
2. Llama `marketStateBuilder.addCandle()`
3. Para cada estrategia registrada cuyo `requiredTimeframes` incluye el timeframe de la vela:
   - Construye `MarketState` con `marketStateBuilder.build()`
   - Llama `strategy.evaluate(state)`
   - Si retorna `TradePlan` → emite `STRATEGY_SIGNAL_GENERATED`

**Eventos emitidos:** `STRATEGY_SIGNAL_GENERATED`, `STRATEGY_ZONE_ARMED`, `STRATEGY_ZONE_DISARMED`
**Eventos consumidos:** `MARKET_CANDLE_CLOSED`

---

### 5.4 MarketStateBuilder

Mantiene buffers de velas por (symbol, timeframe) y construye el `MarketState` que reciben las estrategias.

**Dependencias:** `timeProvider`, `maxCandles` (default 500)

**Métodos públicos:**

| Método | Firma | Descripción |
|--------|-------|-------------|
| `addCandle` | `({symbol, timeframe, candle}) → void` | Agrega vela al buffer; descarta velas viejas si supera `maxCandles` |
| `build` | `(symbol, timeframes) → MarketState` | Construye el estado actual para la evaluación |
| `getCandleCount` | `(symbol, timeframe) → number` | Velas disponibles en buffer |
| `reset` | `() → void` | Limpia todos los buffers |

**Almacenamiento:** `Map<"symbol:timeframe", Candle[]>` — buffer circular de tamaño `maxCandles`.

---

### 5.5 FibonacciVolumeStrategy

Implementación concreta de estrategia. Detecta velas de alto volumen, calcula extensiones Fibonacci y genera señales cuando el precio toca un nivel.

**ID:** `fibonacci-volume-v1`
**Timeframes requeridos:** `['1m']`

**Lógica:**

```
1. Detectar vela con volumen > 5x SMA(20) de volumen → "vela impulso"
2. Calcular extensiones Fibonacci:
     Por encima del high: low + range × (1.8 | 2.1 | 2.618 | 3.0) → LONG
     Por debajo del low:  low + range × (-0.8 | -1.1 | -1.618 | -2.0) → SHORT
3. Armar zona (invocar onZoneArmed callback)
4. Si precio actual toca algún nivel (tolerancia ±0.1%):
     Construir TradePlan con SL=low/high de la vela impulso
     TPs: los 3 niveles siguientes en la misma dirección (30%/40%/30%)
5. Nueva vela impulso → desarmar zona anterior, armar nueva
```

**Constructor:**

```js
new FibonacciVolumeStrategy({
  onZoneArmed:    (payload) => { ... },  // opcional
  onZoneDisarmed: (payload) => { ... },  // opcional
})
```

Los callbacks son inyectados por `StrategyEngine` para emitir los eventos de zona al MessageBroker sin que la estrategia conozca el broker.

**Distribución de TPs:**

| Niveles disponibles | Distribución |
|--------------------|--------------|
| 3 o más | 30% / 40% / 30% (primeros 3) |
| 2 | 50% / 50% |
| 1 | 100% |
| 0 | Retorna `null` → TradePlan abortado |

**Estado interno:** `_armedZone` — la zona actualmente activa (o `null`). No tiene efectos secundarios externos más allá de los callbacks.

---

## 6. Módulo Execution

**Directorio:** `src/execution/`

Responsable de convertir un `TradePlan` en órdenes reales (Live) o simuladas (Dry Run), gestionar SL/TP y emitir eventos del ciclo de vida del trade.

### 6.1 BrokerAdapter (interfaz)

Define el contrato que todo adapter de broker debe cumplir.

```js
async placeOrder({ symbol, side, type, quantity, price?, stopPrice?, clientOrderId? })
  → { orderId, status, fillPrice? }

async cancelOrder(orderId, symbol)
  → { success }

async getOpenOrders(symbol?)
  → Order[]

async getBalance()
  → { available, total }
```

---

### 6.2 DryRunAdapter

Implementación simulada del broker para Dry Run. Simula fills sin enviar órdenes reales.

**Dependencias:** `slippagePercent` (default 0.05%), `initialBalance` (default 10000), `timeProvider`

**Métodos específicos (además de BrokerAdapter):**

| Método | Descripción |
|--------|-------------|
| `updateMarketPrice(symbol, price)` | Avanza el precio simulado; evalúa y llena órdenes pendientes (LIMIT, SL, TP) |
| `getAllOrders()` | Historial completo de órdenes |
| `reset(newBalance?)` | Reinicia estado |

**Lógica de fills:**
- `MARKET` → fill inmediato con slippage aplicado
- `LIMIT` → queda PENDING hasta que `updateMarketPrice` alcanza el nivel
- `STOP_LOSS` → se dispara si precio <= `stopPrice`
- `TAKE_PROFIT` → se dispara si precio >= `price` (LONG) o <= `price` (SHORT)

---

### 6.3 ExposureManager

Valida si un nuevo trade puede ejecutarse según los límites de riesgo configurados. Calcula el tamaño de posición.

**Dependencias:** `brokerAdapter`, `config`

**Configuración por defecto:**

| Límite | Valor |
|--------|-------|
| `maxRiskPerTradePercent` | 2% |
| `maxOpenTrades` | 5 |
| `maxRiskPerSymbolPercent` | 5% |
| `maxTotalRiskPercent` | 10% |

**Métodos públicos:**

| Método | Firma | Descripción |
|--------|-------|-------------|
| `canExecute` | `(tradePlan) → {allowed, reason?}` | Valida límites de riesgo |
| `calculateSize` | `(tradePlan) → {units, notional, riskAmount}` | Calcula tamaño de posición |
| `getCurrentExposure` | `() → {openRisk, openTrades}` | Estado actual de exposición |
| `registerOpenTrade` | `(tradeId, symbol, riskPercent, riskAmount) → void` | Registra trade abierto |
| `unregisterTrade` | `(tradeId) → void` | Libera exposición al cerrar |

**Cálculo de tamaño:**
```
riskAmount = balance × riskPercent / 100
riskPerUnit = |entryPrice - stopLoss|
units = riskAmount / riskPerUnit
notional = units × entryPrice
```

---

### 6.4 OrderManager

Gestiona el ciclo de vida de las órdenes de un trade (entrada + SL + TPs). Encapsula la lógica de colocación y cancelación.

**Dependencias:** `brokerAdapter`, `timeProvider`

**Métodos públicos:**

| Método | Descripción |
|--------|-------------|
| `async openPosition({tradeId, tradePlan, units, entryType?})` | Coloca orden de entrada; si MARKET, coloca SL y TPs inmediatamente |
| `async onEntryFilled(tradeId, fillPrice, tradePlan)` | Para entradas LIMIT: registra fill y coloca SL/TPs |
| `registerTPFill(tradeId, tpIndex, fillPrice, filledUnits)` | Registra fill parcial de TP |
| `async moveSL(tradeId, newSLPrice)` | Cancela SL anterior y coloca nuevo |
| `async closeGroup(tradeId, reason?)` | Cancela todas las órdenes activas del trade |
| `getGroup(tradeId)` | Retorna el TradeGroup del trade |
| `getActiveTradeIds()` | IDs de todos los trades activos |

**Estados de TradeGroup:**

```
WAITING_ENTRY → (entry filled) → OPEN → (SL or all TPs filled) → CLOSED
```

**`clientOrderId` convention:**
- Entrada: `{tradeId}-entry`
- Stop loss: `{tradeId}-sl`
- Take profit N: `{tradeId}-tp{n}`

---

### 6.5 ExecutionEngine

Orquestador del módulo. Recibe señales, valida, calcula tamaño y orquesta la apertura/cierre de trades.

**Dependencias:**
- `messageBroker`, `timeProvider`
- `brokerAdapter` (Live o DryRun)
- `exposureManager` (ExposureManager)
- `orderManager` (OrderManager)
- `tradeRepository` (opcional)

**Métodos públicos:**

| Método | Descripción |
|--------|-------------|
| `async start()` | Suscribe a eventos |
| `async stop()` | Detiene el engine |
| `async moveSL(tradeId, newSLPrice, reason?)` | Mueve SL de un trade abierto |
| `async closeTrade(tradeId, currentPrice)` | Cierra un trade manualmente |

**Flujo de señal:**
1. Recibe `STRATEGY_SIGNAL_GENERATED`
2. Valida el `TradePlan` (campos, dirección, TPs ordenados, SL correcto)
3. `exposureManager.canExecute()` — verifica límites
4. `exposureManager.calculateSize()` — calcula unidades
5. `orderManager.openPosition()` — coloca órdenes
6. Emite `EXECUTION_TRADE_OPENED`

**Validaciones de TradePlan:**
- Todos los campos requeridos presentes
- `direction ∈ {'LONG', 'SHORT'}`
- `takeProfits.length >= 1` y `sum(sizePercent) === 100`
- Para LONG: `stopLoss < entryPrice < takeProfits[0].price`
- Para SHORT: `stopLoss > entryPrice > takeProfits[0].price`

**Eventos emitidos:**

| Evento | Cuándo |
|--------|--------|
| `EXECUTION_TRADE_OPENED` | Orden de entrada colocada |
| `EXECUTION_TRADE_CLOSED` | SL o todos los TPs llenos |
| `EXECUTION_PARTIAL_FILLED` | Un TP parcial lleno |
| `EXECUTION_SL_MOVED` | SL ajustado |
| `EXECUTION_SIGNAL_REJECTED` | TradePlan inválido o límites de riesgo |
| `SYSTEM_CRITICAL_ERROR` | Error no recuperable del broker |

**Eventos consumidos:** `STRATEGY_SIGNAL_GENERATED`, `MARKET_CANDLE_CLOSED` (en DryRun para evaluar fills)

---

## 7. Módulo Position

**Directorio:** `src/position/`

Mantiene el estado de posiciones abiertas en memoria y las persiste en base de datos.

### 7.1 PositionRepository

Acceso a la tabla `trades` en PostgreSQL.

**Dependencias:** `db` (pg Pool)

**Métodos públicos:**

| Método | Firma | Descripción |
|--------|-------|-------------|
| `save` | `(position) → void` | INSERT nueva posición |
| `update` | `(tradeId, changes) → boolean` | UPDATE campos; retorna `true` si se modificó |
| `findOpen` | `() → Position[]` | Posiciones con status IN ('OPEN', 'PARTIAL') |
| `findById` | `(tradeId) → Position\|null` | Busca por ID |

**Campos actualizables en `update`:** `stopLoss`, `status`, `exitPrice`, `exitTime`, `exitType`, `pnl`

---

### 7.2 PositionManager

Fuente de verdad del estado de posiciones abiertas. Reconstruye desde BD al iniciar (tolerante a reinicios).

**Dependencias:**
- `messageBroker`, `timeProvider`
- `positionRepository` (PositionRepository)
- `brokerAdapter` (opcional, para sincronización)

**Métodos públicos:**

| Método | Descripción |
|--------|-------------|
| `async start()` | Carga posiciones abiertas de BD; suscribe a 4 eventos; idempotente |
| `async stop()` | Detiene y limpia mapa en memoria |
| `getOpenPositions()` | Retorna copias inmutables de todas las posiciones abiertas |
| `getPosition(tradeId)` | Retorna copia de una posición por ID (solo abiertas) |
| `async syncWithBroker()` | Compara estado local vs broker; emite `SYSTEM_SYNC_DISCREPANCY` por cada diferencia |

**Invariantes:**
- Los handlers actualizan memoria primero; persisten en BD en segundo plano
- Fallos de BD se logean pero nunca se propagan al emisor del evento
- `getOpenPositions()` y `getPosition()` retornan siempre copias (`{...position}`)

**Eventos consumidos:**

| Evento | Acción |
|--------|--------|
| `EXECUTION_TRADE_OPENED` | Agrega posición al mapa y la persiste |
| `EXECUTION_PARTIAL_FILLED` | Actualiza `remainingSize` |
| `EXECUTION_SL_MOVED` | Actualiza `stopLoss` |
| `EXECUTION_TRADE_CLOSED` | Elimina del mapa; actualiza status en BD |

**Eventos emitidos:** `SYSTEM_SYNC_DISCREPANCY`

---

## 8. Módulo Backtest

**Directorio:** `src/backtest/`

Simula el comportamiento completo del sistema sobre datos históricos para validar estrategias.

### 8.1 FillSimulator

Simula el resultado (fill) de un TradePlan sobre datos históricos con resolución adaptativa.

**Dependencias:**
- `candleRepository` (CandleRepository) — para `hasGranularData()`
- `timeProvider`

**Métodos públicos:**

| Método | Firma | Descripción |
|--------|-------|-------------|
| `simulateFill` | `(tradePlan, contextCandle) → FillResult` | Simula entrada y salida del trade |

**Modos de resolución:**

| Modo | Condición | Comportamiento |
|------|-----------|----------------|
| `PRECISE_1S` | `has1s = true` | Itera velas de 1s; fill exacto con slippage real |
| `PRECISE_1M` | `has1s = false, has1m = true` | Itera velas de 1m; fill aproximado |
| `PESSIMISTIC` | Sin datos granulares | Evalúa solo la `contextCandle`; en ambigüedad SL gana siempre |

**Resolución de ambigüedad** (precio toca SL y TP en la misma vela):
- En modos PRECISE: infiere por distancia `open → nivel`
- En modo PESSIMISTIC: SL siempre se toca primero

**Slippage estimado:** basado en la diferencia entre `open` de la primera vela y el `entryPrice` teórico.

---

### 8.2 MetricsCalculator

Calcula métricas de rendimiento a partir de una lista de `FillResult`. Completamente síncrono y puro.

**Métodos públicos:**

| Método | Firma | Descripción |
|--------|-------|-------------|
| `calculate` | `(fills, initialCapital) → Metrics` | Calcula todas las métricas |

**Métricas calculadas:**

| Campo | Descripción |
|-------|-------------|
| `finalCapital` | Capital final tras todos los trades |
| `totalTrades` | Número de trades |
| `winRate` | % de trades con `pnl > 0` |
| `profitFactor` | Suma de ganancias / Suma de pérdidas |
| `maxDrawdown` | Caída máxima desde pico (sobre equity curve) |
| `sharpeRatio` | Retorno ajustado por riesgo total |
| `sortinoRatio` | Retorno ajustado por riesgo downside |
| `expectancy` | PnL promedio por trade |
| `tpBreakdown` | `{tp1, tp2, tp3}` — hits y winRate por nivel de TP |
| `resolution_confidence` | `{PRECISE_1S, PRECISE_1M, PESSIMISTIC}` — % de trades por modo |
| `pessimistic_penalties` | Trades con `had_ambiguity=true` (resultado incierto) |

---

### 8.3 BacktestRepository

Persiste corridas de backtest completas en PostgreSQL.

**Dependencias:** `db` (pg Pool)

**Métodos públicos:**

| Método | Firma | Descripción |
|--------|-------|-------------|
| `saveRun` | `(report) → string` | Inserta run + trades en transacción; retorna UUID |
| `getRunById` | `(runId) → BacktestReport\|null` | Carga corrida completa con trades |
| `listRunsByStrategy` | `(strategyId, limit?) → Array` | Lista resúmenes (sin trades individuales) |
| `deleteRun` | `(runId) → boolean` | Elimina corrida; retorna `true` si existía |

---

### 8.4 BacktestRunner

Orquestador del backtest. Conecta todos los módulos y ejecuta la simulación de principio a fin.

**Dependencias:**
- `replayProvider` (ReplayProvider)
- `strategyEngine` (StrategyEngine)
- `fillSimulator` (FillSimulator)
- `metricsCalculator` (MetricsCalculator)
- `backtestRepository` (BacktestRepository)
- `messageBroker`

**Métodos públicos:**

| Método | Firma | Descripción |
|--------|-------|-------------|
| `run` | `(config) → BacktestReport` | Ejecuta la simulación completa |

**Configuración de `run()`:**

```js
{
  strategyId: string,      // ID de la estrategia
  symbol: string,          // Par (ej. 'BTCUSDT')
  timeframe: string,       // Timeframe principal (ej. '1m')
  from: number,            // Timestamp inicio en ms
  to: number,              // Timestamp fin en ms
  initialCapital: number,  // Capital inicial
  riskPercent?: number,    // % a arriesgar por trade (default 1)
}
```

**Flujo:**
```
1. Validar config
2. Suscribir a STRATEGY_SIGNAL_GENERATED
3. strategyEngine.start()
4. replayProvider.replay() → emite MARKET_CANDLE_CLOSED por cada vela
   ↓ StrategyEngine evalúa → emite STRATEGY_SIGNAL_GENERATED
   ↓ BacktestRunner recibe señal → fillSimulator.simulateFill()
   ↓ Emite EXECUTION_TRADE_OPENED + EXECUTION_TRADE_CLOSED
   ↓ Acumula FillResult
5. strategyEngine.stop() + cleanup de suscripciones
6. metricsCalculator.calculate(fillResults, initialCapital)
7. backtestRepository.saveRun(report) — no crítico si falla
8. Retorna BacktestReport
```

**Eventos emitidos:** `EXECUTION_TRADE_OPENED`, `EXECUTION_TRADE_CLOSED`, `EXECUTION_PARTIAL_FILLED`
**Eventos consumidos:** `STRATEGY_SIGNAL_GENERATED`, `MARKET_CANDLE_CLOSED`

---

## 9. Módulo Notification

**Directorio:** `src/notification/`

Envía notificaciones externas cuando ocurren eventos relevantes. Solo opera en modo Live y Dry Run — nunca en Backtest.

### 9.1 NotificationEngine

Orquestador del módulo. Suscribe eventos, aplica throttling, formatea mensajes y los enruta a los canales registrados.

**Dependencias:**
- `messageBroker`
- `timeProvider`
- `throttle` (object opcional) — mapa `eventName → ms` mínimos entre notificaciones

**Métodos públicos:**

| Método | Descripción |
|--------|-------------|
| `start()` | Suscribe a todos los eventos del catálogo; idempotente |
| `stop()` | Detiene; limpia contadores de throttle |
| `addChannel(channel)` | Registra canal de salida; puede llamarse antes o después de `start()` |

**Throttling:**
- Default: 60 segundos entre mensajes del mismo tipo
- Configurable por evento: `{ SYSTEM_CRITICAL_ERROR: 0, EXECUTION_TRADE_OPENED: 5000 }`
- `0` desactiva el throttle para ese evento
- El timestamp se registra **antes** del envío — si todos los canales fallan, el evento sigue considerándose "enviado" (evita burst ante canal roto)

**Aislamiento de fallos:** si un canal lanza excepción, el error se loggea pero los demás canales siguen recibiendo el mensaje. No emite `SYSTEM_CRITICAL_ERROR`.

**Eventos consumidos:**

| Evento | Nivel |
|--------|-------|
| `STRATEGY_SIGNAL_GENERATED` | info |
| `STRATEGY_ZONE_ARMED` | info |
| `STRATEGY_ZONE_DISARMED` | info |
| `EXECUTION_TRADE_OPENED` | info |
| `EXECUTION_TRADE_CLOSED` | info |
| `EXECUTION_SL_MOVED` | info |
| `EXECUTION_SIGNAL_REJECTED` | warn |
| `SYSTEM_CRITICAL_ERROR` | error |
| `SYSTEM_SYNC_DISCREPANCY` | warn |

---

### 9.2 Canales de salida

Todos los canales implementan `async send({ text: string, level: string }) → void`.

#### ConsoleChannel

Imprime en consola con prefijo `[NOTIFICATION] [LEVEL] [timestamp ISO]`.

```js
new ConsoleChannel({ timeProvider? })
```

#### TelegramChannel

Envía mensajes via Telegram Bot API con retry automático.

```js
new TelegramChannel({ botToken: string, chatId: string })
```

- Retry con backoff lineal para errores de red y 5xx
- Sin retry para errores 4xx (token inválido, chat no encontrado)
- Timeout de 10 segundos por petición (`AbortSignal.timeout`)

---

### 9.3 Formatters

Funciones puras que convierten payloads de eventos en strings listos para enviar.

**TradeFormatter:**

| Función | Evento |
|---------|--------|
| `formatTradeOpened(payload)` | `EXECUTION_TRADE_OPENED` |
| `formatTradeClosed(payload)` | `EXECUTION_TRADE_CLOSED` |
| `formatSLMoved(payload)` | `EXECUTION_SL_MOVED` |
| `formatSignalGenerated(payload)` | `STRATEGY_SIGNAL_GENERATED` |
| `formatSignalRejected(payload)` | `EXECUTION_SIGNAL_REJECTED` |
| `formatZoneArmed(payload)` | `STRATEGY_ZONE_ARMED` |
| `formatZoneDisarmed(payload)` | `STRATEGY_ZONE_DISARMED` |

**ErrorFormatter:**

| Función | Evento |
|---------|--------|
| `formatCriticalError(payload)` | `SYSTEM_CRITICAL_ERROR` |
| `formatSyncDiscrepancy(payload)` | `SYSTEM_SYNC_DISCREPANCY` |

---

## 10. Catálogo de Eventos

Todos los eventos se comunican via `MessageBroker`. Los nombres son constantes string.

| Evento | Emisor(es) | Consumidor(es) |
|--------|-----------|----------------|
| `MARKET_CANDLE_CLOSED` | DataProvider, ReplayProvider | StrategyEngine, ExecutionEngine (DryRun), BacktestRunner |
| `STRATEGY_SIGNAL_GENERATED` | StrategyEngine | ExecutionEngine, BacktestRunner, NotificationEngine |
| `STRATEGY_ZONE_ARMED` | StrategyEngine | NotificationEngine |
| `STRATEGY_ZONE_DISARMED` | StrategyEngine | NotificationEngine |
| `EXECUTION_TRADE_OPENED` | ExecutionEngine, BacktestRunner | PositionManager, NotificationEngine |
| `EXECUTION_TRADE_CLOSED` | ExecutionEngine, BacktestRunner | PositionManager, NotificationEngine |
| `EXECUTION_PARTIAL_FILLED` | ExecutionEngine, BacktestRunner | PositionManager, NotificationEngine |
| `EXECUTION_SL_MOVED` | ExecutionEngine | PositionManager, NotificationEngine |
| `EXECUTION_SIGNAL_REJECTED` | ExecutionEngine | NotificationEngine |
| `SYSTEM_CRITICAL_ERROR` | ExecutionEngine, BinanceAdapter | NotificationEngine |
| `SYSTEM_SYNC_DISCREPANCY` | PositionManager | NotificationEngine |

---

## 11. Contratos de Datos

### Candle

```js
{
  symbol:    string,   // 'BTCUSDT'
  timeframe: string,   // '1m', '1h', ...
  openTime:  number,   // timestamp ms
  open:      number,
  high:      number,
  low:       number,
  close:     number,
  volume:    number,
  isClosed:  boolean,
}
```

### MarketState (entrada a `evaluate`)

```js
{
  symbol:       string,
  timestamp:    number,           // via TimeProvider
  candles:      { [tf]: Candle[] }, // { '1m': [...], '4h': [...] }
  currentPrice: number,           // close de la vela más reciente
}
```

### TradePlan (salida de `evaluate`)

```js
{
  strategyId:  string,
  symbol:      string,
  direction:   'LONG' | 'SHORT',
  entryPrice:  number,
  stopLoss:    number,
  takeProfits: [{ price: number, sizePercent: number }],  // suma = 100
  riskPercent: number,
  metadata:    object,
}
```

### FillResult (salida de FillSimulator)

```js
{
  tradeId:    string,
  entryFill:  { price: number, timestamp: number, slippage: number },
  exitFill:   { price: number, timestamp: number, type: 'TP'|'SL'|'MANUAL', tpLevel?: number },
  pnl:        number,
  pnlPercent: number,
  resolution_mode: 'PRECISE_1S' | 'PRECISE_1M' | 'PESSIMISTIC',
  had_ambiguity:   boolean,
}
```

### BacktestReport (salida de BacktestRunner)

```js
{
  id:      string,        // UUID asignado al persistir
  config:  { strategyId, symbol, timeframe, from, to, initialCapital, riskPercent },
  metrics: Metrics,
  trades:  FillResult[],
}
```

### Position

```js
{
  tradeId:    string,
  strategyId: string,
  symbol:     string,
  direction:  'LONG' | 'SHORT',
  entryPrice: number,
  entryTime:  number,
  stopLoss:   number,
  takeProfits: [{ price, sizePercent }],
  size:       number,
  status:     'OPEN' | 'PARTIAL' | 'CLOSED',
  exitPrice?: number,
  exitTime?:  number,
  exitType?:  'TP' | 'SL' | 'MANUAL',
  pnl?:       number,
}
```

---

## 12. Flujos de Ejecución

### Flujo Backtest completo

```
new BacktestRunner({ replayProvider, strategyEngine, fillSimulator,
                     metricsCalculator, backtestRepository, messageBroker })

runner.run({ strategyId: 'fibonacci-volume-v1', symbol: 'BTCUSDT',
             timeframe: '1m', from, to, initialCapital: 10000 })

  → _subscribeToSignals()           // escucha STRATEGY_SIGNAL_GENERATED
  → strategyEngine.start()          // escucha MARKET_CANDLE_CLOSED
  → replayProvider.replay()
      → por cada vela histórica:
          timeProvider.setTime(vela.openTime)
          broker.publish('MARKET_CANDLE_CLOSED', { candle })

              → StrategyEngine._handleCandleClosed()
                  → marketStateBuilder.addCandle()
                  → strategy.evaluate(state)
                      → si TradePlan → broker.publish('STRATEGY_SIGNAL_GENERATED')

              → BacktestRunner handler
                  → fillSimulator.simulateFill(tradePlan, contextCandle)
                      → hasGranularData? → PRECISE_1S / PRECISE_1M / PESSIMISTIC
                      → retorna FillResult
                  → broker.publish('EXECUTION_TRADE_OPENED', ...)
                  → broker.publish('EXECUTION_TRADE_CLOSED', ...)
                  → fillResults.push(fillResult)

  → strategyEngine.stop()
  → metricsCalculator.calculate(fillResults, initialCapital)
  → backtestRepository.saveRun(report)
  → return BacktestReport
```

### Flujo Live / Dry Run

```
DataProvider.start(['BTCUSDT'], ['1m'])
  → fetchKlines() × (symbol × timeframe)    // bootstrap REST
  → broker.publish('MARKET_CANDLE_CLOSED')  // por cada vela histórica

  → connectWebSocket()                       // streaming
  → por cada vela cerrada (isClosed=true):
      broker.publish('MARKET_CANDLE_CLOSED', { candle })

          → StrategyEngine evalúa → TradePlan
              → broker.publish('STRATEGY_SIGNAL_GENERATED')

          → ExecutionEngine recibe señal
              → exposureManager.canExecute() → allowed
              → exposureManager.calculateSize() → { units }
              → orderManager.openPosition() → TradeGroup
              → broker.publish('EXECUTION_TRADE_OPENED')

          → PositionManager registra posición
          → NotificationEngine envía notificación

  → cuando SL/TP se llena:
      → ExecutionEngine recibe fill
      → broker.publish('EXECUTION_TRADE_CLOSED')
      → PositionManager actualiza estado
      → NotificationEngine notifica
```

### Cómo agregar una nueva estrategia

```
1. Crear src/strategy/strategies/MiEstrategia.js
   class MiEstrategia extends StrategyBase {
     get id()                 { return 'mi-estrategia-v1'; }
     get requiredTimeframes() { return ['1m', '4h']; }
     async evaluate(state)    { /* lógica */ }
   }

2. Registrar en StrategyRegistry (o en el bootstrap de la aplicación):
   registry.register(new MiEstrategia())

3. Correr backtest:
   runner.run({ strategyId: 'mi-estrategia-v1', symbol: 'BTCUSDT', ... })

4. Analizar BacktestReport.metrics

5. Si métricas superan umbrales → Dry Run
6. Si Dry Run es consistente → Live
```

No se modifica ningún módulo existente en ningún paso.
