---
name: DB Schema
description: Esquema real de TimescaleDB, columnas relevantes y gotchas de performance
type: reference
---

## Base de datos: market_tracker (TimescaleDB)

### binance_candles (velas 1m)
- `symbol`: character varying(20)
- `timeframe`: character varying(10) — valores: '1m', '1h'
- `timestamp`: integer (Unix **segundos**) ← columna de partición TimescaleDB
- `open`, `high`, `low`, `close`, `volume`: numeric
- `open_time`, `close_time`: character varying(40)
- `datetime`: character varying(25)
- `quote_asset_volume`: numeric
- `number_of_trades`: integer

En código: convertir ms→segundos antes del WHERE (`Math.floor(ms / 1000)`), y segundos→ms al leer (`openTime = timestamp * 1000`).

### binance_klines_1s (velas 1s)
- `symbol`: character varying(20)
- `open_time`: bigint (Unix **milisegundos**)
- `open_timestamp`: timestamptz ← **COLUMNA DE PARTICIÓN TIMESCALEDB** (CRÍTICO)
- `open_price`, `high_price`, `low_price`, `close_price`, `volume`: numeric
- `close_time`: character varying
- `datetime`: character varying
- `quote_asset_volume`: numeric
- `number_of_trades`: integer

**GOTCHA DE PERFORMANCE (bug real que causó full table scan):**
Filtrar por `open_time` (bigint) NO habilita chunk exclusion en TimescaleDB → full table scan sobre millones de filas en cada llamada al FillSimulator.

**Patrón correcto (ya aplicado en CandleRepository.ts):**
```sql
WHERE symbol         = $1
  AND open_timestamp >= to_timestamp($2 / 1000.0)
  AND open_timestamp <= to_timestamp($3 / 1000.0)
ORDER BY open_timestamp ASC
```

El SELECT sigue leyendo `open_time` (bigint ms) para el valor de `openTime` en el objeto Candle.
Solo el filtro WHERE y ORDER BY usan `open_timestamp`.

**Validar con:**
```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT COUNT(*) FROM binance_klines_1s
WHERE symbol = 'BTCUSDT'
  AND open_timestamp >= to_timestamp(1735689600000 / 1000.0)
  AND open_timestamp <= to_timestamp(1735775999000 / 1000.0);
```
Debe mostrar `Chunks excluded` en el plan, no `Seq Scan` sobre toda la tabla.

### Tablas propias de NesxTrader (no tocar market-tracker)
- `trades`, `executions`, `backtest_runs`
