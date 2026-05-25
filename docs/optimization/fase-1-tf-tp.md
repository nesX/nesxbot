# Fase 1 — Timeframe + TP

**Estado:** ❌ Re-run necesario (resultados inválidos)
**Fecha run original:** 2026-03-29
**Período de prueba:** 2025-01-01 → 2025-03-31 (Q1 2025)

> **IMPORTANTE:** Los resultados de este run son inválidos. Se corrigieron dos bugs
> críticos después de ejecutar esta fase:
> 1. **Bug zona proyección** — UP usaba `high` como ancla en lugar de `low`;
>    DOWN usaba `low` en lugar de `high`. Las zonas estaban en niveles incorrectos.
> 2. **Bug FillSimulator** — el simulador asumía entry en la primera vela de 1s del
>    trigger sin verificar si el precio realmente tocó la zona de entrada, generando
>    fills falsos (TPs que en realidad no se tocaron).
>
> Hay que re-ejecutar el grid con el código corregido antes de usar estos resultados.

---

## Hipótesis

El timeframe de detección del trompo y la relación riesgo/recompensa del TP1 son
los parámetros con mayor impacto en el resultado. Se exploran de forma conjunta
porque interactúan directamente.

---

## Configuración del grid (Run #1)

```typescript
candleInterval:    [1, 2, 3, 4, 5, 6]
tp1RR:             [1.5, 2.0, 2.5, 3.0]
z1min:             [1.85, 1.9, 1.95]
z1max:             [2.06, 2.1, 2.15]
tp1SizePercent:    [100]
moveSlToBreakeven: [false]
// zone2: habilitada con z2=[2.618, 3.06] (fija)
```

**Total combinaciones:** 216
**Workers:** 4
**Tiempo:** ~15 min (antes de optimizaciones de cache)

---

## Top 10 resultados (por ProfitFactor)

| TF | tp1RR | z1min | z1max | Trades | WR% | PF | MaxDD% | Capital |
|----|-------|-------|-------|--------|-----|----|--------|---------|
| 1m | 1.5 | 1.90 | 2.06 | 52 | 66.3 | 3.57 | 3.0 | $29,858 |
| 1m | 1.5 | 1.95 | 2.06 | 42 | 69.0 | 3.52 | 2.8 | $26,580 |
| 2m | 1.5 | 1.90 | 2.06 | 88 | 65.9 | 3.21 | 4.0 | $52,048 |
| 1m | 2.0 | 1.95 | 2.06 | 42 | 66.7 | 3.16 | 3.0 | $30,402 |
| 2m | 1.5 | 1.95 | 2.06 | 71 | 67.6 | 3.14 | 3.7 | $46,010 |
| 1m | 1.5 | 1.90 | 2.10 | 63 | 63.5 | 3.10 | 4.1 | $39,087 |
| 3m | 1.5 | 1.95 | 2.06 | 104 | 63.5 | 3.08 | 4.3 | $69,204 |
| 1m | 2.0 | 1.90 | 2.06 | 52 | 63.5 | 2.96 | 3.2 | $29,754 |
| 6m | 2.0 | 1.95 | 2.06 | 291 | 64.9 | 2.93 | 5.8 | $1,064,324 |
| 3m | 2.0 | 1.95 | 2.06 | 104 | 62.5 | 2.93 | 4.9 | $111,440 |

---

## Conclusiones

1. **Zona ganadora:** z1=[1.95, 2.06] aparece en 8 de los 10 mejores. z1min=1.90 también aparece en top 10 pero con menor frecuencia.

2. **TF óptimo para PF:** 1m con tp1RR=1.5 domina en ProfitFactor. Mayor precisión al detectar trompos.

3. **TF óptimo para capital:** 6m genera más trades (291 vs 42) y el compounding dispara el capital final, aunque con MaxDD más alto.

4. **tp1RR=1.5 vs 2.0:** a 1:1.5 el WR es más alto porque el TP es más fácil de alcanzar. A 1:2.0 se necesita un movimiento mayor pero sigue siendo rentable.

---

## Parámetros fijados para siguientes fases

| Parámetro | Valor | Razón |
|-----------|-------|-------|
| `tp1SizePercent` | 100% | Cierre total en TP1 — simplicidad y consistencia |
| `moveSlToBreakeven` | false | Sin beneficio con tp1SizePercent=100 |
| `zone2` | null | Resultados superiores sin zona 2 (ver nota en plan-maestro.md) |
| `tp1RR` | 1.5 o 2.0 | Se mantienen ambas en Fase 2 para confirmar |
