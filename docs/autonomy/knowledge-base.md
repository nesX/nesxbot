# Sistema de conocimiento persistente

Diseño del almacenamiento que registra **qué se probó, qué resultó y qué concluimos**, de
forma que sobreviva a resets de contexto de la IA, se pueda consultar a lo largo de semanas/
meses, evite re-correr backtests ya hechos, y permita encontrar patrones.

> Estado: **✅ IMPLEMENTADO (2026-05-25)**. Schema v2 aplicado, dedup por fingerprint operativo,
> capa narrativa de experimentos creada. Ver "Estado de la implementación" al final.

---

## Decisión: híbrido, DB-primario (NO una herramienta nueva)

| Capa | Medio | Para qué |
|------|-------|----------|
| **Estructurada** | PostgreSQL/TimescaleDB (ya corriendo) | Cada corrida con sus params y métricas. Consultas, dedup, búsqueda de patrones vía SQL. |
| **Narrativa** | Markdown en git (`docs/experiments/`) | Hipótesis, observaciones, conclusiones, decisiones. Lo que la IA relee para recuperar contexto. |

### Por qué no solo archivos
Markdown/CSV son ilegibles a escala: con cientos de corridas no puedes consultar "qué
`maxBodyPercent` dio mejor profit factor", ni deduplicar, ni agregar. No hay índices.

### Por qué no solo DB
La DB es mala para el razonamiento cualitativo (hipótesis, por qué algo se descartó) y para que
la IA recupere el hilo al reiniciar contexto. Un `verdict='rejected'` no explica el *porqué*.

### Por qué no una herramienta dedicada (MLflow / W&B / dashboards de Optuna)
- Agregan un servicio extra y dependencias que mantener, para un proyecto de una persona.
- Optuna es para *optimizar*, no para almacenar conocimiento; MLflow/W&B son para tracking de
  experimentos ML con overhead de setup.
- **Ya tenemos Postgres** y media solución (`backtest_runs`). El híbrido cubre todo hoy.
- Revisitar **solo si**: necesitas visualización rica multi-usuario, o el volumen supera lo que
  SQL ad-hoc maneja cómodo. La capa DB ya deja los datos listos para exportar a esas herramientas.

---

## Capa estructurada — extensiones al esquema

Hoy `backtest_runs` guarda métricas pero **no los params** (solo el `strategy_id`, que apenas
codifica el intervalo). Sin params no hay búsqueda de patrones. Cambios propuestos (`schema v2`):

```sql
ALTER TABLE backtest_runs
  ADD COLUMN params         JSONB,          -- params resueltos de la estrategia (consultable)
  ADD COLUMN strategy_type  TEXT,           -- tipo estable (spinning-top-fib), separado del id dinámico
  ADD COLUMN engine_version TEXT,           -- versión del motor; invalida cache si cambia la lógica de fills
  ADD COLUMN window         TEXT,           -- 'in_sample' | 'out_of_sample'
  ADD COLUMN experiment     TEXT,           -- agrupa corridas bajo una hipótesis
  ADD COLUMN fingerprint    TEXT,           -- hash de dedup (ver abajo)
  ADD COLUMN verdict        TEXT,           -- 'promising' | 'rejected' | 'baseline' | null
  ADD COLUMN tags           TEXT[],
  ADD COLUMN notes          TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_backtest_runs_fingerprint ON backtest_runs (fingerprint);
CREATE INDEX IF NOT EXISTS idx_backtest_runs_experiment   ON backtest_runs (experiment);
CREATE INDEX IF NOT EXISTS idx_backtest_runs_params_gin   ON backtest_runs USING gin (params);
```

### Dedup — "no re-correr lo ya corrido"

```
fingerprint = sha1( strategy_type + params(JSON ordenado) + symbol + from + to + engine_version )
```

`run-backtest` calcula el fingerprint **antes** de correr:
- Si existe en `backtest_runs` con el mismo `engine_version` → devuelve el resultado cacheado
  con `"cached": true` y NO re-ejecuta.
- Si no existe → corre, persiste con su fingerprint.

Esto ahorra semanas de recómputo en un proceso largo. El `engine_version` es clave: se bumpea
cuando cambia la lógica de fills/métricas (p.ej. al arreglar H1 del audit), invalidando
automáticamente los resultados viejos para no mezclar manzanas con peras.

### Búsqueda de patrones (ejemplos SQL)

