# Fase 5 — Volumen mínimo (`minVolume`)

**Estado:** ⏳ Pendiente
**Depende de:** Fase 4 completada

---

## Hipótesis

Los trompos formados en velas de bajo volumen son ruido de mercado — aparecen
frecuentemente en horarios nocturnos o fines de semana donde la liquidez es baja
y los movimientos no tienen convicción. Un filtro de volumen mínimo debería
eliminar estas señales falsas, mejorando el WR especialmente en TF cortos (1m, 2m).

---

## Configuración del grid

```typescript
// Fijar de Fase 4: candleInterval, tp1RR, z1min, z1max, minRangePercent, maxBodyPercent
minVolume: [null, 50, 100, 200, 500, 1000, 2000, 5000]
```

**Nota sobre unidades:** el volumen en BTCUSDT está en BTC.
- 50 BTC/vela → umbral conservador
- 500 BTC/vela → umbral agresivo (filtra ~60-70% de velas en horario asiático)

---

## Experimento adicional — volumen + días de semana

Si el volumen no mejora mucho, probar la combinación con `tradingDays`:
```bash
--minvolume 200 --days weekdays
```
Para ver si el problema es el horario (días) más que el volumen puntual.

---

## Criterio de decisión

1. WR no baja respecto a la Fase 4 (el filtro no debe degradar la señal)
2. `totalTrades` se mantiene estadísticamente suficiente (>30)
3. Si `minVolume=null` da igual resultado → el filtro de volumen no aporta y se descarta

---

## Resultados

> Pendiente de ejecución

---

## Conclusiones

> Pendiente
