# Fase 2 — Proyecciones zona 1

**Estado:** ❌ Re-run necesario (resultados inválidos)
**Fecha run original:** 2026-03-30
**Periodo de prueba:** 2025-01-01 a 2025-03-31 (Q1 2025)

> **IMPORTANTE:** Los resultados de este run son inválidos. Se corrigieron dos bugs
> críticos después de ejecutar esta fase:
> 1. **Bug zona proyección** — UP usaba `high` como ancla en lugar de `low`;
>    DOWN usaba `low` en lugar de `high`. Las zonas estaban en niveles incorrectos.
> 2. **Bug FillSimulator** — el simulador asumía entry en la primera vela de 1s del
>    trigger sin verificar si el precio realmente tocó la zona de entrada, generando
>    fills falsos (TPs que en realidad no se tocaron).
>
> El WR 94% y PF 15.47 reportados son artefactos de estos bugs, no resultados reales.
> Hay que re-ejecutar el grid con el código corregido.

---

## Hipotesis

Una zona z1 mas estrecha y desplazada hacia el extremo superior (z1min mas alto)
filtra entradas de menor calidad. Los resultados de Fase 1 sugieren que z1min >= 1.90
ya es mejor que 1.85 — explorar hasta 2.00 con pasos de 0.03.

---

## Configuracion del grid

```typescript
candleInterval:    [1, 2, 3, 4, 5, 6]
tp1RR:             [1.5, 2.0, 2.5, 3.0]
z1min:             [1.85, 1.88, 1.90, 1.92, 1.95, 1.97, 2.00]
z1max:             [2.04, 2.06, 2.08, 2.10, 2.12]
tp1SizePercent:    [100]
moveSlToBreakeven: [false]
// zone2: deshabilitada
```

Nota: el CSV ejecutado contiene 215 combinaciones (las validas tras excluir z1min >= z1max).
Los valores de z1max explorados en el run fueron [2.06, 2.10, 2.15] — el grid real
se ajusto ligeramente respecto a la hipotesis inicial.

---

## Resultados

**Run ejecutado:** 2026-03-30
**CSV fuente:** `docs/backtest/results/grid-search-1774887390457.csv`
**CSV archivado:** `docs/optimization/resultados/fase-2-run-1.csv`
**Total combos ejecutadas:** 215
**Combos con >30 trades y PF>1:** 215 (todas cumplen el criterio minimo)

### Top 10 por ProfitFactor

| TF | tp1RR | z1min | z1max | Trades | WR%   | PF     | MaxDD% | Capital final  |
|----|-------|-------|-------|--------|-------|--------|--------|----------------|
| 1m | 1.5   | 1.95  | 2.06  | 234    | 94.02 | 15.47  | 1.00   | $74,977        |
| 1m | 2.0   | 1.95  | 2.06  | 234    | 91.03 | 14.00  | 1.00   | $150,228       |
| 1m | 1.5   | 1.90  | 2.06  | 236    | 92.37 | 13.58  | 1.99   | $94,834        |
| 1m | 1.5   | 1.95  | 2.10  | 234    | 91.88 | 12.43  | 1.00   | $86,535        |
| 1m | 2.5   | 1.95  | 2.06  | 234    | 86.75 | 11.63  | 1.99   | $260,898       |
| 1m | 3.0   | 1.95  | 2.06  | 234    | 82.48 | 10.22  | 1.99   | $417,907       |
| 2m | 1.5   | 1.95  | 2.06  | 388    | 91.24 | 10.19  | 2.97   | $223,462       |
| 1m | 2.0   | 1.95  | 2.10  | 234    | 86.75 | 9.93   | 1.99   | $155,466       |
| 1m | 1.5   | 1.85  | 2.06  | 241    | 87.97 | 8.76   | 2.97   | $93,357        |
| 1m | 1.5   | 1.95  | 2.15  | 234    | 87.61 | 8.38   | 1.99   | $83,666        |

### Analisis de frecuencia en el top 10

**z1min**

| z1min | Apariciones en top 10 | Porcentaje |
|-------|----------------------|------------|
| 1.95  | 8                    | 80%        |
| 1.90  | 1                    | 10%        |
| 1.85  | 1                    | 10%        |

**z1max**

| z1max | Apariciones en top 10 | Porcentaje |
|-------|----------------------|------------|
| 2.06  | 7                    | 70%        |
| 2.10  | 2                    | 20%        |
| 2.15  | 1                    | 10%        |

**candleInterval**

| TF | Apariciones en top 10 | Porcentaje |
|----|----------------------|------------|
| 1m | 9                    | 90%        |
| 2m | 1                    | 10%        |

**tp1RR**

| tp1RR | Apariciones en top 10 | Porcentaje |
|-------|----------------------|------------|
| 1.5   | 6                    | 60%        |
| 2.0   | 2                    | 20%        |
| 2.5   | 1                    | 10%        |
| 3.0   | 1                    | 10%        |

