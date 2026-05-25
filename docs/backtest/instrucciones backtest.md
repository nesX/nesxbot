# Referencia de parámetros — Backtest y Grid Search

## `npm run backtest`

### Rango y símbolo

| Flag | Default | Descripción |
|------|---------|-------------|
| `--symbol BTCUSDT` | `BTCUSDT` | Par a backtestear |
| `--from 2025-01-01` | `2025-01-01` | Fecha inicio (inclusive) |
| `--to 2025-03-31` | `2025-01-31` | Fecha fin (inclusive) |
| `--intervals 1,6` | `1,2,3,...,15` | Timeframes en minutos, separados por coma |
| `--days weekdays` | `all` | Días a operar: `all`, `weekdays`, `weekends`, o números `1,2,3,4,5` |

### Gestión de la posición

| Flag | Default | Descripción |
|------|---------|-------------|
| `--tp1rr 2.0` | `1.0` | Risk:Reward del TP1 (1:N respecto al ancho de la zona) |
| `--tp2rr 3.0` | null | Risk:Reward del TP2. Si se omite, TP2 apunta al high/low del trompo |
| `--tp1size 100` | `50` | % de la posición a cerrar en TP1 (el resto va a TP2) |
| `--no-breakeven` | (breakeven ON) | Deshabilita mover el SL a breakeven al tocar TP1 |

### Proyecciones (zonas Fibonacci)

| Flag | Default | Descripción |
|------|---------|-------------|
| `--z1min 1.95` | `1.8` | Multiplicador mínimo de la zona 1 |
| `--z1max 2.07` | `2.1` | Multiplicador máximo de la zona 1 |
| `--z2min 2.618` | `2.618` | Multiplicador mínimo de la zona 2 |
| `--z2max 3.06` | `3.0` | Multiplicador máximo de la zona 2 |
| `--no-zone2` | (zona 2 ON) | Deshabilita completamente la zona 2 |

### Criterios del trompo

| Flag | Default | Descripción |
|------|---------|-------------|
| `--maxbody 25` | `30` | % máximo body/range para validar vela como trompo |
| `--minrange 0.35` | `0.3` | % mínimo range/close para filtrar velas insignificantes |
| `--minvolume 500` | (sin filtro) | Volumen mínimo absoluto en unidades base (BTC). Si se omite, no hay filtro |

### Expiración de zonas

| Flag | Default | Descripción |
|------|---------|-------------|
| `--zone-expiry 4h` | (sin límite) | Tiempo máximo que vive una zona. Si el precio no llega en ese tiempo, se invalida |

Formatos aceptados: `Nh` (horas), `Nm` (minutos), `Nd` (días). Acepta decimales: `1.5h` = 90 minutos.
Si se omite, las zonas no expiran nunca.

### Filtro de volumen relativo (SMA / EMA)

Filtra trompos cuyo volumen no destaque frente a las velas anteriores. La vela debe tener
`volumen >= MA(period) * multiplier` calculado sobre las N velas **previas** (sin incluir
la vela del trompo).

| Flag | Default | Descripción |
|------|---------|-------------|
| `--vol-ma sma` | (desactivado) | Activa el filtro. Valores: `sma` o `ema` |
| `--vol-ma-period 20` | `20` | Cantidad de velas previas para calcular la media |
| `--vol-ma-mult 2` | `1` | Multiplicador. `2` = el trompo debe doblar el volumen promedio |

> Si no hay suficientes velas previas (menos de `period`), la vela se descarta.

### Filtros de indicadores

Los indicadores se aplican **después** de detectar la zona — si no confirman la dirección, el trade se descarta.

#### RSI

| Flag | Default | Descripción |
|------|---------|-------------|
| `--rsi` | (desactivado) | Habilita el filtro RSI |
| `--rsi-period 14` | `14` | Períodos del RSI |
| `--rsi-ob 70` | `70` | Umbral overbought — SHORT solo si RSI >= este valor |
| `--rsi-os 30` | `30` | Umbral oversold — LONG solo si RSI <= este valor |

#### MACD

| Flag | Default | Descripción |
|------|---------|-------------|
| `--macd` | (desactivado) | Habilita filtro MACD (modo histograma) |
| `--macd-signal` | (desactivado) | Habilita filtro MACD (modo cruce de señal) |
| `--macd-level 0` | `0` | Umbral del histograma. SHORT si hist >= N, LONG si hist <= -N |
| `--macd-fast 12` | `12` | Período EMA rápida |
| `--macd-slow 26` | `26` | Período EMA lenta |
| `--macd-signal-period 9` | `9` | Período de la línea de señal |

Modo `--macd` (histograma): SHORT si `histogram >= level`, LONG si `histogram <= -level`.
Modo `--macd-signal` (cruce): SHORT si `MACD > signal`, LONG si `MACD < signal`.

### Ejemplos

