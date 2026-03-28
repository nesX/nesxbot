# NesxTrader

Bot de trading algorítmico de criptomonedas construido en Node.js + TypeScript + PostgreSQL (TimescaleDB).

Su propósito principal es **validar estrategias mediante backtesting** antes de operar con capital real.
El sistema opera en tres modos intercambiables sin cambiar código: **Backtest → Dry Run → Live**.

## Stack

| Capa | Tecnología |
|------|-----------|
| Runtime | Node.js 20+ |
| Lenguaje | TypeScript (ESM) |
| Base de datos | PostgreSQL 16 + TimescaleDB |
| Broker | Binance (via Adapter — intercambiable) |
| Comunicación interna | EventEmitter (MessageBroker) |
| Testing | Vitest |

## Estructura

```
src/
├── data/          → BinanceAdapter, CandleRepository, ReplayProvider
├── strategy/      → StrategyEngine, StrategyBase, CandleAggregator
│   └── strategies/→ FibonacciVolumeStrategy
├── execution/     → ExecutionEngine, ExposureManager, OrderManager
├── backtest/      → BacktestRunner, FillSimulator, MetricsCalculator
├── position/      → PositionManager, PositionRepository
├── notification/  → NotificationEngine, Telegram, Console
├── shared/        → MessageBroker
└── types.ts       → Contratos del dominio
```

## Requisitos

- Node.js 20+
- PostgreSQL 16 con extensión TimescaleDB
- Tablas: `candles_1s`, `candles_1m`, `candles_1h`, `symbols`

## Instalación

```bash
npm install
```

## Comandos

```bash
npm test              # ejecutar todos los tests
npm run typecheck     # verificar tipos sin compilar
npm run build         # compilar a dist/
```

## Flujo de backtesting

```
BacktestRunner
  → ReplayProvider (replay de velas históricas)
    → StrategyEngine.evaluate()
      → TradePlan
        → FillSimulator (resolución adaptativa: PRECISE_1S / PRECISE_1M / PESSIMISTIC)
          → MetricsCalculator
            → BacktestReport
```

## Agregar una nueva estrategia

1. Crear `src/strategy/strategies/MiEstrategia.ts` extendiendo `StrategyBase`
2. Registrarla en `src/strategy/StrategyRegistry.ts`
3. Correr backtest con `warmupCandles` si la estrategia necesita historial previo

## Modos de operación

Los módulos no saben en qué modo corren. El modo se determina por las dependencias inyectadas:

| Modo | BrokerAdapter | DataProvider |
|------|--------------|--------------|
| Backtest | — | ReplayProvider |
| Dry Run | DryRunAdapter | BinanceAdapter |
| Live | BinanceAdapter | BinanceAdapter |
