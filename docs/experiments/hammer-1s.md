# hammer-1s: martillos de volumen anormal en velas de 1 segundo (BTC)

- **Estado:** 🔎 catálogo completo (fase 1 hecha); fase 2 (patrones) pendiente
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

## Siguientes pasos
- ✅ Catálogo construido y filtrable por umbral/tipo/contexto.
- **(Fase 2, cuando se decida)** Estudiar qué pasa DESPUÉS de cada evento: retorno forward
  a +N segundos/minutos por tipo (hammer/inverted) y contexto (aislado/consecutivo) →
  ¿hay reversión o continuación explotable? Recordar: es 1s → costo/ejecución mandan
  (probable que solo sea capturable como maker / con order book).
