# Patrón Observer / Event-Driven — Implementación en NesxTrader

## Qué es el patrón Observer

El patrón Observer define una relación de **uno a muchos**: cuando un objeto cambia de estado, notifica automáticamente a todos sus dependientes.

La variante **Event-Driven** agrega una pieza clave: un **intermediario** (el bus de eventos o "broker") que desacopla al emisor del receptor. El emisor no sabe quién escucha. El receptor no sabe quién emite. Ambos solo conocen el **nombre del evento**.

```
Patrón Observer básico:
  Sujeto → conoce a sus Observadores → los notifica directamente

Patrón Event-Driven (Observer desacoplado):
  Emisor → publica en el Bus → Bus → notifica a Suscriptores
  (Emisor y Suscriptores NO se conocen entre sí)
```

---

## El intermediario: MessageBroker

En NesxTrader **no existe un archivo `MessageBroker.js`** con una clase formal. El broker es un **objeto literal** construido con una función factory, y cada contexto (producción, tests de integración, tests unitarios) lo implementa de la misma manera.

La implementación real está en el test de integración del BacktestRunner y representa exactamente cómo funciona en producción:

**Archivo:** `src/backtest/__tests__/BacktestRunner.integration.test.js` (líneas 53–85)

```js
function makeMessageBroker() {
  const published = [];   // historial de todos los eventos emitidos
  const handlers  = {};   // mapa: nombre_evento → [handler1, handler2, ...]

  return {
    // SUSCRIBIRSE: registrar un handler para un evento
    subscribe: (channel, handler) => {
      if (!handlers[channel]) handlers[channel] = [];
      handlers[channel].push(handler);          // múltiples suscriptores por evento
    },

    // DESUSCRIBIRSE: eliminar un handler específico
    unsubscribe: (channel, handler) => {
      if (!handlers[channel]) return;
      handlers[channel] = handlers[channel].filter(h => h !== handler);
    },

    // PUBLICAR: ejecutar todos los handlers registrados para ese canal
    publish: async (channel, payload) => {
      published.push({ channel, payload });      // registra para auditoría/tests
      if (handlers[channel]) {
        for (const handler of handlers[channel]) {
          await handler(payload);                // await: espera que cada handler termine
        }
      }
    },
  };
}
```

### Tres conceptos del broker

| Concepto | Método | Quién lo usa |
|----------|--------|-------------|
| **Canal** | String (ej. `'MARKET_CANDLE_CLOSED'`) | Todos los módulos |
| **Suscribirse** | `subscribe(canal, handler)` | Módulos que consumen eventos |
| **Publicar** | `publish(canal, payload)` | Módulos que emiten eventos |

### Por qué `await handler(payload)` importa

El broker ejecuta los handlers **en secuencia** con `await`. Esto significa que cuando `ReplayProvider` publica una vela, espera a que `StrategyEngine` la procese completamente antes de publicar la siguiente. En backtest esto es esencial — si fuera `fire and forget`, el orden temporal se rompería.

---

## Flujo completo: de una vela a una notificación

Vamos a seguir un evento de principio a fin para ver cómo cada módulo solo conoce el broker y el nombre del evento.

### Paso 1 — El emisor: ReplayProvider publica la vela

**Archivo:** `src/data/ReplayProvider.js` (línea 91–100)

```js
for (const candle of candles) {
  this._timeProvider.setTime(candle.openTime);  // avanza el reloj

  const payload = {
    symbol:    candle.symbol,
    timeframe: candle.timeframe,
    timestamp: this._timeProvider.now(),
    candle,
  };

  await this._broker.publish('MARKET_CANDLE_CLOSED', payload);
}
```

`ReplayProvider` **no sabe** que existe `StrategyEngine`, `ExecutionEngine` ni `NotificationEngine`. Solo conoce el broker y el nombre del canal.

---

### Paso 2 — El intermediario: el broker enruta

Cuando se llama `publish('MARKET_CANDLE_CLOSED', payload)`, el broker busca en su mapa `handlers['MARKET_CANDLE_CLOSED']` y ejecuta cada función registrada.

```
handlers = {
  'MARKET_CANDLE_CLOSED': [
    ← handler registrado por StrategyEngine.start()
    ← handler registrado por BacktestRunner._subscribeToSignals()
    ← (en live: handler de ExecutionEngine para DryRun)
  ]
}
```

---

### Paso 3 — El consumidor: StrategyEngine se suscribe

**Archivo:** `src/strategy/StrategyEngine.js` (líneas 78–90)

```js
start() {
  this._running = true;

  // Registra su handler en el broker
  this._broker.subscribe('MARKET_CANDLE_CLOSED', (payload) => {
    return this._handleCandleClosed(payload).catch(err => {
      this._logger.error(`error no capturado — ${err.message}`);
    });
  });
}
```

