# ADR-0002: Fix de lookahead en la entrada del FillSimulator (+ ENGINE_VERSION)

- **Fecha:** 2026-05-25
- **Estado:** aceptado

## Contexto
El FillSimulator buscaba la entrada desde `contextCandle.openTime` — incluyendo el propio período
de la vela de señal, que aún no había cerrado cuando la señal se generó. Esto permitía rellenar a
precios que existieron *antes* de que la señal existiera: sesgo de anticipación (lookahead) optimista.
Detectado en la auditoría (`docs/audit/code-audit-2026-05-25.md`, hallazgo H1).

## Decisión
- La entrada se busca desde `contextCandle.openTime + tfMs` (cierre de la vela de señal), con un guard
  explícito `c.openTime >= from` en el escaneo. `tfMs` se deriva de `contextCandle.timeframe`.
- Se introduce `ENGINE_VERSION` (`src/backtest/engineVersion.ts`): identifica la versión de la lógica
  de fills/métricas. Forma parte del fingerprint de dedup → cambiar el motor invalida el cache
  automáticamente (no se mezclan resultados de motores distintos). Valor inicial: `2026-05-25.1`.

## Consecuencias
- **Cambia TODOS los resultados históricos.** En la referencia (BTCUSDT Q1-2024): PF 1.06 → 0.55,
  capital final $12.904 → $396. El sesgo convertía estrategias perdedoras en aparentemente rentables.
- Todo backtest anterior al 2026-05-25 queda invalidado.
- Se actualizaron 5 tests que asumían entrada en la vela de señal. 413 tests verdes.
- Regla: al cambiar la lógica de fills/métricas, **bumpear ENGINE_VERSION**.

## Alternativas consideradas
- **No corregir / documentar solo:** inaceptable — un sistema autónomo optimizaría hacia resultados falsos.
- **Corregir en silencio:** rechazado; el cambio re-basa resultados y tests, requiere registro explícito (este ADR).
