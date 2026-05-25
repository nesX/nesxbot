# Backtest Performance — Análisis y Optimizaciones

**Fecha:** 2026-03-29
**Contexto:** Grid search de 216 combinaciones con 4 workers tardó ~15 min. El objetivo es reducir tiempos para permitir grids más amplios.

---

## Bottleneck #1 — FillSimulator: Queries Redundantes a `candles_1s`

**Impacto estimado: 50-70% del tiempo total**

Cada trade ejecuta `hasGranularData()` + `getCandles()` contra `binance_klines_1s`. En el grid search, los mismos rangos de fecha se consultan cientos de veces para las mismas velas.

**Números:**
- 216 combos × ~400 trades promedio = ~86,400 trades
- Cada trade hace ~3.7 queries (hasGranularData + getCandles por cada stage)
- Total: ~321,840 queries a PG, la mayoría redundantes

**Solución:** Cache a nivel de día para velas 1s, similar a `InMemoryCandleRepository` para 1m.

```
Antes:  trade → query PG → velas 1s
Después: trade → cache día → hit? → devolver | miss? → query PG → guardar en cache
```

- Pre-cargar días que se sabe que tienen datos 1s (una query al inicio)
- Cache LRU por día para no explotar memoria (velas 1s × 86,400/día × 5 cols ≈ 3-4 MB/día)
- `hasGranularData()` se resuelve con un Set de días disponibles

**Reducción estimada:** De ~321,840 queries a ~184 (una por día del rango).

---

## Bottleneck #2 — `hasGranularData()` Repetida

**Impacto estimado: 30% en grid search**

Cada combo re-evalúa si hay datos 1s para los mismos rangos. El resultado no cambia entre combos.

**Solución:** Cachear el resultado de `hasGranularData()` por `(symbol, from, to)` al inicio del backtest. En grid search, calcularlo una vez en el proceso principal y pasarlo a los workers.

```typescript
// En el worker, antes del loop de combos:
const granularInfo = await repo.hasGranularData(symbol, from, to);
// Pasar como parámetro al FillSimulator
```

---

## Bottleneck #3 — BacktestRunner: Fill Simulation Secuencial

**Impacto estimado: 40-60% (con cache de #1)**

Actualmente cada trade se simula secuencialmente:
```
signal → await fillSimulator.simulate(plan) → siguiente signal
```

Los fills son independientes entre sí (no comparten estado). Se pueden procesar en batch.

**Solución:** Acumular N señales y simular en paralelo con `Promise.all()`:

```typescript
// Batch de fills cada N señales o al final
const batch = pendingPlans.splice(0, BATCH_SIZE);
const fills = await Promise.all(batch.map(plan => fillSimulator.simulate(plan)));
```

**Nota:** Solo aplica si se implementa el cache de #1 primero (sino el paralelismo satura PG).

---

## Bottleneck #4 — InMemoryCandleRepository: Filtrado O(n)

**Impacto estimado: 5-10%**

`getCandles()` hace `filter()` lineal sobre todas las velas cargadas:
```typescript
return all.filter(c => c.openTime >= from && c.openTime <= to);
```

Con ~130,000 velas 1m (Q1 completo), cada llamada recorre todo el array.

**Solución:** Binary search para encontrar el rango:

```typescript
// Las velas ya están ordenadas por openTime
const startIdx = binarySearch(all, from);  // primer índice >= from
const endIdx   = binarySearch(all, to);    // último índice <= to
return all.slice(startIdx, endIdx + 1);
```

**Reducción:** De O(n) a O(log n) por consulta. Con ~400 trades × 6 TFs × 216 combos = ~518,400 llamadas, el ahorro es significativo.

---

## Bottleneck #5 — MarketStateBuilder: Array Shift/Slice

**Impacto estimado: 3-5%**

`MarketStateBuilder` mantiene un buffer de velas con `push()` + `shift()` cuando excede `maxCandles`. `shift()` es O(n) en arrays grandes.

**Solución:** Usar ring buffer o simplemente no limitar en backtest (la memoria no es problema para runs de 3 meses).

---

## Bottleneck #6 — Connection Pool por Worker

**Impacto estimado: variable**

Cada worker crea su propio pool de conexiones a PG. Con 4 workers × 10 conexiones default = 40 conexiones simultáneas.

**Solución:**
- Reducir pool size por worker: `max: 2` (solo necesitan queries 1s esporádicas)
- Con el cache de #1, los workers casi no tocarían PG

---

## Bottleneck #7 — Índices Faltantes en `binance_klines_1s`

**Impacto estimado: depende del volumen de datos**

Verificar que existe un índice compuesto en `(symbol, open_timestamp)` para la tabla `binance_klines_1s`. TimescaleDB crea índices en la columna de partición, pero el filtro por `symbol` podría no estar cubierto.

**Verificar con:**
```sql
SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'binance_klines_1s';
EXPLAIN ANALYZE SELECT * FROM binance_klines_1s
  WHERE symbol = 'BTCUSDT'
  AND open_timestamp >= to_timestamp(1704067200)
  AND open_timestamp <= to_timestamp(1704153600);
```

---

## Plan de Implementación (orden recomendado)

| Prioridad | Optimización | Esfuerzo | Speedup estimado |
|-----------|-------------|----------|-----------------|
| 1 | Cache día para velas 1s (#1) | Medio | 50-70% |
| 2 | Cache hasGranularData (#2) | Bajo | 30% |
| 3 | Binary search en InMemoryRepo (#4) | Bajo | 5-10% |
| 4 | Fill simulation en batch (#3) | Medio | 40-60% (post-cache) |
| 5 | Pool size por worker (#6) | Trivial | Variable |
| 6 | Verificar índices (#7) | Trivial | Variable |
| 7 | Ring buffer MarketState (#5) | Bajo | 3-5% |

**Speedup total estimado: 4-6× sobre el tiempo actual.**

Con las optimizaciones #1 y #2, el grid search de 216 combos debería bajar de ~15 min a ~3-5 min. Agregando #3 y #4, grids de 1000+ combos serían viables en tiempos razonables.

---

## Notas

- Las optimizaciones #1-#3 son independientes y se pueden implementar en cualquier orden
- #3 (batch fills) tiene mayor impacto DESPUÉS de implementar #1 (cache), porque sin cache el paralelismo satura PG
- Todas las optimizaciones son internas al módulo backtest — no afectan la interfaz pública ni otros módulos
