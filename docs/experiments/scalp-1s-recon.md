# scalp-1s-recon: ¿hay edge de scalping en velas 1s? (BTCUSDT)

- **Estado:** ✅ recon concluido — no viable para taker con OHLCV; retomar con order book
- **Datos:** BTCUSDT velas 1s · ventanas 2025-03 y 2024-06 (semanas)
- **Herramienta:** `scripts/scalp-recon.ts` (autocorrelación + variance-ratio vs costo)

## Pregunta
Antes de construir cualquier estrategia de scalping: ¿existe estructura explotable a
horizonte de segundos en BTC, neta de un costo realista (fee taker ~8bp + spread ~1bp ≈ 9bp)?

## Resultados (2 ventanas independientes, consistentes)
| | 2025-03 | 2024-06 |
|--|---------|---------|
| std retorno 1s | 1.35 bps | 0.47 bps |
| ACF(1s) | +0.113 | +0.120 |
| ACF(2s) | +0.015 | +0.071 |
| VR(2s) / VR(60s) | 1.11 / 1.36 | 1.12 / 1.70 |
| edge ≈ \|ACF(1)\|·std | 0.15 bps | 0.06 bps |

## Conclusión
**Hay estructura real, no ruido puro:** autocorrelación positiva consistente a 1s (~0.11-0.12)
y variance-ratio >1 creciente → BTC a 1s tiene leve **persistencia/momentum** (lo contrario del
rebote bid-ask). El efecto es estable entre períodos.

**Pero es INCAPTURABLE por un taker:** el movimiento típico de 1s (0.5-1.4 bps) y el edge
predecible (0.06-0.15 bps) son ~60-150× menores que el costo round-trip (9 bps). Cobrar spread
+ fee entierra cualquier señal de esta magnitud.

## Implicación (handoff al feature de order book)
El scalping NO es viable con velas OHLCV + ejecución taker — confirmado con datos, no intuición.
La única vía es: (1) **ser maker** (cobrar el spread en vez de pagarlo) y/o (2) señales de
**microestructura** (OFI / order book imbalance / trade flow) que anticipen movimientos mayores
que el costo. Justo lo que habilita el feature de order book en desarrollo.

**Cuando el colector de order book esté listo**, retomamos: `OrderBookRepository` read-only +
analizadores de OFI/OBI + modelo de ejecución maker/taker realista (con spread y cola). La
persistencia positiva a 1s que medimos sugiere que SÍ hay algo que un maker podría capturar.
