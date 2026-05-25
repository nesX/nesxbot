# tsmom-btc: time-series momentum en BTC (diario)

- **Estado:** 🟢 PROMETEDOR (primer edge real y robusto)
- **Tipo:** estrategia de régimen — long si momentum de N días > 0, fuera si no
- **Herramienta:** `scripts/tsmom.ts` (backtest vectorizado de retornos, NO FillSimulator)
- **Rama git:** exp/tsmom-btc
- **Datos:** BTCUSDT diario 2018-2025 · IS 2018-2022 · OOS 2023-2025 · fee 0.04%/lado

## Hipótesis
Respaldo: Liu & Tsyvinski (RFS 2021) — el retorno cripto predice retornos futuros hasta
~8 semanas. Regla: estar long mientras el retorno de los últimos N días sea positivo.

## Por qué backtest vectorizado (no FillSimulator)
TSMOM es de RÉGIMEN (mantener posición mientras hay señal), no de trades discretos con
TP/SL. Se evalúa con la serie: posición(t-1)·retorno(t), con fee por cambio de posición.

## Resultados (long/flat, con fees)
| | Buy&Hold | N=20d | N=30d | N=50d |
|---|---|---|---|---|
| IS Sharpe | 0.44 | 0.99 | 0.80 | 0.89 |
| IS CAGR | 4% | 43% | 31% | 36% |
| IS maxDD | **81%** | 57% | 64% | 57% |
| OOS Sharpe | 1.42 | 1.24 | **1.41** | 1.26 |
| OOS CAGR | 74% | 44% | 56% | 47% |
| OOS maxDD | 32% | 34% | 36% | 31% |
| Exposición | 100% | ~51% | ~49% | ~48% |

## Observaciones
- En el período bear-heavy (IS) **supera ampliamente** al buy&hold y corta el drawdown
  (81%→57%) estando fuera la mitad del tiempo.
- En el bull (OOS) el buy&hold gana en retorno bruto (estar fuera cuesta en un alcista),
  pero el Sharpe de TSMOM es comparable con la mitad de exposición.
- **Robusto** a través de 2 regímenes opuestos y N=20-50d → no es sobreajuste de un parámetro.
- **A prueba de fees**: pocos trades; comisiones incluidas y sigue fuerte. Valida el pivote.

## Conclusión parcial
Primer candidato con edge real, robusto y que sobrevive comisiones. No "vence" al buy&hold
en retorno bruto en bull, pero da mejor retorno ajustado a riesgo en el ciclo completo y
protección en crashes — propiedad legítima y desplegable.

## Siguientes pasos
1. **Gestión de volatilidad** (escalar posición por vol inversa) — la literatura dice que
   mitiga los "momentum crashes" y suele subir el Sharpe.
2. **Long/short** vs long/flat (¿agrega valor el corto en bear, neto de funding?).
3. **Robustez en otro activo líquido** (ETH) — ¿se sostiene el edge?
4. Métricas adicionales (Calmar, Sortino) y validación walk-forward.