```sql
-- Mejor profit factor por valor de maxBodyPercent (in-sample, con muestra suficiente)
SELECT params->>'maxBodyPercent' AS max_body,
       round(avg(profit_factor),3) AS pf_medio, count(*) n
FROM backtest_runs
WHERE strategy_type='spinning-top-fib' AND window='in_sample' AND total_trades>=50
GROUP BY 1 ORDER BY pf_medio DESC;

-- Robustez: corridas rentables IS y también OOS (no overfitting)
SELECT is_.experiment, is_.profit_factor pf_is, oos.profit_factor pf_oos
FROM backtest_runs is_
JOIN backtest_runs oos USING (experiment)
WHERE is_.window='in_sample' AND oos.window='out_of_sample'
  AND is_.profit_factor>1 AND oos.profit_factor>1;
```

Más adelante, si hace falta análisis pesado, un **sidecar Python** (pandas/seaborn) lee esta
tabla — sin tocar el núcleo de corrección.

---

## Capa narrativa — experimentos en git

Un archivo por experimento en `docs/experiments/`, más un índice. Es lo primero que la IA lee
al recuperar contexto.

```
docs/experiments/
├── README.md                       # índice: id, hipótesis en una línea, estado, fecha
└── 2026-05-25-spinning-body-width.md
```

Plantilla (`docs/experiments/_template.md`):

```markdown
# EXP-<id>: <título corto>

- Estado: explorando | prometedor | descartado | baseline
- Estrategia: spinning-top-fib
- Rama git: exp/<nombre>
- Fechas de datos: IS 2024-01→06 · OOS 2024-07→12 · símbolo BTCUSDT

## Hipótesis
Qué creemos y por qué.

## Qué se probó
Variaciones de params, rangos. (Cada corrida queda en backtest_runs con su experiment=<id>.)

## Resultados clave
| runId / fingerprint | params destacados | trades | PF | OOS PF | veredicto |
|---|---|---|---|---|---|

## Observaciones
Qué se vio (incluye advertencias de la CLI: overfitting, % PESSIMISTIC, pocos trades).

## Conclusión
Qué aprendimos. Por qué se promueve o descarta.

## Siguientes pasos
```

El vínculo entre capas: el campo `experiment` en `backtest_runs` == el `<id>` del archivo
markdown. Desde una corrida llegas a su narrativa y viceversa.

---

## Cómo sobrevive a un reset de contexto de la IA

Al iniciar una sesión nueva, la IA recupera el estado en 2 pasos:
1. Lee `docs/experiments/README.md` (índice) + los experimentos recientes/activos → contexto
   cualitativo (qué se intentó, qué se concluyó, qué sigue).
2. Consulta el leaderboard / DB (`npm run compare-runs`, SQL) → qué corridas existen, sus
   métricas y params. El fingerprint evita repetir.

Nada vive solo en la memoria de la IA ni en el chat: DB (externa, persistente) + git (versionado).

---

## Estado de la implementación (2026-05-25)

Todo hecho y verificado, sin tocar el motor de corrección:

1. ✅ `db/schema.sql` → columnas v2 (`params`, `strategy_type`, `engine_version`, `sample_window`,
   `experiment`, `fingerprint` UNIQUE, `verdict`, `tags`, `notes`) + índices (gin sobre params,
   único sobre fingerprint). Idempotente vía `npm run init-db`. Nota: la columna es `sample_window`,
   no `window` (palabra reservada en Postgres).
2. ✅ `src/backtest/engineVersion.ts` → `ENGINE_VERSION = '2026-05-25.1'` (post-fix H1). Bump al
   cambiar lógica de fills/métricas.
3. ✅ `scripts/lib/fingerprint.ts` → `computeFingerprint()` = sha1(engineVersion+type+params+symbol+from+to),
   con `stableStringify` (claves ordenadas → determinista).
4. ✅ `scripts/run-backtest.ts` → por ventana (IS/OOS): calcula huella, **cortocircuita si ya existe**
   (`cached:true`, no re-ejecuta), o corre + persiste con toda la metadata. Flags `--experiment`,
   `--force`, `--no-persist`. Verificado: 2da corrida idéntica en 0.5s vs 2.6s.
5. ✅ `scripts/compare-runs.ts` → filtros `--experiment`, `--verdict`, `--window`; columnas Exp y W.
6. ✅ `docs/experiments/_template.md` + `README.md`; `npm run exp -- new <id>` genera la bitácora
   y la rama, y recuerda el `--experiment <id>` a usar.

Nota sobre trades: el KB persiste a nivel-corrida (run-level) en `nesx.backtest_runs`. La tabla
`nesx.backtest_trades` queda para validación profunda puntual (no se llena en cada corrida del bucle,
para no inflarla con miles de filas a lo largo de meses).
