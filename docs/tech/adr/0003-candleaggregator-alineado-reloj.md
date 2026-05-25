# ADR-0003: CandleAggregator alineado al reloj

- **Fecha:** 2026-05-25
- **Estado:** aceptado

## Contexto
`aggregateCandles` agrupaba velas 1m por índice desde el inicio del array, no por
límite de reloj. Las velas N-minuto resultantes (5m, 15m, 1h...) no coincidían con las
del exchange/TradingView si el array no empezaba en un múltiplo de N. Hallazgo H2 del audit.
Bloqueaba construir estrategias fieles en timeframe mayor (el recon usa 1h nativo; la
estrategia agregaría 1m→1h desfasado → resultados distintos al recon).

## Decisión
Agrupar por bucket de reloj: `floor(openTime / (N·60000)) · (N·60000)`. El `openTime`
de la vela agregada es el inicio del bucket. Solo se emiten buckets COMPLETOS (N velas);
el bucket en progreso y los buckets con huecos se descartan, así cada vela devuelta es un
período cerrado en el que se puede confiar.

## Consecuencias
- Las velas agregadas coinciden con el exchange (15m → :00/:15/:30/:45).
- Cambia los resultados de toda estrategia con `candleInterval > 1`. ENGINE_VERSION → 2026-05-25.2.
- Se agregó suite de tests (`CandleAggregator.unit.test.ts`, 6 casos) — antes no tenía.
- BTC 1m no tiene huecos en 2024-2025, así que el filtro de "buckets completos" solo
  descarta el bucket en progreso.

## Alternativas consideradas
- **Emitir buckets parciales:** introduciría velas incompletas (con menos de N minutos) que no
  coinciden con el exchange. Rechazado.
- **No corregir:** impide estrategias fieles en TF mayor, justo la dirección que tomamos.
