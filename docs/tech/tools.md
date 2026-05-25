# Registro de herramientas

Herramientas (CLIs, librerías, analizadores) agregadas al código. Al crear una nueva,
agregar una fila. Formato: qué hace · dónde · cuándo.

## CLIs (npm scripts)

| Comando | Qué hace | Archivo | Agregado |
|---------|----------|---------|----------|
| `npm run init-db` | Aplica `db/schema.sql` (crea tablas del bot en esquema `nesx`). Idempotente. | `scripts/init-db.ts` | 2026-05-25 |
| `npm run rbt` | Backtest con salida JSON + dedup por fingerprint + persistencia con metadata (IS/OOS). Contrato de job de la IA. | `scripts/run-backtest.ts` | 2026-05-25 |
| `npm run compare-runs` | Leaderboard de corridas persistidas, con filtros `--experiment/--verdict/--window`. | `scripts/compare-runs.ts` | 2026-05-25 |
| `npm run exp` | Red de seguridad git: rama `exp/<id>` + bitácora, commit por iteración (gated typecheck+tests). | `scripts/experiment.ts` | 2026-05-25 |
| `npm run typecheck:all` | Typecheck de `src` + `scripts` (antes solo `src`). | `tsconfig.scripts.json` | 2026-05-25 |
| `npm run stats` | Motor de estadísticas de mercado (reconocimiento de patrones). | `scripts/stats.ts` | (previo) |

## Librerías / helpers

| Nombre | Qué hace | Archivo | Agregado |
|--------|----------|---------|----------|
| `strategyFactory` | Registro tipo→constructor de estrategias. Punto donde se registra una estrategia nueva. | `scripts/lib/strategyFactory.ts` | 2026-05-25 |
| `fingerprint` | Huella sha1 determinista de una corrida (dedup: no re-correr lo ya hecho). | `scripts/lib/fingerprint.ts` | 2026-05-25 |
| `ENGINE_VERSION` | Versión del motor de fills/métricas. Se bumpea al cambiar la lógica; invalida el cache de dedup. | `src/backtest/engineVersion.ts` | 2026-05-25 |
| `InMemoryCandleRepository` | Cache en memoria de velas 1m para grid search. | `scripts/lib/InMemoryCandleRepository.ts` | (previo) |

## Analizadores de stats (`scripts/stats/analyzers/`)

| Analyzer | Qué mide | Hallazgo / uso | Agregado |
|----------|----------|----------------|----------|
| `volume-followthrough` | Continuación tras spike de volumen. | 2024 BTC 1m: sin edge direccional. | (previo) |
| `consecutive-streaks` | Frecuencia de rachas alcistas/bajistas (no retornos futuros). | — | (previo) |
| `marubozu-continuation` | Continuación 1:1 tras vela marubozu. | 2024 BTC 1m: ~52.5% (edge delgado). | (previo) |
| `wickless-range-dist` | Distribución de rango en velas sin mecha. | — | (previo) |
| `rsi-zone-dist` | Distribución de zonas de RSI. | — | (previo) |
| `oversold-bounce` | Reversión a la media LONG: rebote TP/SL tras RSI en sobreventa (con filtro de tendencia opcional). | 2024 BTC 1m: **sin edge** — pierde a 1:1 (cuchillo cayendo), moneda al aire incluso en uptrend. | 2026-05-25 |
| `ema-bounce` | Rebote LONG al tocar EMA (fast/slow) en tendencia, por número de toque, con filtro de separación y tendencia fuerte. | 2024 BTC 5m/1m: **sin edge** — ~50% a 1:1 en EMA200 y EMA365; toque profundo y trend fuerte no mejoran (muestra colapsa). | 2026-05-25 |