El handler recibe el payload, evalúa las estrategias, y si hay señal... **vuelve a publicar** en el broker:

**Archivo:** `src/strategy/StrategyEngine.js` (líneas 172–184)

```js
async _emitSignal(tradePlan) {
  await this._broker.publish('STRATEGY_SIGNAL_GENERATED', { tradePlan });
}
```

`StrategyEngine` **no sabe** que existe `ExecutionEngine` ni `BacktestRunner`. Solo publica en el canal.

---

### Paso 4 — La cadena continúa

`STRATEGY_SIGNAL_GENERATED` tiene sus propios suscriptores:

- `BacktestRunner` (en backtest) → llama `FillSimulator` → publica `EXECUTION_TRADE_OPENED`
- `ExecutionEngine` (en live/dry run) → coloca órdenes → publica `EXECUTION_TRADE_OPENED`
- `NotificationEngine` → formatea y envía alerta

```
MARKET_CANDLE_CLOSED
    └─▶ StrategyEngine
            └─▶ STRATEGY_SIGNAL_GENERATED
                    ├─▶ BacktestRunner / ExecutionEngine
                    │       └─▶ EXECUTION_TRADE_OPENED
                    │               ├─▶ PositionManager
                    │               └─▶ NotificationEngine ──▶ Telegram / Console
                    └─▶ NotificationEngine ──▶ alerta de señal
```

---

### Paso 5 — NotificationEngine: suscriptor de muchos eventos

**Archivo:** `src/notification/NotificationEngine.js` (líneas 102–112)

```js
start() {
  this._running = true;

  // Se suscribe a TODOS los eventos de su catálogo en un solo loop
  for (const eventName of Object.keys(EVENT_CONFIG)) {
    this._broker.subscribe(eventName, (payload) => {
      return this._handleEvent(eventName, payload).catch(err => {
        this._logger.error(`error procesando ${eventName} — ${err.message}`);
      });
    });
  }
}
```

Los 9 eventos del catálogo (`STRATEGY_SIGNAL_GENERATED`, `EXECUTION_TRADE_OPENED`, `SYSTEM_CRITICAL_ERROR`, etc.) se suscriben todos con el mismo patrón. `NotificationEngine` **no sabe** quién los emite.

---

## El problema que resuelve: sin Observer vs con Observer

### Sin Observer (acoplamiento directo)

```js
// ReplayProvider tendría que conocer a todos sus consumidores
class ReplayProvider {
  constructor({ strategyEngine, executionEngine, notificationEngine }) { ... }

  async replay(...) {
    for (const candle of candles) {
      await this.strategyEngine.handleCandle(candle);     // acoplado
      await this.executionEngine.checkDryRun(candle);     // acoplado
      await this.notificationEngine.onCandle(candle);     // acoplado
    }
  }
}
```

Problemas:
- Agregar un nuevo consumidor (ej. Analytics) requiere modificar `ReplayProvider`
- `ReplayProvider` importa módulos de otros subsistemas → dependencias circulares
- Testear `ReplayProvider` requiere instanciar o mockear todos los consumidores

### Con Observer (Event-Driven)

```js
// ReplayProvider solo conoce el broker
class ReplayProvider {
  constructor({ messageBroker }) { ... }

  async replay(...) {
    for (const candle of candles) {
      await this._broker.publish('MARKET_CANDLE_CLOSED', { candle });
      // ¿Quién escucha? No importa. Ni lo sabe.
    }
  }
}
```

Para agregar Analytics: crear el módulo, suscribirlo al broker. **Cero cambios en ReplayProvider**.

---

## Los archivos involucrados

| Archivo | Rol en el patrón |
|---------|-----------------|
| `src/data/ReplayProvider.js` | **Emisor principal** — publica `MARKET_CANDLE_CLOSED` |
| `src/data/DataProvider.js` | **Emisor en live** — publica `MARKET_CANDLE_CLOSED` |
| `src/strategy/StrategyEngine.js` | **Suscriptor y emisor** — consume `MARKET_CANDLE_CLOSED`, publica `STRATEGY_SIGNAL_GENERATED` |
| `src/execution/ExecutionEngine.js` | **Suscriptor y emisor** — consume `STRATEGY_SIGNAL_GENERATED`, publica `EXECUTION_*` |
| `src/backtest/BacktestRunner.js` | **Suscriptor y emisor** — consume señales, publica `EXECUTION_*` (en backtest) |
| `src/position/PositionManager.js` | **Suscriptor puro** — consume 4 eventos `EXECUTION_*`, actualiza estado |
| `src/notification/NotificationEngine.js` | **Suscriptor puro** — consume 9 eventos, no emite nada |
| `src/backtest/__tests__/BacktestRunner.integration.test.js` | Contiene la **implementación real** del MessageBroker (líneas 53–85) |

