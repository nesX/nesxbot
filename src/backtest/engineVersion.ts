/**
 * Versión del motor de backtest (FillSimulator + MetricsCalculator).
 *
 * BUMPEAR esta constante cada vez que cambie la LÓGICA que afecta los resultados:
 * resolución de fills, slippage, cálculo de métricas, manejo de ambigüedad, etc.
 *
 * Sirve para dos cosas:
 *   1. Dedup: el fingerprint de una corrida la incluye → cambiar la versión
 *      invalida automáticamente el cache (no se reutilizan resultados de un motor
 *      distinto). Ver scripts/lib/fingerprint.ts.
 *   2. Trazabilidad: cada corrida en nesx.backtest_runs guarda con qué motor se hizo.
 *
 * Historial:
 *   2026-05-25.1 — fix de lookahead en la entrada (H1): la entrada se busca desde
 *                  el CIERRE de la vela de señal (openTime + tfMs), no desde su apertura.
 *                  Invalida TODO resultado anterior.
 *   2026-05-25.2 — (H2) CandleAggregator alineado al reloj + comisiones taker
 *                  modeladas en el PnL (default 0.04%/lado). Invalida resultados .1.
 */
export const ENGINE_VERSION = '2026-05-25.2';
