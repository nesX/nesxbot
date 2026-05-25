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
| [marubozu-1h](marubozu-1h.md) | ❌ descartado | Marubozu en 1h (edge bruto 55.6%, no sobrevive fees) | 2026-05-25 |
| marubozu-long (rama exp/) | ❌ descartado | Continuación marubozu 1m — overfitting + fees | 2026-05-25 |
| mean-reversion (recon) | ❌ descartado | Rebote LONG tras sobreventa RSI — sin edge en 1m/1h | 2026-05-25 |
