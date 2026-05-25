# marubozu-1h: continuación alcista de marubozu en timeframe mayor (BTCUSDT)

- **Estado:** descartado (rejected)
- **Estrategia:** marubozu-long con `candleInterval: 60` (`MarubozuLongStrategy`)
- **Rama git:** exp/marubozu-1h
- **Creado:** 2026-05-25
- **Datos:** BTCUSDT · señal 1h (agrega 1m→60m) · ejecución 1m/1s · IS 2024 · OOS 2025
- **Motor:** ENGINE_VERSION 2026-05-25.2 (lookahead-fix + alineación reloj + comisiones 0.04%)

> Corridas: `npm run compare-runs -- --experiment marubozu-1h`

## Hipótesis
El edge del marubozu mejora en timeframe mayor. Reconocimiento 2024: marubozu alcista
1h = **55.6%** a 1:1 (vs 52.5% en 1m), 365/año, 6.8% sin resolver. Hipótesis: en 1h, con
movimientos más grandes, el edge supera las comisiones.

## Motor preparado para esta prueba (cambios a main)
- **H2 / ADR-0003:** CandleAggregator alineado al reloj → las velas 1h del backtest coinciden
  con el recon (1h nativo). Verificado: WR del backtest (54.5%) ≈ recon (55.6%).
- **ADR-0004:** comisiones modeladas (0.04%/lado). Crítico para edges marginales.

## Resultados (con fees)
| variante | IS PF | IS final | OOS PF | OOS final |
|----------|-------|----------|--------|-----------|
| RR1 100% | 0.92 | $8202 | 0.66 | $4159 |
| RR1.5 100% | 0.99 | $9328 | 0.68 | $3783 |
| RR2 50%+BE+tp2@3 | 0.95 | $8652 | 0.69 | $4447 |

## Conclusión — DESCARTADO
El edge bruto de 55.6% **no sobrevive las comisiones**: pierde incluso in-sample (PF < 1) y
peor out-of-sample. El costo (~0.16R/trade con estos stops) supera el +0.11R de ventaja bruta.
El TF mayor mejora el edge bruto pero no lo suficiente para cubrir fees.

## Meta-aprendizaje (cruzando marubozu-long, marubozu-1h, mean-reversion)
- Patrones de **vela única** en BTC (continuación o reversión) tienen, a lo sumo, un edge
  bruto delgado (~52-56%) que **el costo de transacción aniquila**.
- Las comisiones son el factor dominante para estrategias de muchos trades / stops ajustados.
- Para algo viable se necesita: edge bruto mucho mayor, o **movimientos grandes** (swing,
  hold de días, targets multi-%) donde el fee sea fracción mínima, o una señal de otra naturaleza.

## Siguientes pasos
1. **Baja frecuencia / movimientos grandes:** swing en daily/4h con targets de varios %,
   donde 0.08% de fee es ruido. Reconocimiento primero.
2. **Trend-following / breakouts** de rango amplio (no reversión ni vela única).
