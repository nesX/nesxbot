# Plan Maestro de Optimización — SpinningTopFibStrategy

**Estrategia:** SpinningTopFibStrategy (trompos Fibonacci)
**Activo:** BTCUSDT
**Última actualización:** 2026-03-30 (Fases 1 y 2 marcadas para re-run — bugs críticos corregidos)

---

## Principio de trabajo

Optimización secuencial: se fija cada dimensión antes de explorar la siguiente.
Más eficiente que un grid total pero no garantiza el óptimo global.
Al final (Fase 7) se hace un grid de confirmación combinando los mejores valores de cada fase.

---

## Estado general

| Fase | Dimensión | Estado | Parámetro fijado |
|------|-----------|--------|-----------------|
| 1 | TF + TP | ❌ Re-run necesario | resultados inválidos (ver abajo) |
| 2 | Proyecciones zona 1 | ❌ Re-run necesario | resultados inválidos (ver abajo) |
| 3 | Rango de vela (`minRangePercent`) | ⏳ Pendiente (espera Fase 1+2) | — |
| 4 | Cuerpo del trompo (`maxBodyPercent`) | ⏳ Pendiente | — |
| 5 | Volumen mínimo (`minVolume`) | ⏳ Pendiente | — |
| 6 | Validación fuera de muestra | ⏳ Pendiente | — |
| 7 | Grid de confirmación | ⏳ Pendiente | — |

> **Bugs corregidos el 2026-03-30 que invalidan Fases 1 y 2:**
> 1. **Proyecciones de zona incorrectas** — UP proyectaba desde `high` (debía ser `low`);
>    DOWN proyectaba desde `low` (debía ser `high`). Las zonas de entrada estaban en niveles erróneos.
> 2. **FillSimulator — entry no verificado** — asumía fill en la primera vela de 1s del
>    trigger candle sin comprobar si el precio tocó la zona. Generaba TPs/SLs falsos.
>
> Todos los resultados obtenidos antes del 2026-03-30 deben descartarse y re-ejecutarse.

---

## Fase 1 — TF + TP ✅

**Objetivo:** qué timeframe y relación riesgo/recompensa maximizan PF y WR.

**Configuración del grid:**
- `candleInterval`: [1, 2, 3, 4, 5, 6]
- `tp1RR`: [1.5, 2.0, 2.5, 3.0]
- `z1min/z1max`: [1.85–2.15] (rangos amplios)
- `tp1SizePercent`: [100], `moveSlToBreakeven`: [false]

**Resultados destacados:**
- Mejor PF: 1m, tp1RR=1.5, z1=[1.90, 2.06] → PF 3.57, WR 66.3%, MaxDD 3.0%
- Mejor capital: 6m, tp1RR=2.0, z1=[1.95, 2.06] → $1,064,324, MaxDD 6.5%
- Zona ganadora: z1=[1.95, 2.06] aparece en 8 de los top 10

**Parámetros fijados:** `tp1SizePercent=100`, `moveSlToBreakeven=false`, `zone2=null`
*(estos son decisiones de diseño que no dependen de los resultados del run — se mantienen)*

---

## Fase 2 — Proyecciones zona 1 ❌ Re-run necesario

**Objetivo:** afinar z1min y z1max con mayor granularidad para maximizar WR.

**Hipótesis:** una zona más estrecha filtra entradas de menor calidad. El punto
óptimo de z1min es >1.90 (confirmado en Fase 1). Explorar hasta 2.00.

**Configuración del grid:**
```typescript
candleInterval:  [1, 2, 3, 4, 5, 6],
tp1RR:           [1.5, 2.0, 2.5, 3.0],
z1min:           [1.85, 1.90, 1.95],
z1max:           [2.06, 2.10, 2.15],
tp1SizePercent:  [100],
moveSlToBreakeven: [false],
// zone2: deshabilitada
```

**CSV:** `docs/optimization/resultados/fase-2-run-1.csv` (215 combinaciones)

**Resultados destacados:**
- Mejor PF: 1m, tp1RR=1.5, z1=[1.95, 2.06] → PF 15.47, WR 94.0%, MaxDD 1.0%
- z1min=1.95 aparece en 8 de los top 10
- z1max=2.06 aparece en 7 de los top 10
- ALERTA: WR 94% y PF 15.47 son valores fuera de rango típico — requieren validación en Fase 6

