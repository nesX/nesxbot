---
name: Architecture Decisions
description: Decisiones de arquitectura importantes y el razonamiento detrás de ellas
type: project
---

## Decisiones clave

### StrategyBase como abstract class TypeScript
Antes lanzaba errores en runtime si no se sobreescribían los métodos. Ahora TypeScript lo fuerza en compilación.
Métodos abstractos: `evaluate()`, `get id()`, `get requiredTimeframes()`.

### MessageBroker.publish acepta `unknown`
Cambio de `Record<string, unknown>` a `unknown` elimina todos los casts forzados en los módulos que emiten eventos.
**Why:** Con `Record<string, unknown>`, cada `broker.publish(...)` requería un cast explícito.

### warmupCandles en BacktestRunner
`replayFrom = from - warmupCandles * 60_000`. Señales ignoradas si `candle.openTime < signalFrom`.
**Why:** Estrategias como SpinningTopFibStrategy necesitan N candles antes de poder agregar y detectar patrones. Sin warmup, los primeros N candles generarían señales basadas en datos insuficientes.

### FillSimulator — resolución adaptativa
| Modo | Condición | Comportamiento |
|------|-----------|---------------|
| PRECISE_1S | Hay datos 1s | Fill exacto con slippage real |
| PRECISE_1M | Solo datos 1m | Fill aproximado |
| PESSIMISTIC | Sin datos granulares | SL siempre se toca primero en ambigüedad |

### Métodos internos forzados a public (deuda técnica conocida)
`MarketStateBuilder._maxCandles`, `StrategyEngine.emitZoneArmed`, `StrategyEngine.emitZoneDisarmed`
son privados conceptualmente pero los tests los acceden directamente.
**Why:** Deuda técnica — no bloquea pero debería resolverse con test helpers o exposición deliberada.

### Scripts helpers en scripts/lib/
`scripts/lib/env.ts` — `loadEnv()` lee `.env`, no pisa env vars existentes
`scripts/lib/db.ts` — `createPool()` desde env vars
`scripts/lib/backtest.ts` — `runBacktest()`, `exportCsv()`, `createReplayTimeProvider()`

### TradeDetail capture en scripts/lib/backtest.ts
FillResult solo tiene precios de fill, no el TradePlan original (direction, SL, TP levels).
Solución: subscribirse a `EXECUTION_TRADE_OPENED` que incluye el TradePlan completo, guardarlo en Map<tradeId, plan>, combinar con FillResult al final.

## Patrones de diseño documentados
En `docs/design-patterns.md`: Observer/Event-Driven, Strategy, Adapter, Repository,
Dependency Injection, Registry, Template Method, Builder, Facade, Command/Value Object,
Null Object, Chain of Responsibility, Proxy, Retry/Backoff, Throttle (15 patrones).

## Errores resueltos relevantes para el futuro

### FibonacciVolumeStrategy — takeProfits vacío silencia señales
Cuando la vela trigger tiene high === low (zero-range), todos los niveles Fibonacci colapsan.
`_buildTakeProfits([])` retornaba `[]` → ExecutionEngine rechazaba el TradePlan silenciosamente.
Fix: `_buildTakeProfits` retorna `null` si no hay niveles válidos, `_buildTradePlan` aborta.

### EXECUTION_PARTIAL_FILLED payload incorrecto
Payload normalizdo: usa `fillPrice` (no `exitPrice`), elimina `strategyId`/`symbol`, añade `remainingSize: null`.

### STRATEGY_ZONE_ARMED / ZONE_DISARMED no en EVENT_CONFIG
NotificationEngine no suscribía estos eventos. Añadidos a `EVENT_CONFIG` con sus formatters.