```bash
# Básico — 1m con zona 1 ajustada, sin zona 2
npm run backtest -- --from 2025-01-01 --to 2025-03-31 --intervals 1 \
  --tp1rr 2.0 --tp1size 100 --no-breakeven \
  --z1min 1.95 --z1max 2.06 --no-zone2

# Con zona 2 habilitada y filtros de trompo
npm run backtest -- --from 2025-01-01 --to 2025-03-31 --intervals 1,6 \
  --tp1rr 2.0 --tp1size 100 --no-breakeven \
  --z1min 1.8 --z1max 2.07 --z2min 2.618 --z2max 3.06 \
  --minrange 0.35 --maxbody 25 --minvolume 500

# Solo días hábiles, dos TPs con breakeven
npm run backtest -- --from 2025-01-01 --to 2025-03-31 --intervals 1 \
  --tp1rr 1.5 --tp2rr 3.0 --tp1size 50 \
  --z1min 1.95 --z1max 2.06 --no-zone2 --days weekdays

# Zona expira a las 4 horas si el precio no llegó
npm run backtest -- --from 2025-01-01 --to 2025-03-31 --intervals 1 \
  --tp1rr 2.0 --tp1size 100 --no-breakeven \
  --z1min 1.95 --z1max 2.06 --no-zone2 \
  --zone-expiry 4h

# Volumen relativo — trompo debe doblar la SMA(20) de volumen
npm run backtest -- --from 2025-01-01 --to 2025-03-31 --intervals 1 \
  --tp1rr 2.0 --tp1size 100 --no-breakeven \
  --z1min 1.95 --z1max 2.06 --no-zone2 \
  --vol-ma sma --vol-ma-period 20 --vol-ma-mult 2

# RSI — SHORT solo si sobrecompra, LONG solo si sobreventa
npm run backtest -- --from 2025-01-01 --to 2025-03-31 --intervals 1 \
  --tp1rr 2.0 --tp1size 100 --no-breakeven \
  --z1min 1.95 --z1max 2.06 --no-zone2 \
  --rsi --rsi-ob 70 --rsi-os 30

# MACD con umbral de histograma
npm run backtest -- --from 2025-01-01 --to 2025-03-31 --intervals 1 \
  --tp1rr 2.0 --tp1size 100 --no-breakeven \
  --z1min 1.95 --z1max 2.06 --no-zone2 \
  --macd --macd-level 500

# Todo combinado — volumen relativo + RSI + MACD
npm run backtest -- --from 2025-01-01 --to 2025-03-31 --intervals 1 \
  --tp1rr 2.0 --tp1size 100 --no-breakeven \
  --z1min 1.95 --z1max 2.06 --no-zone2 \
  --vol-ma sma --vol-ma-period 20 --vol-ma-mult 2 \
  --rsi --rsi-ob 70 --rsi-os 30 \
  --macd --macd-level 500
```

---

## `npm run grid-search`

El grid search varía los parámetros definidos en el array `GRID` dentro de `scripts/grid-search.ts`.
Los flags de CLI controlan el entorno y los filtros — **los parámetros del grid se editan directamente en el código**.

### Entorno de ejecución

| Flag | Default | Descripción |
|------|---------|-------------|
| `--symbol BTCUSDT` | `BTCUSDT` | Par a backtestear |
| `--from 2025-01-01` | `2025-01-01` | Fecha inicio |
| `--to 2025-03-31` | `2025-03-31` | Fecha fin |
| `--workers 3` | `min(4, CPUs)` | Número de procesos paralelos |
| `--no-zone2` | (zona 2 ON) | Deshabilita zona 2 en todos los combos |

### Filtros de resultados

| Flag | Default | Descripción |
|------|---------|-------------|
| `--min-trades 30` | `30` | Mínimo de trades para incluir un combo |
| `--min-winrate 60` | `0` | WR% mínimo |
| `--min-pf 1.5` | `1.0` | ProfitFactor mínimo |
| `--max-dd 10` | `100` | MaxDrawdown% máximo |

### Presentación

| Flag | Default | Descripción |
|------|---------|-------------|
| `--top 20` | `20` | Cuántos resultados mostrar |
| `--sort profitFactor` | `profitFactor` | Ordenar por: `profitFactor`, `expectancy`, `finalCapital`, `winRate` |

### Parámetros del GRID (editar en `scripts/grid-search.ts`)

```typescript
const GRID = {
  candleInterval:    [1, 2, 3, 4, 5, 6],   // timeframes en minutos
  tp1RR:             [1.5, 2.0, 2.5, 3.0], // Risk:Reward del TP1
  z1min:             [1.85, 1.90, 1.95],   // multiplicador mínimo zona 1
  z1max:             [2.06, 2.10, 2.15],   // multiplicador máximo zona 1
  tp1SizePercent:    [100],                 // % posición cerrada en TP1
  moveSlToBreakeven: [false],               // breakeven al tocar TP1
  maxBodyPercent:    [30],                  // % máximo body/range del trompo
  minRangePercent:   [0.3],                 // % mínimo range/close del trompo
  minVolume:         [null],                // volumen mínimo absoluto (null = sin filtro)

  // Filtro de volumen relativo (agregar cuando se explore en fase de optimización)
  // volMaType:      ['sma', 'ema'],        // tipo de media
  // volMaPeriod:    [10, 20],              // períodos
  // volMaMult:      [1, 1.5, 2, 3],       // multiplicador
};

// Zona 2 fija para todos los combos (solo si no se usa --no-zone2)
const FIXED = {
  z2min: 2.618,
  z2max: 3.06,
};
```

### Ejemplo

```bash
# Grid con 3 workers, sin zona 2, filtros de calidad
npm run grid-search -- --from 2025-01-01 --to 2025-03-31 \
  --workers 3 --no-zone2 \
  --min-trades 50 --min-winrate 55 --min-pf 1.5 --max-dd 10 \
  --sort profitFactor --top 20
```

---

## Fórmulas de proyección

```
Zona UP   (SHORT): lower = low  + range × z1min
                   upper = low  + range × z1max

Zona DOWN (LONG):  lower = high - range × z1max
                   upper = high - range × z1min

range = high - low  (del trompo)
```

Entrada en el borde interior (más cercano al precio actual), SL en el borde exterior.
TP calculado desde el precio de entrada: `entry ± risk × tp1RR`.
