# NesxTrader — Patrones de Diseño Implementados

Este documento explica qué patrones de software se usan en NesxTrader, para qué sirve cada uno y cómo resuelve un problema concreto de la aplicación. Está pensado como material de repaso de buenas prácticas con casos de uso reales.

---

## Índice

1. [Observer / Event-Driven Architecture](#1-observer--event-driven-architecture)
2. [Strategy](#2-strategy)
3. [Adapter](#3-adapter)
4. [Repository](#4-repository)
5. [Dependency Injection](#5-dependency-injection)
6. [Registry](#6-registry)
7. [Template Method](#7-template-method)
8. [Builder](#8-builder)
9. [Facade](#9-facade)
10. [Command / Value Object](#10-command--value-object)
11. [Null Object](#11-null-object)
12. [Chain of Responsibility](#12-chain-of-responsibility)
13. [Proxy (abstracción de tiempo)](#13-proxy-abstracción-de-tiempo)
14. [Retry con Backoff Exponencial](#14-retry-con-backoff-exponencial)
15. [Throttle](#15-throttle)
16. [Resumen y mapa de relaciones](#16-resumen-y-mapa-de-relaciones)

---

## 1. Observer / Event-Driven Architecture

### Qué es

El patrón **Observer** define una relación de uno a muchos: cuando un objeto cambia de estado, todos sus dependientes son notificados automáticamente. La variante **Event-Driven** desacopla además al emisor del receptor — el emisor no sabe quién escucha.

### El problema que resuelve en general

Sin este patrón, los módulos se llaman entre sí directamente:

```js
// Sin Observer: acoplamiento fuerte
strategyEngine.evaluate(candle);         // Strategy sabe de Execution
executionEngine.process(tradePlan);      // Execution sabe de Position
positionManager.update(trade);          // Position sabe de Notification
notificationEngine.send(message);       // ¡Cadena rígida!
```

Si queremos agregar un nuevo consumidor (ej. un módulo de analytics), hay que modificar el emisor.

### Cómo lo resuelve en NesxTrader

El **MessageBroker** es el bus central de eventos. Ningún módulo conoce a los demás — solo conocen los nombres de los eventos.

```
// DataProvider emite — no sabe quién escucha
broker.publish('MARKET_CANDLE_CLOSED', { candle })

// Cada módulo se suscribe independientemente
StrategyEngine:   broker.subscribe('MARKET_CANDLE_CLOSED', handler)
ExecutionEngine:  broker.subscribe('MARKET_CANDLE_CLOSED', handler)  // DryRun
BacktestRunner:   broker.subscribe('MARKET_CANDLE_CLOSED', handler)
```

**Consecuencia real:** agregar el `NotificationEngine` al sistema no requirió modificar ningún módulo existente. Solo se instancia y llama a `start()` — se suscribe solo a los eventos que le interesan.

**Otro ejemplo concreto:** el mismo evento `EXECUTION_TRADE_CLOSED` es consumido por `PositionManager` (actualiza estado), por `NotificationEngine` (envía alerta) y podría ser consumido por un módulo de analytics futuro, todo sin que `ExecutionEngine` sepa cuántos consumidores existen.

### Código clave

```js
// Emisor (ExecutionEngine) — no conoce a sus consumidores
await this._broker.publish('EXECUTION_TRADE_OPENED', {
  tradeId, symbol, direction, entryPrice, timestamp, tradePlan
});

// Consumidor A (PositionManager)
broker.subscribe('EXECUTION_TRADE_OPENED', async (payload) => {
  await this._handleTradeOpened(payload);
});

// Consumidor B (NotificationEngine)
broker.subscribe('EXECUTION_TRADE_OPENED', async (payload) => {
  await this._handleEvent('EXECUTION_TRADE_OPENED', payload);
});
```

---

## 2. Strategy

### Qué es

El patrón **Strategy** define una familia de algoritmos, encapsula cada uno en su propia clase e intercambiables. El cliente usa el algoritmo sin conocer su implementación concreta.

### El problema que resuelve en general

Sin Strategy, la lógica de cada algoritmo vive en condicionales:

```js
// Sin Strategy: difícil de mantener y extender
if (strategyType === 'fibonacci') {
  // 200 líneas de lógica Fibonacci
} else if (strategyType === 'ma-cross') {
  // 150 líneas de media móvil
} else if (strategyType === 'rsi') {
  // ...
}
```

Agregar una nueva estrategia requiere modificar este bloque.

### Cómo lo resuelve en NesxTrader

`StrategyBase` define el contrato. El `StrategyEngine` trabaja solo con la interfaz — nunca sabe qué estrategia concreta está ejecutando.

```js
// Contrato (StrategyBase)
class StrategyBase {
  get id()                  { throw new Error('implement id'); }
  get requiredTimeframes()  { throw new Error('implement requiredTimeframes'); }
  async evaluate(state)     { throw new Error('implement evaluate'); }
}

// Implementación concreta
class FibonacciVolumeStrategy extends StrategyBase {
  get id()                 { return 'fibonacci-volume-v1'; }
  get requiredTimeframes() { return ['1m']; }
  async evaluate(state)    { /* lógica Fibonacci */ }
}

// StrategyEngine — trabaja con la interfaz, no con la implementación
for (const strategy of this._registry.getAll()) {
  const state = this._marketStateBuilder.build(symbol, strategy.requiredTimeframes);
  const tradePlan = await strategy.evaluate(state);
  if (tradePlan) await this._emitSignal(tradePlan);
}
```

**Consecuencia real:** agregar `MACrossStrategy` o `RSIStrategy` es crear un archivo nuevo y registrarlo. No se toca `StrategyEngine`, `BacktestRunner` ni ningún módulo existente.

### Por qué funciona en backtest igual que en live

El `BacktestRunner` usa el mismo `StrategyEngine` que el modo Live. El patrón Strategy garantiza que la misma lógica de evaluación funciona en cualquier contexto.

---

## 3. Adapter

### Qué es

El patrón **Adapter** convierte la interfaz de una clase en otra que el cliente espera. Permite que clases con interfaces incompatibles trabajen juntas.

### El problema que resuelve en general

`ExecutionEngine` necesita colocar órdenes. Si se acopla directamente a la API de Binance, no puede probarse sin red ni usarse en modo Dry Run.

```js
// Sin Adapter: acoplamiento a implementación concreta
const response = await axios.post('https://api.binance.com/api/v3/order', {
  symbol, side, type, quantity, price
});
// ExecutionEngine ahora depende de Binance directamente
```

### Cómo lo resuelve en NesxTrader

`BrokerAdapter` define la interfaz canónica. `ExecutionEngine` solo habla con esa interfaz — nunca con Binance directamente.

```js
// Interfaz canónica (BrokerAdapter)
async placeOrder({ symbol, side, type, quantity, price, stopPrice, clientOrderId })
  → { orderId, status, fillPrice? }

// Implementación real (BinanceAdapter)
class BinanceAdapter extends BrokerAdapter {
  async placeOrder(order) {
    // Traduce a la API HTTP de Binance
    const res = await this._restPost('/api/v3/order', this._toBinanceParams(order));
    return this._fromBinanceResponse(res);
  }
}

// Implementación simulada (DryRunAdapter)
class DryRunAdapter extends BrokerAdapter {
  async placeOrder(order) {
    // Simula el fill localmente, sin HTTP
    const orderId = this._generateId();
    this._orders.set(orderId, { ...order, status: 'PENDING' });
    if (order.type === 'MARKET') return this._fillMarketOrder(order, orderId);
    return { orderId, status: 'PENDING' };
  }
}

// ExecutionEngine — nunca sabe si es Binance o simulado
constructor({ brokerAdapter }) {
  this._broker = brokerAdapter; // acepta cualquiera que cumpla BrokerAdapter
}
await this._broker.placeOrder({ symbol, side: 'BUY', type: 'MARKET', quantity });
```

**Consecuencia real:** el mismo `ExecutionEngine` funciona en tres contextos solo cambiando el adapter inyectado:
- Tests unitarios: `MockAdapter` (objeto literal con `placeOrder: jest.fn()`)
- Dry Run: `DryRunAdapter`
- Live: `BinanceAdapter`

El Adapter también actúa como **frontera de traducción** — `normalizers.js` es el adaptador entre el formato crudo de Binance (array de 12 elementos) y el formato interno `Candle`.

---

## 4. Repository

### Qué es

El patrón **Repository** abstrae el acceso a datos detrás de una interfaz orientada a objetos. La lógica de negocio no sabe si los datos vienen de PostgreSQL, Redis o un archivo.

### El problema que resuelve en general

Sin Repository, el SQL vive en la lógica de negocio:

```js
// Sin Repository: la lógica de negocio conoce SQL
async function handleTradeOpened(payload) {
  await db.query(
    'INSERT INTO trades (trade_id, symbol, direction, entry_price) VALUES ($1, $2, $3, $4)',
    [payload.tradeId, payload.symbol, payload.direction, payload.entryPrice]
  );
  this._positions.set(payload.tradeId, payload); // también en memoria
}
```

Testear esta función requiere una base de datos real o mocks de `db.query`.

### Cómo lo resuelve en NesxTrader

Cada módulo con persistencia tiene su propio Repository. La lógica de negocio recibe el repositorio inyectado y llama métodos con nombres de dominio:

```js
// PositionRepository — todo el SQL encapsulado aquí
class PositionRepository {
  async save(position)              { /* INSERT INTO trades ... */ }
  async update(tradeId, changes)    { /* UPDATE trades SET ... */ }
  async findOpen()                  { /* SELECT ... WHERE status IN ('OPEN', 'PARTIAL') */ }
  async findById(tradeId)           { /* SELECT ... WHERE trade_id = $1 */ }
}

// PositionManager — habla en términos de dominio, no SQL
async _handleTradeOpened(payload) {
  const position = this._buildPosition(payload);
  this._positions.set(position.tradeId, position);         // memoria
  await this._repo.save(position).catch(err => {           // BD (no crítico)
    this._logger.error(`Error persistiendo posición: ${err.message}`);
  });
}
```

**Repositorios en el sistema:**

| Repository | Tabla(s) | Módulo que lo usa |
|-----------|---------|------------------|
| `CandleRepository` | candles_1s, candles_1m, candles_1h | Data, Backtest |
| `PositionRepository` | trades | Position |
| `BacktestRepository` | backtest_runs, backtest_trades | Backtest |

**Consecuencia real en tests:** el test de integración E2E de backtest usa un `BacktestRepository` stub (objeto literal con `saveRun: async () => 'test-run-id'`) — no necesita una BD real para probar el flujo de negocio.

---

## 5. Dependency Injection

### Qué es

**Dependency Injection (DI)** es el principio de que un objeto no crea sus propias dependencias — las recibe desde afuera. Implementado aquí via **Constructor Injection**.

### El problema que resuelve en general

Sin DI, las clases crean sus dependencias internamente:

```js
// Sin DI: acoplamiento, no testeable
class StrategyEngine {
  constructor() {
    this._broker = new MessageBroker();     // instancia fija
    this._registry = new StrategyRegistry(); // no intercambiable
    this._time = Date;                       // no controlable en tests
  }
}
```

No hay forma de sustituir el `MessageBroker` por un mock en tests.

### Cómo lo resuelve en NesxTrader

**Todos** los módulos reciben sus dependencias por constructor. Ninguno instancia sus propias dependencias de infraestructura.

```js
class StrategyEngine {
  constructor({ messageBroker, strategyRegistry, marketStateBuilder, timeProvider, logger }) {
    if (!messageBroker)     throw new Error('StrategyEngine: se requiere messageBroker');
    if (!strategyRegistry)  throw new Error('StrategyEngine: se requiere strategyRegistry');
    if (!marketStateBuilder) throw new Error('StrategyEngine: se requiere marketStateBuilder');
    if (!timeProvider)      throw new Error('StrategyEngine: se requiere timeProvider');

    this._broker   = messageBroker;
    this._registry = strategyRegistry;
    this._builder  = marketStateBuilder;
    this._time     = timeProvider;
    this._logger   = logger || { info: console.log, warn: console.warn, error: console.error };
  }
}
```

**Beneficios concretos en NesxTrader:**

1. **Testabilidad:** los tests pasan mocks simples sin necesidad de `jest.mock()` a nivel de módulo
2. **Intercambiabilidad de modos:** el mismo `StrategyEngine` funciona con `ReplayProvider` (backtest) o `DataProvider` (live) porque ambos emiten `MARKET_CANDLE_CLOSED`
3. **Validación en construcción:** si falta una dependencia, el error falla inmediatamente en el constructor (fail-fast), no en runtime cuando se usa

```js
// En tests: dependencias simuladas sin tocar el módulo real
const engine = new StrategyEngine({
  messageBroker:    { subscribe: jest.fn(), publish: jest.fn() },
  strategyRegistry: { getAll: () => [mockStrategy] },
  marketStateBuilder: { addCandle: jest.fn(), build: () => mockState },
  timeProvider:     { now: () => 1700000000000 },
});
```

---

## 6. Registry

### Qué es

El patrón **Registry** es un directorio centralizado que permite a los objetos encontrar otros objetos o servicios por nombre/ID. Es el "directorio de páginas amarillas" del sistema.

### El problema que resuelve en general

Sin Registry, el código que necesita usar una estrategia tiene que conocer todas las clases concretas:

```js
// Sin Registry: hardcodeado
if (config.strategyId === 'fibonacci-volume-v1') {
  strategy = new FibonacciVolumeStrategy();
} else if (config.strategyId === 'ma-cross-v1') {
  strategy = new MACrossStrategy();
}
// Agregar una estrategia requiere modificar este bloque
```

### Cómo lo resuelve en NesxTrader

`StrategyRegistry` es el punto único de registro y resolución. El `StrategyEngine` y el `BacktestRunner` usan `resolve(id)` sin saber qué clases concretas existen.

```js
// Registro (en bootstrap de la app)
registry.register(new FibonacciVolumeStrategy({ onZoneArmed, onZoneDisarmed }));
registry.register(new MACrossStrategy());

// Resolución (StrategyEngine o BacktestRunner)
const strategy = registry.resolve('fibonacci-volume-v1');

// Iteración (evaluar todas las estrategias activas)
for (const strategy of registry.getAll()) {
  await strategy.evaluate(state);
}
```

**Validación al registrar** — el Registry actúa como guardián del contrato:

```js
register(strategy) {
  if (!(strategy instanceof StrategyBase)) {
    throw new Error(`Registry: ${strategy?.constructor?.name} no extiende StrategyBase`);
  }
  if (this._strategies.has(strategy.id)) {
    throw new Error(`Registry: estrategia '${strategy.id}' ya registrada`);
  }
  this._strategies.set(strategy.id, strategy);
}
```

**Consecuencia real:** agregar una nueva estrategia es añadir una línea de `registry.register(new MiEstrategia())` en el bootstrap. Cero cambios en los módulos existentes.

---

## 7. Template Method

### Qué es

El patrón **Template Method** define el esqueleto de un algoritmo en una clase base, dejando que las subclases implementen ciertos pasos sin cambiar la estructura general del algoritmo.

### El problema que resuelve en general

Cuando múltiples estrategias comparten la misma estructura de ejecución pero difieren en los detalles, sin Template Method cada estrategia reimplementa la estructura entera, con riesgo de inconsistencia.

### Cómo lo resuelve en NesxTrader

`StrategyBase` define el contrato de los "pasos" que toda estrategia debe implementar. `StrategyEngine` ejecuta siempre el mismo algoritmo (el template):

```
Template en StrategyEngine._evaluateStrategy(strategy, symbol):
  1. Verificar que el timeframe de la vela está en strategy.requiredTimeframes
  2. Construir MarketState via marketStateBuilder.build()
  3. Llamar strategy.evaluate(state)    ← paso variable (cada estrategia lo implementa)
  4. Si retorna TradePlan → emitir STRATEGY_SIGNAL_GENERATED
```

`FibonacciVolumeStrategy.evaluate()` implementa solo el paso 3 — el algoritmo Fibonacci — sin preocuparse por los pasos 1, 2 y 4 que el Engine gestiona.

**Ejemplo concreto:** si mañana se agrega `RSIStrategy`, hereda automáticamente todo el plumbing del engine (suscripción a eventos, construcción del estado, emisión de señales) y solo implementa su lógica de señal:

```js
class RSIStrategy extends StrategyBase {
  get id()                 { return 'rsi-v1'; }
  get requiredTimeframes() { return ['1h']; }

  async evaluate(state) {
    const rsi = this._calculateRSI(state.candles['1h']);
    if (rsi < 30) return this._buildLongPlan(state);
    if (rsi > 70) return this._buildShortPlan(state);
    return null;
  }
}
```

---

## 8. Builder

### Qué es

El patrón **Builder** separa la construcción de un objeto complejo de su representación. Permite construir el mismo tipo de objeto paso a paso, acumulando estado.

### El problema que resuelve en general

`MarketState` es un objeto que agrega datos de múltiples timeframes para múltiples símbolos, construidos incrementalmente en cada vela cerrada. Sin Builder, cada módulo que necesita este estado lo tendría que construir de cero.

### Cómo lo resuelve en NesxTrader

`MarketStateBuilder` acumula velas en buffers internos y construye el estado cuando se le pide:

```js
// Fase de acumulación — se llama por cada vela que llega
marketStateBuilder.addCandle({ symbol: 'BTCUSDT', timeframe: '1m', candle });
marketStateBuilder.addCandle({ symbol: 'BTCUSDT', timeframe: '4h', candle });

// Fase de construcción — cuando la estrategia necesita el estado
const state = marketStateBuilder.build('BTCUSDT', ['1m', '4h']);
// Retorna:
// {
//   symbol: 'BTCUSDT',
//   timestamp: 1700000000000,
//   candles: { '1m': [...últimas 500 velas], '4h': [...últimas 500 velas] },
//   currentPrice: 30500,
// }
```

**Gestión del buffer:** el Builder mantiene un buffer circular de tamaño `maxCandles` (default 500) por (symbol, timeframe). Descarta automáticamente las velas más antiguas — el llamador no necesita gestionar memoria.

**Consecuencia real:** `FibonacciVolumeStrategy.evaluate()` recibe un `MarketState` completo y listo. No necesita saber cómo se acumularon las velas ni cuándo.

---

## 9. Facade

### Qué es

El patrón **Facade** provee una interfaz simplificada para un subsistema complejo. Oculta la complejidad interna y expone solo lo que el cliente necesita.

### El problema que resuelve en general

Coordinar múltiples objetos con sus propios protocolos es complejo y repetitivo. Sin Facade, el código cliente tiene que conocer y orquestar todos los subsistemas.

### Cómo lo resuelve en NesxTrader

**`ExecutionEngine` como Facade del subsistema de ejecución:**

Desde afuera, el `ExecutionEngine` expone solo `start()`, `stop()`, `moveSL()` y `closeTrade()`. Internamente coordina cuatro subsistemas:

```
ExecutionEngine.start()
  → suscribe a STRATEGY_SIGNAL_GENERATED
  → en señal:
      ExposureManager.canExecute()      ← subsistema de riesgo
      ExposureManager.calculateSize()
      OrderManager.openPosition()       ← subsistema de órdenes
      BrokerAdapter.placeOrder()        ← subsistema de broker
      broker.publish(TRADE_OPENED)      ← bus de eventos
```

El `StrategyEngine` no sabe que existe `ExposureManager` ni `OrderManager`. Solo emite `STRATEGY_SIGNAL_GENERATED` y el `ExecutionEngine` se encarga del resto.

**`BacktestRunner` como Facade del subsistema de backtest:**

```
BacktestRunner.run(config)
  → ReplayProvider.replay()         ← subsistema de datos
  → StrategyEngine.evaluate()       ← subsistema de estrategias
  → FillSimulator.simulateFill()    ← subsistema de fills
  → MetricsCalculator.calculate()   ← subsistema de métricas
  → BacktestRepository.saveRun()    ← subsistema de persistencia
  → return BacktestReport
```

El cliente llama un método y recibe un reporte completo — no necesita conocer los 5 subsistemas internos.

---

## 10. Command / Value Object

### Qué es

**Command** encapsula una petición como objeto, permitiendo parametrizar, encolar y pasar acciones como datos. **Value Object** es un objeto definido por sus valores (no por identidad), inmutable.

### El problema que resuelve en general

Sin este patrón, la señal de trading sería una llamada directa entre módulos:

```js
// Sin Command: acoplamiento directo
strategyEngine.sendSignalTo(executionEngine, 'LONG', 'BTCUSDT', 30000, 29700);
// StrategyEngine ahora conoce ExecutionEngine
```

### Cómo lo resuelve en NesxTrader

`TradePlan` es el Command/Value Object central del sistema. La estrategia lo construye, el bus de eventos lo transporta, y el `ExecutionEngine` lo consume. Nadie se conoce entre sí.

```js
// Construido por FibonacciVolumeStrategy
const tradePlan = {
  strategyId:  'fibonacci-volume-v1',
  symbol:      'BTCUSDT',
  direction:   'LONG',
  entryPrice:  30980,
  stopLoss:    29900,
  takeProfits: [
    { price: 31700, sizePercent: 30 },
    { price: 32060, sizePercent: 40 },
    { price: 32600, sizePercent: 30 },
  ],
  riskPercent: 1,
  metadata:    { triggerCandle, fibLevels }
};

// Transportado por el bus de eventos
broker.publish('STRATEGY_SIGNAL_GENERATED', { tradePlan });

// Consumido por ExecutionEngine — valida y ejecuta
this._validateTradePlan(tradePlan); // verifica todos los campos
const { units } = await this._exposure.calculateSize(tradePlan);
await this._orders.openPosition({ tradeId, tradePlan, units });
```

**`FillResult` también es un Value Object** — describe el resultado inmutable de un trade simulado, transportado desde `FillSimulator` hasta `MetricsCalculator` sin modificarse.

**Ventaja concreta:** el `TradePlan` sirve como interfaz entre Strategy y Execution. Strategy nunca sabe cómo se ejecuta; Execution nunca sabe cómo se generó.

---

## 11. Null Object

### Qué es

El patrón **Null Object** provee un objeto con comportamiento "neutro" o "no operación" en lugar de `null`. Elimina comprobaciones `if (x !== null)` dispersas por el código.

### El problema que resuelve en general

```js
// Sin Null Object: comprobaciones de null en todas partes
if (this._logger !== null && this._logger !== undefined) {
  this._logger.info('mensaje');
}
if (this._onZoneArmed !== null) {
  this._onZoneArmed(payload);
}
```

### Cómo lo resuelve en NesxTrader

**Logger con Null Object implícito:**

Todos los módulos tienen un logger con un fallback inline que nunca es `null`:

```js
constructor({ logger }) {
  this._logger = logger || {
    info:  (...a) => console.log('[Module]', ...a),
    warn:  (...a) => console.warn('[Module]', ...a),
    error: (...a) => console.error('[Module]', ...a),
  };
  // Nunca necesitamos: if (this._logger) this._logger.info(...)
}
this._logger.info('siempre seguro');
```

**Callbacks opcionales en FibonacciVolumeStrategy:**

```js
constructor({ onZoneArmed, onZoneDisarmed } = {}) {
  // Si no se inyectan, se asigna null y se comprueba antes de invocar
  this._onZoneArmed    = typeof onZoneArmed    === 'function' ? onZoneArmed    : null;
  this._onZoneDisarmed = typeof onZoneDisarmed === 'function' ? onZoneDisarmed : null;
}

_armZone(symbol, triggerCandle) {
  this._armedZone = { symbol, triggerCandle, levels };
  if (this._onZoneArmed) {  // solo llama si fue inyectado
    this._onZoneArmed({ strategyId: this.id, symbol, levels, triggerCandle });
  }
}
```

**Consecuencia real:** en tests unitarios de `FibonacciVolumeStrategy`, no hace falta inyectar los callbacks ni el logger — la estrategia funciona "silenciosamente" sin efectos secundarios.

---

## 12. Chain of Responsibility

### Qué es

El patrón **Chain of Responsibility** pasa una petición por una cadena de handlers. Cada handler decide si la procesa o la pasa al siguiente. Desacopla al emisor del receptor y permite componer validaciones.

### El problema que resuelve en general

Procesar una señal de trading requiere múltiples validaciones en secuencia. Sin este patrón, se acumula una función gigante con condiciones anidadas.

### Cómo lo resuelve en NesxTrader

El flujo de procesamiento de una señal en `ExecutionEngine._handleSignal()` es una cadena implícita de responsabilidades, donde cada paso puede abortar:

```
Señal recibida (STRATEGY_SIGNAL_GENERATED)
    │
    ▼
[Handler 1] _validateTradePlan(tradePlan)
    ├── falla → _rejectSignal() → emite EXECUTION_SIGNAL_REJECTED → FIN
    └── pasa ↓
    │
    ▼
[Handler 2] exposureManager.canExecute(tradePlan)
    ├── allowed: false → _rejectSignal() → FIN
    └── allowed: true ↓
    │
    ▼
[Handler 3] exposureManager.calculateSize(tradePlan)
    ├── error → _handleBrokerError() → FIN
    └── { units } ↓
    │
    ▼
[Handler 4] orderManager.openPosition({ tradeId, tradePlan, units })
    ├── error recuperable → log + FIN
    ├── error no recuperable → SYSTEM_CRITICAL_ERROR → FIN
    └── éxito ↓
    │
    ▼
[Handler 5] exposureManager.registerOpenTrade()
broker.publish('EXECUTION_TRADE_OPENED')
```

Cada "eslabón" de la cadena tiene una responsabilidad única y bien definida:
- `_validateTradePlan` → integridad del contrato
- `canExecute` → límites de riesgo
- `calculateSize` → cálculo de tamaño
- `openPosition` → interacción con el broker

**Ventaja real:** agregar una nueva validación (ej. "no operar en viernes") es añadir un nuevo eslabón sin modificar los existentes.

---

## 13. Proxy (abstracción de tiempo)

### Qué es

El patrón **Proxy** es un sustituto que controla el acceso a otro objeto. En este caso, `TimeProvider` es un Proxy de `Date` que permite interceptar y controlar las llamadas a `Date.now()`.

### El problema que resuelve en general

Los tests de módulos que dependen del tiempo son no deterministas:

```js
// Sin TimeProvider: no testeable de forma determinista
class FillSimulator {
  simulateFill(tradePlan) {
    const entryTimestamp = Date.now();  // diferente en cada ejecución
    // ...
  }
}
```

En backtest, el tiempo tiene que avanzar junto con las velas históricas — no puede ser el tiempo real.

### Cómo lo resuelve en NesxTrader

`TimeProvider` es el único punto de acceso al tiempo en todo el sistema:

```js
// Implementación real (Live)
class RealTimeProvider {
  now() { return Date.now(); }
}

// Implementación controlable (Backtest)
class SimulatedTimeProvider {
  constructor() { this._time = 0; }
  now()          { return this._time; }
  setTime(ms)    { this._time = ms; }
}

// En ReplayProvider — avanza el reloj antes de cada vela
for (const candle of candles) {
  this._timeProvider.setTime(candle.openTime);  // reloj = tiempo de la vela
  await this._broker.publish('MARKET_CANDLE_CLOSED', { candle });
}
```

**Consecuencia real:** en el test E2E de backtest, todos los timestamps en `FillResult` son coherentes con las velas históricas, no con el reloj del servidor donde corre el test. El test es 100% determinista.

**En tests unitarios:**

```js
const timeProvider = { now: jest.fn(() => 1700000000000) };
// Ahora podemos controlar exactamente qué tiempo ve el módulo
```

---

## 14. Retry con Backoff Exponencial

### Qué es

No es un patrón GoF clásico, sino un patrón de resiliencia: reintentar operaciones fallidas con esperas crecientes para no saturar el sistema remoto.

### El problema que resuelve en general

Las conexiones WebSocket a Binance pueden caerse por problemas de red. Reconectar inmediatamente en un loop puede:
1. Saturar el servidor con peticiones
2. Agravar el problema si Binance está en mantenimiento
3. Consumir recursos innecesariamente

### Cómo lo resuelve en NesxTrader

`BinanceAdapter` implementa backoff exponencial con límite máximo:

```
Intento 1 → falla → espera 1s
Intento 2 → falla → espera 2s
Intento 3 → falla → espera 4s
Intento 4 → falla → espera 8s
Intento 5 → falla → espera 16s → máximo 60s
Intento 6 → falla → SYSTEM_CRITICAL_ERROR (se rinde)
```

```js
_scheduleReconnect() {
  if (this._retries >= MAX_RETRIES) {
    this._broker.publish('SYSTEM_CRITICAL_ERROR', {
      source: 'BinanceAdapter',
      error:  'WebSocket: máximo de reintentos superado',
      recoverable: false,
    });
    return;
  }

  const delay = Math.min(
    BACKOFF_BASE_MS * Math.pow(2, this._retries),
    BACKOFF_MAX_MS
  );
  this._retries++;
  setTimeout(() => this._openWebSocket(), delay);
}
```

**Consecuencia real:** una caída de red de 10 segundos se recupera sola sin intervención. Una caída prolongada escala a `NotificationEngine` via `SYSTEM_CRITICAL_ERROR`, que envía alerta por Telegram.

---

## 15. Throttle

### Qué es

El patrón **Throttle** limita la frecuencia con que una operación puede ejecutarse. A diferencia de Debounce (que espera inactividad), Throttle garantiza una ejecución cada N milisegundos como máximo.

### El problema que resuelve en general

Sin throttle, `NotificationEngine` enviaría una notificación de Telegram por cada vela de 1 segundo. Con 86.400 velas diarias por símbolo, el canal de Telegram quedaría inutilizable y posiblemente baneado por la API de Telegram.

### Cómo lo resuelve en NesxTrader

`NotificationEngine` implementa throttle configurable por tipo de evento:

```js
// Configuración por defecto: 60s entre mensajes del mismo tipo
const DEFAULT_THROTTLE_MS = 60_000;

// Configurable al instanciar:
new NotificationEngine({
  throttle: {
    SYSTEM_CRITICAL_ERROR: 0,          // sin throttle (urgente)
    EXECUTION_TRADE_OPENED: 0,         // sin throttle (poco frecuente)
    STRATEGY_SIGNAL_GENERATED: 5_000,  // máx 1 cada 5s (puede ser frecuente)
  }
})

_isThrottled(eventName) {
  const limitMs = this._throttleConfig[eventName] ?? DEFAULT_THROTTLE_MS;
  if (limitMs === 0) return false;

  const lastSent = this._lastSent.get(eventName);
  if (lastSent == null) return false;

  return (this._timeProvider.now() - lastSent) < limitMs;
}
```

**Decisión de diseño notable:** el timestamp se registra **antes** del envío, no después:

```js
this._lastSent.set(eventName, this._timeProvider.now()); // ANTES
await Promise.all(this._channels.map(ch => this._sendToChannel(ch, message)));
```

Si Telegram falla, el evento sigue considerándose "enviado" para el throttle. Evita un burst de reintentos cuando el canal está roto sistémicamente.

---

## 16. Resumen y mapa de relaciones

### Tabla de patrones por módulo

| Módulo | Patrones usados |
|--------|----------------|
| MessageBroker | Observer, Event-Driven |
| StrategyBase + estrategias | Strategy, Template Method |
| StrategyRegistry | Registry |
| StrategyEngine | Facade, Observer |
| MarketStateBuilder | Builder |
| BrokerAdapter / DryRunAdapter | Adapter |
| ExecutionEngine | Facade, Chain of Responsibility |
| ExposureManager | — |
| OrderManager | Command (usa TradePlan) |
| TradePlan, FillResult | Command, Value Object |
| PositionManager | Observer |
| BacktestRunner | Facade |
| FillSimulator | Strategy (modos PRECISE_1S / PRECISE_1M / PESSIMISTIC) |
| NotificationEngine | Observer, Throttle, Null Object |
| TimeProvider | Proxy |
| BinanceAdapter | Adapter, Retry/Backoff |
| Todos los módulos | Dependency Injection, Null Object (logger) |

### Cómo se complementan los patrones

Los patrones no se usan de forma aislada — se refuerzan mutuamente:

```
Dependency Injection
  └─ permite intercambiar implementaciones (Adapter)
  └─ hace posible el testing sin infraestructura real

Observer (MessageBroker)
  └─ desacopla los módulos entre sí
  └─ permite que Facade (ExecutionEngine, BacktestRunner) orqueste sin exponer detalles

Strategy (StrategyBase)
  └─ combinado con Registry → extensible sin modificar código existente
  └─ combinado con Template Method → cada estrategia implementa solo su lógica

Proxy (TimeProvider)
  └─ hace deterministas los tests del Builder, FillSimulator, MetricsCalculator
  └─ permite al ReplayProvider sincronizar el tiempo con las velas históricas

Command (TradePlan)
  └─ es el "mensaje" que viaja por el Observer (MessageBroker)
  └─ es validado por la Chain of Responsibility (ExecutionEngine)
```

### El patrón más impactante: Dependency Injection + Observer

La combinación de DI y Observer es lo que permite que el mismo código funcione en Backtest, Dry Run y Live sin un solo `if (mode === 'backtest')`:

```
Backtest:
  ReplayProvider  ──publish──▶ MARKET_CANDLE_CLOSED ──▶ StrategyEngine
                                                     ──▶ BacktestRunner

Live:
  DataProvider    ──publish──▶ MARKET_CANDLE_CLOSED ──▶ StrategyEngine
                                                     ──▶ ExecutionEngine

El StrategyEngine no sabe de dónde viene la vela.
El ExecutionEngine / BacktestRunner no sabe qué estrategia generó la señal.
```

Cada módulo solo conoce los eventos del bus y las interfaces de sus dependencias inyectadas. El modo de operación es una **decisión de composición** tomada en el bootstrap de la aplicación — no en la lógica de negocio.
