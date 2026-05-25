# ADR-0004: Modelar comisiones (fees) en el PnL del backtest

- **Fecha:** 2026-05-25
- **Estado:** aceptado

## Contexto
El FillSimulator modelaba slippage pero NO comisiones. Para edges marginales (la mayoría
en 1m), ignorar fees produce resultados optimistas falsos — el mismo error de fondo que el
lookahead H1. Crítico para un sistema autónomo que decide qué promover.

## Decisión
Comisión taker configurable por lado (% del notional). Default 0.04% (futuros). Round-trip
(entrada full + salidas que suman 1 notional) se resta del PnL:

```
fee%_capital = 2 · feeTaker% · (riskPercent/100) · (entryPrice / slDistance)
```

El término `entry/slDistance` captura el apalancamiento implícito: stops ajustados ⇒ notional
grande ⇒ fee grande. `takerFeePercent` se pasa por `runBacktest` (default 0.04); el FillSimulator
default es 0 (los unit tests no pasan fee → su PnL no cambia).

## Consecuencias
- **Hallazgo:** estrategias de alta frecuencia con stops ajustados quedan inviables. spinning-top
  Q1-2024: PF 0.55 → **0.13**, capital final $0.19. El fee domina con 1000+ trades y stops ~0.1%.
- Reorienta la búsqueda hacia **pocos trades con movimientos grandes** (TF mayor, targets amplios),
  donde el fee es fracción pequeña del movimiento.
- ENGINE_VERSION → 2026-05-25.2.
- Pendiente: si se quiere variar el fee por corrida, incluirlo en el fingerprint (hoy es fijo 0.04,
  capturado por la versión de motor).

## Alternativas consideradas
- **Fee plano en R por trade:** no captura el efecto del apalancamiento (stops ajustados). Rechazado.
- **Seguir sin fees:** repetiría el error H1 de resultados inflados.
