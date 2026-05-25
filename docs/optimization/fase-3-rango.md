# Fase 3 — Rango mínimo de la vela (`minRangePercent`)

**Estado:** ⏳ Pendiente
**Depende de:** Fase 2 completada

---

## Hipótesis

Un rango mínimo más estricto filtra trompos formados en velas pequeñas que no
tienen suficiente "energía" de mercado. Estos trompos suelen generar señales falsas.
Se espera que subir el umbral mejore el WR, a costa de reducir el número de trades.

---

## Configuración del grid

```typescript
// Fijar de Fase 2: candleInterval, tp1RR, z1min, z1max
maxBodyPercent:  [30]   // fijo
minRangePercent: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0]
minVolume:       [null] // fijo (fase 5)
```

**Comando (actualizar con TF y zonas de Fase 2):**
```bash
# Ejemplo — completar con parámetros reales de Fase 2
npm run grid-search -- --from 2025-01-01 --to 2025-03-31 --workers 3 --no-zone2
```

---

## Criterio de decisión

Elegir el valor de `minRangePercent` que maximiza WR sin bajar `totalTrades` de 30.
Si hay empate, preferir mayor número de trades (más estadísticamente robusto).

---

## Resultados

> Pendiente de ejecución

---

## Conclusiones

> Pendiente
