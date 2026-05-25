# marubozu-long: continuación alcista tras vela marubozu (BTCUSDT 1m)

- **Estado:** descartado (rejected)
- **Estrategia:** marubozu-long (`src/strategy/strategies/MarubozuLongStrategy.ts`)
- **Rama git:** exp/marubozu-long
- **Creado:** 2026-05-25
- **Datos:** BTCUSDT 1m · IS 2024 · OOS 2025 (2026 = holdout sin tocar)
- **Motor:** ENGINE_VERSION 2026-05-25.1 (post-fix lookahead H1)

> Corridas en `nesx.backtest_runs` con `experiment = 'marubozu-long'`.
> Consulta: `npm run compare-runs -- --experiment marubozu-long`

## Hipótesis
Una vela alcista fuerte ("marubozu": rango grande, mechas pequeñas) en BTC 1m
tiene continuación alcista explotable. Reconocimiento sobre 2024 con el stats
engine midió ~52.5% de aciertos a 1:1 (43.7% TP / 39.5% SL entre resueltos).

## Reconocimiento previo (stats, solo 2024)
- **Spike de volumen** (3× SMA20): sin edge direccional (+10 velas 37% sube / 35% baja, retorno ~0). Descartado.
- **Marubozu alcista** (1:1): ~52.5% win → único sesgo positivo medible, pero delgado.
- **Filtro MACD>0**: no mejora (52.4%), reduce triggers a la mitad. Descartado.

## Qué se probó (IS 2024)
| params | trades | WR | PF | final |
|--------|--------|----|----|-------|
| baseline 1:1, 100% | 1349 | 51.5% | 1.01 | $10026 |
| tp1RR 1.5 | 1349 | 41.6% | 1.02 | $10967 |
| tp1RR 2 | 1349 | 34.8% | 1.02 | $10901 |
| parcial50 + BE + tp2@2 | 1349 | 51.5% | 1.02 | $10326 |
| **señal estricta** (mecha≤8%, rango≥0.4%) | 294 | 53.7% | 1.12 | $11548 |
| **estricta + tp1RR 1.5** | 294 | 44.9% | **1.18** | **$13138** |
| estricta + tp1RR 2 | 294 | 37.4% | 1.16 | $13034 |
| muy estricta (w6, r0.5) | 96 | 51.0% | 1.01 | $9990 |

Mejor candidato IS: **señal estricta + tp1RR 1.5** → PF 1.18, +31% en 2024.

## Validación OOS 2025 (la prueba real)
| candidato | IS PF | OOS PF | OOS final |
|-----------|-------|--------|-----------|
| estricta + tp1RR 1.5 | 1.18 | **0.81** | $8129 |
| estricta + tp1RR 2 | 1.16 | **0.81** | $7954 |

Ambos rentables in-sample colapsan out-of-sample (PF < 1, pérdida ~19-20%).
La CLI marcó `overfitting` automáticamente en los dos.

## Conclusión — DESCARTADO
El edge del marubozu alcista **no generaliza**: era ruido in-sample / específico
del régimen alcista de 2024. A 1:1 el baseline ya es breakeven (edge ~52.5%
idealizado, que el slippage se come), y el "filtrado de calidad" que mejoró 2024
fue sobreajuste. **No promover a más pruebas ni a live.**

Lo valioso: quedó registrado y deduplicado (fingerprints) — no re-correremos esto.
Aprendizaje: patrones de *continuación* de vela única en BTC 1m son ~eficientes.

## Siguientes pasos (hipótesis que abrió)
1. **Reversión a la media** (no continuación): medir el rebote LONG tras
   caídas/sobreventa. Requiere extender el stats engine (el analizador de rachas
   hoy no da retornos futuros). La reversión suele tener más edge intradía.
2. **Timeframe mayor** (15m/1h): los patrones de continuación podrían ser menos
   ruidosos que en 1m.
3. **Confluencia real** (no MACD): niveles/contexto estructural, no solo la vela.