---

## Analisis de sensibilidad

Fijando TF=1m y tp1RR=1.5, variando solo z1min:

| z1min | z1max=2.06 | z1max=2.10 | z1max=2.15 |
|-------|-----------|-----------|-----------|
| 1.85  | PF 8.76   | PF 6.42   | PF 5.14   |
| 1.90  | PF 13.58  | PF 7.85   | PF 5.13   |
| 1.95  | PF 15.47  | PF 12.43  | PF 8.38   |

El salto de 1.90 a 1.95 con z1max=2.06 es +14% en PF. El parametro es sensible.
La combinacion [1.95, 2.06] domina consistentemente en todas las variaciones de tp1RR.

---

## ALERTA — Discrepancia WR con Fase 1

**Fase 1 mejor resultado:** 1m, tp1RR=1.5, z1=[1.95, 2.06] -> WR 69%, PF 3.52, **42 trades**
**Fase 2 mismo parametro:** 1m, tp1RR=1.5, z1=[1.95, 2.06] -> WR 94%, PF 15.47, **234 trades**

La diferencia de 42 vs 234 trades con los mismos parametros es significativa y tiene una
explicacion clara: en Fase 1 la zona2 estaba habilitada con z2=[2.618, 3.06]. Con zone2
activa, la estrategia compite entre zona1 y zona2 para la misma vela, lo que altera tanto
el numero de trades asignados a zona1 como la WR resultante. Al deshabilitar zone2 en Fase 2,
todos los trades de la vela quedan atribuidos a zona1 exclusivamente.

El WR del 94.02% con PF 15.47 sobre 234 trades en Q1 2025 es extraordinariamente alto.
Se recomienda:
1. Confirmar en Fase 6 (validacion fuera de muestra) que estos resultados no son especificos de Q1 2025.
2. Observar con cautela: Q1 2025 puede haber sido un periodo particularmente favorable para
   setups de reversion tipo trompo en BTC.
3. El MaxDD de solo 1.00% es consistente con el WR alto — la estrategia en ese periodo
   casi no tocaba el stop.

---

## Conclusiones

1. **z1min=1.95 es el valor dominante.** Aparece en 8 de los 10 mejores resultados y su
   superioridad sobre 1.90 es consistente en todos los TF y tp1RR probados. Fijar.

2. **z1max=2.06 es el valor dominante.** Aparece en 7 de los 10 mejores resultados.
   Una zona estrecha [1.95, 2.06] (amplitud 0.11) supera a zonas mas anchas. Fijar.

3. **TF=1m confirma su posicion.** 9 de los 10 mejores son en 1m. Sin embargo, en
   Fase 3-5 se mantendran multiples TF para no descartar prematuramente 2m-6m
   que tienen mas trades y pueden mostrar ventajas con filtros adicionales.

4. **tp1RR: 1.5 sigue siendo el mejor para PF, pero 2.0-3.0 generan mas capital final**
   gracias al compounding. La decision final se puede diferir a Fase 7 (grid de confirmacion).

5. **Alerta de resultados excepcionales.** WR 94% y PF 15.47 son valores fuera de rango
   tipico. Requieren validacion fuera de muestra antes de cualquier decision de deploy.

---

## Parametros fijados para Fase 3

| Parametro | Valor | Razon |
|-----------|-------|-------|
| `z1min`   | 1.95  | Aparece en 80% del top 10; salto de sensibilidad claro vs 1.90 |
| `z1max`   | 2.06  | Aparece en 70% del top 10; zona estrecha superior a zona ancha |

Los parametros fijados en Fase 1 se mantienen: `tp1SizePercent=100`, `moveSlToBreakeven=false`, `zone2=null`.

Se mantienen multiples valores de `candleInterval` y `tp1RR` para Fase 3 a fin de no
colapsar prematuramente el espacio de busqueda.

---

## Comando para Fase 3

Editar el GRID en `scripts/grid-search.ts`:

```typescript
// Valores a configurar en el GRID:
candleInterval:    [1, 2, 3, 4, 5, 6]  // mantener todos
tp1RR:             [1.5, 2.0]           // mantener los dos mejores
z1min:             [1.95]               // FIJADO en Fase 2
z1max:             [2.06]               // FIJADO en Fase 2
tp1SizePercent:    [100]                // fijado en Fase 1
moveSlToBreakeven: [false]              // fijado en Fase 1
minRangePercent:   [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0]  // NUEVO — Fase 3
// zone2: deshabilitada
```

```bash
npm run grid-search -- --from 2025-01-01 --to 2025-03-31 --workers 3 --no-zone2
```

**Combinaciones estimadas:** 6 x 2 x 1 x 1 x 8 = 96 combinaciones.
