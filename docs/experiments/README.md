# Experimentos

Capa narrativa del sistema de conocimiento (ver `docs/autonomy/knowledge-base.md`).
Un archivo por experimento. Es lo primero que la IA lee al recuperar contexto.

- **Estructurado** (métricas, params, dedup) → `nesx.backtest_runs`, vía `npm run compare-runs`.
- **Narrativo** (hipótesis, conclusiones) → los archivos de esta carpeta.
- **Vínculo:** el campo `experiment` en la BD == el `<id>` del archivo aquí.

Crear uno: `npm run exp -- new <id>` (crea la rama `exp/<id>` y el archivo `<id>.md`).

## Índice

| Experimento | Estado | Hipótesis (1 línea) | Fecha |
|-------------|--------|---------------------|-------|
| [marubozu-long](marubozu-long.md) | ❌ descartado | Continuación alcista tras marubozu en BTC 1m | 2026-05-25 |
