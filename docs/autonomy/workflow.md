# Bucle de descubrimiento autónomo de estrategias

Cómo la IA itera estrategias sobre el motor de backtest de NesxTrader, de forma
**segura** (git como red de seguridad) y **honesta** (guardrails anti-overfitting).
Solo backtesting — nada en vivo.

## Idea

El usuario da una indicación/hipótesis. La IA escribe la lógica de la estrategia,
la backtestea, lee las métricas en JSON, decide si mejora, e itera. Cada iteración
queda versionada para poder volver atrás.

```
indicación del usuario
  → IA escribe/edita estrategia (src/strategy/strategies/, implementa StrategyBase)
    → la registra en scripts/lib/strategyFactory.ts
      → backtest in-sample            (npm run rbt → JSON)
        → IA lee métricas, decide
          → si promete: valida out-of-sample (--oos-from/--oos-to)
            → commit de la iteración (npm run exp -- iterate "...")
              → compara contra el histórico (npm run compare-runs)
                → repite
```

## Prerrequisito

Datos históricos en TimescaleDB y las tablas propias creadas una sola vez:

```bash
npm run init-db        # crea backtest_runs / backtest_trades (idempotente)
```

Cobertura confirmada: BTCUSDT 1m (2024→2026) y 1s (276M velas → fills PRECISE_1S).

## Comandos

### Correr un backtest — `npm run rbt`

Emite **un objeto JSON** con métricas y advertencias de cordura. Para salida
JSON pura (sin el banner de npm), invocar el script directamente:

```bash
# Vía npm (legible; el JSON es la última línea):
npm run rbt -- --strategy spinning-top-fib --symbol BTCUSDT --from 2024-01-01 --to 2024-06-30 --pretty

# Directo (JSON puro en stdout — usar esto desde el bucle):
npx tsx scripts/run-backtest.ts --strategy spinning-top-fib --from 2024-01-01 --to 2024-06-30
```

Flags principales:

| Flag | Descripción |
|------|-------------|
| `--strategy <tipo>` | tipo registrado en `strategyFactory` (requerido) |
| `--symbol` | default BTCUSDT |
| `--from` / `--to` | rango in-sample (YYYY-MM-DD) |
| `--oos-from` / `--oos-to` | rango out-of-sample (valida overfitting) |
| `--params '<json>'` | params de la estrategia, se mergean sobre los defaults |
| `--capital` / `--risk` / `--warmup` | default 10000 / 1 / 120 |
| `--min-trades` | umbral de cordura (default 30) |
| `--no-persist` | no guardar en backtest_runs |
| `--pretty` | JSON indentado |

Forma de la salida:

```jsonc
{
  "ok": true,                          // false si hay advertencias
  "strategy": { "type", "id", "params" },
  "symbol": "BTCUSDT",
  "inSample":  { "from","to","runId","totalTrades","winRate","profitFactor",
                 "expectancy","maxDrawdown","sharpeRatio","sortinoRatio",
                 "finalCapital","tpBreakdown","resolutionConfidence","pessimisticPenalties" },
  "outOfSample": { ... } | null,
  "warnings": [ ... ]
}
```

### Comparar iteraciones — `npm run compare-runs`

Leaderboard de las corridas persistidas (las que NO usan `--no-persist`).

```bash
npm run compare-runs -- --strategy spinning-top-fib --sort profit_factor --limit 10
npm run compare-runs -- --symbol BTCUSDT --min-trades 30 --json
```

### Versionar cada iteración — `npm run exp`

Red de seguridad git. Commit solo si pasan typecheck + tests.

```bash
npm run exp -- new mi-hipotesis        # crea y cambia a exp/mi-hipotesis
# ... la IA edita la estrategia ...
npm run exp -- iterate "subí maxBodyPercent a 40 y estreché zona1"
npm run exp -- log                     # historial de iteraciones
```

Rollback (git directo):

```bash
git log --oneline                      # ver iteraciones
git reset --hard <sha>                 # volver a una iteración previa
git checkout <sha> -- <archivo>        # recuperar un archivo roto/borrado
```

## Registrar una estrategia nueva

Cuando la IA crea `src/strategy/strategies/MiEstrategia.ts` (implementando
`StrategyBase`), la registra con una línea en `scripts/lib/strategyFactory.ts`:

```ts
'mi-estrategia': {
  defaults: { /* params por defecto */ },
  build: (p) => new MiEstrategia(p as never),
},
```

A partir de ahí es invocable con `--strategy mi-estrategia`.

## Disciplina anti-overfitting (innegociable)

Un bucle autónomo sobreajusta feliz si no se le restringe. Reglas:

1. **Siempre validar out-of-sample** antes de dar por buena una estrategia
   (`--oos-from/--oos-to` sobre un rango que NO se usó para ajustar). Si es
   rentable in-sample pero no fuera de muestra → la CLI lo marca como overfitting.
2. **Mínimo de operaciones.** Menos de `--min-trades` (default 30) → métricas poco
   fiables; la CLI lo advierte y `ok=false`.
3. **Confianza de los fills.** Si `resolutionConfidence.PESSIMISTIC` es alto, los
   fills son conservadores/poco fiables → la CLI lo advierte. Lo ideal es 100%
   `PRECISE_1S` (hay datos de 1s).
4. **No optimizar sobre el mismo rango infinitas veces.** Cada barrido sobre el
   mismo periodo erosiona la validez estadística.

## Hacia dónde puede crecer (diferido — se consulta antes)

- **Python sidecar** para búsqueda inteligente (Optuna/genéticos) cuando el barrido
  exhaustivo sea el cuello. Se comunica por el contrato JSON de `run-backtest.ts`.
- **Engine en Rust** (napi-rs o child-process) si el profiling muestra que estamos
  compute-bound. Exige tests de paridad contra el `FillSimulator` TS (implementación
  de referencia): mismo input → fills idénticos.
