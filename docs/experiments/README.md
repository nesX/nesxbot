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
| [hammer-1s](hammer-1s.md) | 🔎 catálogo (fase 1) | Martillos de volumen anormal en 1s — 29.895 eventos ≥5× catalogados (2024-2026) | 2026-05-25 |
| [ema-bounce](ema-bounce.md) | ❌ descartado (recon) | Rebote al tocar EMA200/365 en tendencia — ~50/50, sin edge | 2026-05-25 |
