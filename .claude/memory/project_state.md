---
name: Project State
description: Estado actual del proyecto NesxTrader, decisiones arquitecturales y tareas pendientes
type: project
---

## Estado actual (2026-03-28)

### Módulos implementados
- `src/data/` — CandleRepository, BinanceAdapter, ReplayProvider, normalizers
- `src/strategy/` — StrategyBase (abstract), StrategyEngine, StrategyRegistry, MarketStateBuilder, CandleAggregator
- `src/strategy/strategies/` — SpinningTopFibStrategy, FibonacciVolumeStrategy
- `src/execution/` — ExecutionEngine, ExposureManager, OrderManager, BrokerAdapter, DryRunAdapter
- `src/backtest/` — BacktestRunner, FillSimulator, MetricsCalculator, BacktestReport
- `src/position/` — PositionManager, PositionRepository
- `src/notification/` — NotificationEngine, TelegramChannel, ConsoleChannel, TradeFormatter
- `src/shared/` — MessageBroker, TimeProvider, Logger

**412 tests pasando, 12 skipped (tests de BD real). Migración completa CJS → ESM → TypeScript.**

`src/index.ts` NO existe todavía — es la última pieza para arrancar la app en Live/Dry Run.

### Repositorio
- GitHub: `git@github.com:nesX/nesxbot.git` (rama main, ~70 archivos, ~20,449 líneas)
- Pre-push hook en `.git/hooks/`: corre typecheck + tests antes de push (no se sube a GitHub)

### Scripts
```bash
npm test                                          # Vitest, todos los tests
npm run typecheck                                 # tsc --noEmit
npm run backtest                                  # backtest comparativo 1–15m
npm run backtest -- --days weekdays               # solo días hábiles
npm run backtest -- --symbol ETHUSDT --intervals 5,10,15
npx tsx scripts/backtest-profile.ts --days 1      # profiler de performance
```

### Pendiente / próximas tareas
1. **Validar fix open_timestamp** — correr `EXPLAIN ANALYZE` en psql para confirmar chunk exclusion
2. **Backtest completo** — 3 meses BTCUSDT (Jan–Mar 2025), intervalos 1–15m, estaba detenido por performance
3. **Validación manual** — revisar CSV de trades en TradingView, filtrar `hadAmbiguity=true` primero
4. **Grid search** — 1,215 combinaciones de parámetros; estimado 60h secuencial → necesita paralelismo
5. **src/index.ts** — entry point para modo Live y Dry Run

### SpinningTopFibStrategy — parámetros base usados en backtest.ts
- maxBodyPercent: 30
- minRangePercent: 0.3
- zone1: { min: 1.8, max: 2.1 }
- zone2: { min: 2.618, max: 3.0 }
- spinningTopMode: 'SINGLE_LAST'
- zoneLifetime: Infinity
- tp1SizePercent: 50
- riskPercent: 1
- warmupCandles: interval * 20
- tradingDays: configurable vía CLI (--days all/weekdays/weekends/0,1,2...)

### Profile results (5m, 1 día, Jan 1 2025 — 0 trades por año nuevo)
- Tiempo total: 210 ms | DB fetch: 160 ms (76%) | evaluate: 38 ms (18%) | FillSimulator: 0 ms
- ms por candle: 0.025 ms | 1,541 candles emitidas
- El cuello de botella real es FillSimulator cuando hay trades (queries a binance_klines_1s)

### Observaciones sobre resultados preliminares
- Todos los exits observados fueron TP1, **nunca TP2** — posible problema de diseño
- Con tp1SizePercent=50 y SL sobre 100% de la posición, se necesita winRate >55% para ser rentable
- PnL observados en TP1: entre $0.80 y $0.86 por trade

### CSV de trades
`backtest-trades-{timestamp}.csv` — columnas: interval, entryTime, exitTime, direction, entryPrice,
entryFillPrice, stopLoss, tp1Price, tp2Price, exitFillPrice, exitType, zoneLabel,
spinningTopTime, spinningTopHigh, spinningTopLow, spinningTopRange, hadAmbiguity

### Decisiones arquitecturales clave
- **scripts/ vs src/**: src = producción, scripts = operadores/CLI (convención de proyectos grandes)
- **MessageBroker in-memory**: single-process, no cluster-safe; se reemplazaría por Redis sin tocar otros módulos
- **warmupCandles**: BacktestRunner carga N candles antes de `from`, ignora señales durante ese período
- **StrategyBase abstract**: métodos `evaluate`, `id`, `requiredTimeframes` son abstractos (TypeScript lo fuerza en compilación)
- **CandleAggregator puro**: función sin IO en `src/strategy/`, reutilizable por cualquier estrategia