---

## Cómo se suscriben los módulos: dos estilos

### Estilo 1 — suscripción explícita (StrategyEngine)

```js
// Una suscripción, un canal específico
this._broker.subscribe('MARKET_CANDLE_CLOSED', (payload) => {
  return this._handleCandleClosed(payload);
});
```

### Estilo 2 — suscripción en loop (NotificationEngine)

```js
// Itera un catálogo y suscribe todos de una vez
const EVENT_CONFIG = {
  STRATEGY_SIGNAL_GENERATED: { level: 'info' },
  EXECUTION_TRADE_OPENED:     { level: 'info' },
  SYSTEM_CRITICAL_ERROR:      { level: 'error' },
  // ... 9 eventos en total
};

for (const eventName of Object.keys(EVENT_CONFIG)) {
  this._broker.subscribe(eventName, (payload) => {
    return this._handleEvent(eventName, payload);
  });
}
```

El estilo 2 es más escalable: agregar un nuevo evento al catálogo es agregar una línea al objeto `EVENT_CONFIG` — no tocar el loop de suscripción.

---

## Cómo los tests verifican el patrón

Los tests no necesitan una implementación real del broker — solo necesitan algo que cumpla la misma interfaz (`subscribe`, `publish`). Los tests unitarios usan un mock más simple:

**Archivo:** `src/strategy/__tests__/StrategyEngine.unit.test.js` (líneas 23–40)

```js
function makeBroker() {
  const published  = [];
  const subscribers = {};

  return {
    publish: jest.fn(async (channel, payload) => {
      published.push({ channel, payload });
    }),
    subscribe: jest.fn((channel, handler) => {
      subscribers[channel] = handler;
    }),
    // Helper para simular un evento entrante desde el test
    emit: async (channel, payload) => {
      if (subscribers[channel]) {
        await subscribers[channel](payload);
      }
    },
    published,
    subscribers,
  };
}
```

El método `emit` no existe en producción — es solo un helper de test que simula que llega un evento al broker. Así el test puede disparar `MARKET_CANDLE_CLOSED` sin necesitar un `ReplayProvider` real:

```js
// En el test: simular llegada de una vela
await broker.emit('MARKET_CANDLE_CLOSED', { symbol: 'BTCUSDT', timeframe: '1m', candle });

// Verificar que StrategyEngine emitió la señal
const signals = broker.published.filter(e => e.channel === 'STRATEGY_SIGNAL_GENERATED');
expect(signals).toHaveLength(1);
```

---

## Por qué el mismo código funciona en Backtest y en Live

Esta es la consecuencia más importante del patrón en este proyecto:

```
BACKTEST:
  ReplayProvider.publish('MARKET_CANDLE_CLOSED') → StrategyEngine → BacktestRunner

LIVE:
  DataProvider.publish('MARKET_CANDLE_CLOSED')   → StrategyEngine → ExecutionEngine
```

`StrategyEngine` tiene **exactamente el mismo código** en ambos modos. Solo cambia quién está suscrito al canal `STRATEGY_SIGNAL_GENERATED` — `BacktestRunner` o `ExecutionEngine`. Esa decisión se toma en el bootstrap de la aplicación (fuera de los módulos), no dentro de ellos.

---

## Resumen visual del flujo completo

```
[ReplayProvider / DataProvider]
  │
  │  publish('MARKET_CANDLE_CLOSED', { symbol, timeframe, candle })
  │
  ▼
[MessageBroker]
  │
  ├──▶ StrategyEngine._handleCandleClosed()
  │         │
  │         │  publish('STRATEGY_SIGNAL_GENERATED', { tradePlan })
  │         │
  │         ▼
  │    [MessageBroker]
  │         ├──▶ BacktestRunner (backtest) → FillSimulator
  │         │         └── publish('EXECUTION_TRADE_OPENED')
  │         │         └── publish('EXECUTION_TRADE_CLOSED')
  │         │
  │         ├──▶ ExecutionEngine (live/dry) → BrokerAdapter
  │         │         └── publish('EXECUTION_TRADE_OPENED')
  │         │         └── publish('EXECUTION_TRADE_CLOSED')
  │         │
  │         └──▶ NotificationEngine → alerta "nueva señal"
  │
  └──▶ ExecutionEngine._handleCandleClosed() (solo DryRun, evalúa fills)
```

Cada flecha `──▶` es una suscripción registrada al inicio. El flujo entero es una cadena de eventos — ningún módulo llama a otro directamente.