**Parámetros fijados:** `z1min=1.95`, `z1max=2.06`

---

## Fase 3 — Rango de vela (`minRangePercent`) 🔄

**Objetivo:** filtrar trompos formados en velas demasiado pequeñas (ruido).

**Hipótesis:** un rango mínimo más alto selecciona trompos más significativos,
mejorando el WR aunque reduciendo el número de trades.

**Configuración del grid:**
```typescript
candleInterval:    [1, 2, 3, 4, 5, 6],   // mantener todos
tp1RR:             [1.5, 2.0],            // mantener los dos mejores
z1min:             [1.95],                // FIJADO — Fase 2
z1max:             [2.06],                // FIJADO — Fase 2
tp1SizePercent:    [100],                 // fijado — Fase 1
moveSlToBreakeven: [false],               // fijado — Fase 1
minRangePercent:   [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0],  // NUEVO
// zone2: deshabilitada
```

**Comando:**
```bash
npm run grid-search -- --from 2025-01-01 --to 2025-03-31 --workers 3 --no-zone2
```

**Combinaciones estimadas:** 6 × 2 × 8 = 96

**Qué buscar:** el punto donde WR aumenta sin que totalTrades caiga por debajo de 30.

---

## Fase 4 — Cuerpo del trompo (`maxBodyPercent`) ⏳

**Objetivo:** definir qué tan estricta debe ser la definición de "trompo válido".

**Hipótesis:** cuerpos muy pequeños (≤15%) son trompos más "puros" → mejor WR.
Cuerpos más grandes (≥35%) generan más señales pero con más ruido.

**Configuración del grid:**
```typescript
// Fijar de Fase 3: candleInterval, tp1RR, z1, minRangePercent
maxBodyPercent: [15, 20, 25, 30, 35, 40, 50],
```

**Qué buscar:** umbral que maximiza WR*sqrt(totalTrades) — balance calidad/cantidad.

---

## Fase 5 — Volumen mínimo (`minVolume`) ⏳

**Objetivo:** eliminar señales en horas de bajo volumen (noches, fines de semana).

**Hipótesis:** trompos con volumen bajo son ruido. Un mínimo de volumen debería
mejorar la calidad de las señales, especialmente en 1m donde hay muchas velas nocturnas.

**Configuración del grid:**
```typescript
// Fijar de Fase 4: candleInterval, tp1RR, z1, minRangePercent, maxBodyPercent
minVolume: [null, 50, 100, 200, 500, 1000, 2000, 5000],
```

**Nota:** los valores de volumen son en unidades base de BTCUSDT (BTC).
Un volumen de 100 = 100 BTC negociados en esa vela.

---

## Fase 6 — Validación fuera de muestra ⏳

**Objetivo:** confirmar que los parámetros óptimos no están sobreajustados a Q1 2025.

**Acción:** correr backtest con los mejores parámetros de todas las fases sobre:
- 2024-01-01 → 2024-12-31 (año previo completo)
- 2025-07-01 → 2025-09-30 (Q3 2025, futuro respecto a la muestra de optimización)

**Criterio de éxito:** métricas similares (±20%) en ambos períodos respecto a la muestra.
Si las métricas caen >30%, hay overfitting y se debe revisar la metodología.

---

## Fase 7 — Grid de confirmación ⏳

**Objetivo:** verificar que la optimización secuencial no quedó atrapada en un óptimo local.

**Acción:** grid combinando los top 2 valores de cada dimensión optimizada:
```typescript
minRangePercent: [mejor_fase3, segundo_fase3],
maxBodyPercent:  [mejor_fase4, segundo_fase4],
minVolume:       [mejor_fase5, null],
// + mejores TF, TP y zonas de fases anteriores
```

---

## Notas y decisiones tomadas

- **Zone2 descartada (2026-03-30):** los resultados sin zona 2 son superiores en WR y PF.
  La zona 2 (2.618–3.06) genera demasiadas señales de baja calidad. Puede revisitarse
  con filtros adicionales (volumen, rango) en una fase posterior si se requiere.
- **Período de optimización:** Q1 2025 (2025-01-01 → 2025-03-31). Todos los grids
  de Fases 1-5 usan este período. La Fase 6 valida fuera de esta ventana.
