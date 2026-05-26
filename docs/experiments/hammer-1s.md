# hammer-1s: martillos de volumen anormal en velas de 1 segundo (BTC)

- **Estado:** 🔎 cataloging (fase 1: encontrar y guardar eventos; patrones después)
- **Herramienta:** `scripts/hammer-scan.ts` → CSV en `results/hammer-scan/`
- **Rama git:** exp/hammer-1s

## Hipótesis (del usuario)
En velas de 1s hay martillos con volumen anormal con comportamientos distintos:
martillos seguidos, invertidos seguidos, o aislados (1 con volumen alto rodeado de
velas de volumen normal / precedido por velas de bajo volumen). Primero catalogar
los timestamps exactos; luego estudiar qué pasa alrededor (patrones).

## Detección
- **Martillo**: mecha inferior >= `wickFrac`×rango, mecha superior <= `maxOpp`×rango.
- **Invertido**: espejo (mecha superior dominante).
- **Volumen anormal**: volumen >= `volMult` × promedio de las `volWindow` velas previas
  (captura "alto vs las anteriores de bajo volumen").
- **Contexto**: `consecutivo` (otro evento del mismo tipo en ±`consecSec`) vs `aislado`.
- Filtro `minRangeBps` para descartar velas planas.

## Calibración (enero 2025, BTCUSDT)
- 2.68M velas 1s · criterio vol≥5×prom(60), mecha≥0.6, opp≤0.15, rango≥2bps.
- **1322 eventos** (715 martillos, 607 invertidos) · 1256 aislados, 66 consecutivos.
- Los extremos llegan a vol×499 (barridos / órdenes grandes en 1 segundo).
- Salida: CSV con timestamp exacto, tipo, contexto, volRatio, geometría, close.

## Siguientes pasos
1. Escaneo completo del rango elegido → catálogo CSV completo.
2. (Fase 2) Estudiar qué pasa DESPUÉS de cada evento: retorno forward por tipo/contexto,
   para ver si hay patrón explotable (y luego, costos/ejecución — recordando que es 1s).
