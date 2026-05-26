# hammer-1s: martillos de volumen anormal en velas de 1 segundo (BTC)

- **Estado:** 🔎 fase 1+2 hechas — patrón REAL pero diminuto (incapturable taker); retomar c/order book
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

## Volumen anormal = vol ≥ mult × SMA(60) de las velas previas
La referencia es el **promedio del minuto previo** (no la vela anterior, que es ruidosa).
Captura "martillo de alto volumen donde las anteriores son de bajo volumen".

## Catálogo completo (BTCUSDT 1s, 2024-01-01 → 2026-05-22)
- 873 días · **75.4M velas** escaneadas · red amplia vol≥3× (re-filtrable sin re-escanear).
- CSV: `results/hammer-scan/BTCUSDT_1s_hammers_2024-01-01_2026-05-22.csv` (42.435 filas).

Distribución por umbral de volumen (segundo filtro):
| umbral | eventos |
|--------|---------|
| ≥3× | 42.435 |
| **≥5×** | **29.895** (hammer 16.605, inverted 13.290; aislados 27.875, consecutivos 2.020) |
| ≥10× | 17.060 |
| ≥20× | 9.122 |
| ≥50× | 3.610 |
| ≥100× | 1.657 |

Por año (≥5×): 2024 ≈13.5k · 2025 ≈9.9k · 2026 (parcial) ≈6.5k.
Extremos: hasta **vol×8031** (vela 1s con 8000× el volumen del minuto previo — barrido violento).
Set de trabajo ≥5× exportado: `results/hammer-scan/BTCUSDT_ge5.csv`.

## Fase 2 — comportamiento forward (2025, `scripts/hammer-forward.ts`)
Retorno forward (bps) por grupo, ref. costo taker ≈ 9 bps round-trip:
| Grupo | n | +30s | +60s | +5min | +15min |
|-------|---|------|------|-------|--------|
| Absorción hammer | 1689 | +0.3 | +0.5 | +0.5 | **+1.2** /52%↑ |
| Absorción inverted | 1276 | -0.1 | -0.3 | -0.7 | **-1.7** /46%↑ |
| Barrido hammer | 10 | +26 | +31 | +69 | +86 (n=10 ruido) |
| Todos hammer ≥5× | 5525 | +0.3 | +0.6 | +0.2 | +0.8 |
| Todos inverted ≥5× | 4368 | -0.2 | -0.6 | -0.8 | -1.2 |

## Conclusión (fase 2)
- **El patrón es real:** hammer deriva ↑, invertido ↓ — signos OPUESTOS (descarta que sea
  deriva de mercado), monótono en 4 horizontes, muestra grande. Coincide con la lectura clásica.
- **Pero diminuto:** ~1-2 bps a 15min con ~52% de acierto → **~5-9× menor que el costo taker
  (9 bps)**. NO operable como taker; marginal como maker.
- **Barrido demasiado raro** (10-18 eventos/año a ≥50bps) para concluir.
- Es el terreno del **order book / ejecución maker**: ahí un edge de ~1 bp puede tener sentido,
  o el order book podría anticipar qué absorciones derivan más. Retomar con ese feature.
