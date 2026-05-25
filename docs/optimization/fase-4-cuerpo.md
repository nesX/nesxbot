# Fase 4 — Cuerpo del trompo (`maxBodyPercent`)

**Estado:** ⏳ Pendiente
**Depende de:** Fase 3 completada

---

## Hipótesis

Un cuerpo más pequeño relativo al rango total define un trompo más "puro" —
igual número de sombras superior e inferior, señal de indecisión más clara.
Se espera que bajar el umbral mejore la calidad de la señal pero reduzca trades.

---

## Configuración del grid

```typescript
// Fijar de Fase 3: candleInterval, tp1RR, z1min, z1max, minRangePercent
maxBodyPercent: [15, 20, 25, 30, 35, 40, 50]
minVolume:      [null]  // fijo (fase 5)
```

---

## Criterio de decisión

Métrica objetivo: `WR * sqrt(totalTrades)` — penaliza WR alto con pocos trades.
El valor que maximice esta métrica es el candidato.

| maxBodyPercent | WR% | Trades | Score |
|----------------|-----|--------|-------|
| (llenar tras correr) | | | |

---

## Resultados

> Pendiente de ejecución

---

## Conclusiones

> Pendiente
