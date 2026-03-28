# NesxTrader — Contexto General del Proyecto

## ¿Qué es esto?

Bot de trading de criptomonedas construido en Node.js + PostgreSQL (TimescaleDB).  
Su propósito principal es **validar estrategias mediante backtesting** antes de operar con capital real.  
El sistema opera en tres modos intercambiables sin cambiar código: **Backtest → Dry Run → Live**.

---

## Stack Tecnológico

| Capa | Tecnología |
|------|-----------|
| Runtime | Node.js 20+ |
| Base de datos | PostgreSQL 16 + TimescaleDB |
| Broker | Binance (via Adapter — intercambiable) |
| Comunicación interna | EventEmitter (MessageBroker) |
| Testing | Jest + contenedor PG dedicado |
| Infraestructura | Docker Compose |

---

## Módulos del Sistema

Cada módulo tiene su propia conversación en Claude Projects (sub-agente).  
**No implementes lógica de otro módulo sin consultar su sub-agente.**

```
nesxtrader/
├── src/
│   ├── data/          → [AGENTE: Data Provider]
│   ├── strategy/      → [AGENTE: Strategy Engine]
│   ├── execution/     → [AGENTE: Execution Engine]
│   ├── backtest/      → [AGENTE: Backtest Engine]
│   ├── position/      → [AGENTE: Position Manager]
│   ├── notification/  → [AGENTE: Notification Engine]
│   ├── shared/        → TimeProvider, MessageBroker, Logger (cross-cutting)
│   └── db/            → Repositorios, migraciones, schema
├── docs/
│   └── architecture-v2.md   ← documento completo de arquitectura
└── CLAUDE.md                ← este archivo
```

---

## Reglas de Diseño Innegociables

1. **TimeProvider siempre inyectado** — ningún módulo llama `Date.now()` directamente
2. **Datos solo via repositorios** — nadie accede a tablas SQL directamente desde lógica de negocio
3. **Toda estrategia implementa StrategyBase** — contrato formal, sin excepciones
4. **Eventos tipados** — toda comunicación entre módulos usa el MessageBroker con el catálogo de eventos definido
5. **Los módulos no saben el modo** — Live, Dry Run y Backtest emiten los mismos eventos; el consumidor nunca detecta el modo

---

## Contratos Clave

### StrategyBase (toda estrategia DEBE implementar esto)
```js
class StrategyBase {
  get id()                  // String — ID único
  get requiredTimeframes()  // String[] — ej. ['1m', '15m', '4h']
  async evaluate(state)     // MarketState → TradePlan | null
}
```

### MarketState (entrada a evaluate)
```js
{
  symbol: String,
  timestamp: Number,        // via TimeProvider
  candles: { [tf]: Candle[] },
  currentPrice: Number,
}
```

### TradePlan (salida de evaluate)
```js
{
  strategyId: String,
  symbol: String,
  direction: 'LONG' | 'SHORT',
  entryPrice: Number,
  stopLoss: Number,
  takeProfits: [{ price, sizePercent }],
  riskPercent: Number,
  metadata: Object,
}
```

### FillResult (salida del FillSimulator en backtest)
```js
{
  tradeId: String,
  entryFill: { price, timestamp, slippage },
  exitFill: { price, timestamp, type: 'TP'|'SL'|'MANUAL' },
  pnl: Number,
  resolution_mode: 'PRECISE_1S' | 'PRECISE_1M' | 'PESSIMISTIC',
  had_ambiguity: Boolean,
}
```

---

## Catálogo de Eventos (MessageBroker)

| Evento | Emisor | Consumidores |
|--------|--------|-------------|
| `MARKET_CANDLE_CLOSED` | DataProvider | StrategyEngine, PositionManager |
| `STRATEGY_SIGNAL_GENERATED` | StrategyEngine | ExposureManager, ExecutionEngine |
| `EXECUTION_TRADE_OPENED` | ExecutionEngine / FillSimulator | PositionManager, DB |
| `EXECUTION_TRADE_CLOSED` | ExecutionEngine / FillSimulator | PositionManager, DB, ExposureManager |
| `EXECUTION_SL_MOVED` | ExecutionEngine | PositionManager, DB |
| `SYSTEM_CRITICAL_ERROR` | Cualquier módulo | NotificationEngine, proceso principal |

> Lista completa en `docs/architecture-v2.md` sección "Catálogo de Eventos"

---

## Base de Datos Existente (market-tracker)

El proyecto ya tiene tablas en TimescaleDB que NesxTrader reutiliza:

| Tabla | Contenido |
|-------|-----------|
| `candles_1s` | Velas de 1 segundo por par |
| `candles_1m` | Velas de 1 minuto por par |
| `candles_1h` | Velas de 1 hora por par |
| `symbols` | Pares disponibles con metadata |

NesxTrader agrega sus propias tablas (trades, executions, backtest_runs) sin tocar las de market-tracker.

---

## Flujo de Backtesting (resumen)

```
BacktestRunner
  → CandleRepository (carga histórico)
    → emite MARKET_CANDLE_CLOSED (replay)
      → StrategyEngine.evaluate()
        → TradePlan
          → FillSimulator (resuelve fills con datos 1s/1m/PESSIMISTIC)
            → FillResult
              → MetricsCalculator
                → BacktestReport
```

### Resolución Adaptativa del FillSimulator

| Modo | Condición | Comportamiento |
|------|-----------|---------------|
| `PRECISE_1S` | Hay velas de 1s disponibles | Fill exacto con slippage real |
| `PRECISE_1M` | Solo hay velas de 1m | Fill aproximado con velas de 1m |
| `PESSIMISTIC` | Sin datos granulares | SL siempre se toca primero en ambigüedad |

---

## Cómo Agregar una Nueva Estrategia

1. Crear `src/strategy/strategies/MiEstrategia.js` implementando `StrategyBase`
2. Registrarla en `src/strategy/StrategyRegistry.js`
3. Correr backtest: `node cli backtest --strategy MiEstrategia --symbol BTCUSDT --from 2024-01-01`
4. Comparar `BacktestReport` con otras estrategias
5. Si pasa umbrales → activar en Dry Run
6. Si Dry Run es consistente → activar en Live

**En ningún paso se modifica código existente de otros módulos.**

---

## Guía de Sub-Agentes

Cuando trabajes en un módulo específico, abre la conversación del sub-agente correspondiente.  
Cada sub-agente tiene su propio `AGENT.md` con el contexto detallado de su módulo.

| Módulo | Archivo de contexto | Responsabilidad |
|--------|-------------------|-----------------|
| Data Provider | `@.claude/agents/data-provider.md` | Binance REST/WS, CandleRepository, Replay |
| Strategy Engine | `@.claude/agents/strategy-engine.md` | StrategyBase, evaluate(), StrategyRegistry |
| Execution Engine | `@.claude/agents/execution-engine.md` | Órdenes live/dry, SL/TP management |
| Backtest Engine | `@.claude/agents/backtest-engine.md` | FillSimulator, BacktestRunner, MetricsCalculator |
| Position Manager | `@.claude/agents/position-manager.md` | Estado de posiciones abiertas, sincronización |
| Notification Engine | `@.claude/agents/notification-engine.md` | Alertas, canales de salida |

> Para preguntas que cruzan módulos, trabaja aquí en la conversación raíz (orquestador).