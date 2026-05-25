# ema-bounce (recon): rebote del precio al tocar la EMA en tendencia

- **Estado:** descartado en reconocimiento (no se construyó estrategia)
- **Datos:** BTCUSDT 5m y 1m · 2024 (in-sample)
- **Herramienta:** analizador `ema-bounce` (`scripts/stats/analyzers/EmaBounce.ts`)

## Hipótesis (del usuario)
Con el precio sobre EMA200 y EMA365, cuando retrocede y toca esas medias tiende a
rebotar (puede perforar un poco). Variables a explorar: número de toque (el 1º sería
el más fiable), % de rebote objetivo, y filtro de separación (un toque sin que el
precio se haya alejado pierde validez).

## Qué se midió
Toque de EMA200/EMA365 en uptrend (EMA200>EMA365), entrada límite en el nivel de la
EMA, TP/SL en %, resuelto forward. Desglose por número de toque + filtro de separación
+ filtro de tendencia fuerte (EMAs separadas).

## Resultados (5m 2024, gross/pre-fee)
| variante | win rate | expectativa bruta |
|----------|----------|-------------------|
| EMA200 toque, 1:1 | 49.9% | ~0% |
| EMA200 toque, varios RR | 17–62% | mejor caso ≈ +0.009% (cero) |
| EMA365 toque profundo, 1:1 | 50.3% | ~0% |
| EMA200/365 + tendencia fuerte (sep≥1%) | 37–49% | sin mejora; muestra 4–39 (inútil) |

Desglose por número de toque: ruidoso, sin la decadencia esperada (el 1er toque no domina).

## Conclusión — DESCARTADO
El toque de EMA en tendencia rebota ~tan seguido como la rompe (≈50/50). Ninguna estructura
de RR ni filtro produce expectativa bruta positiva — y esto es antes de comisiones. El edge
percibido es sesgo de confirmación (recordamos rebotes, olvidamos roturas). No se construye estrategia.

Consistente con el meta-aprendizaje: setups de precio simples en BTC intradía son ~eficientes;
el costo de transacción no deja margen.
