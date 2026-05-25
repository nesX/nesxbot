# Filtros de Indicadores Técnicos — RSI y MACD

Los indicadores se usan como **filtros de confirmación**: la estrategia detecta la zona
de entrada normalmente (trompo + proyección Fibonacci), pero antes de ejecutar el trade
verifica que el indicador confirme la dirección. Si no confirma, la señal se descarta.

---

## RSI (Relative Strength Index)

### Lógica

- **SHORT**: entra solo si `RSI >= overbought` (mercado sobrecomprado → probable reversión bajista)
- **LONG**: entra solo si `RSI <= oversold` (mercado sobrevendido → probable reversión alcista)

Si el RSI no llega al umbral, el trade no se ejecuta aunque el precio haya tocado la zona.

### Flags

| Flag | Default | Descripción |
|------|---------|-------------|
| `--rsi` | (desactivado) | Habilita el filtro RSI |
| `--rsi-period 14` | `14` | Períodos del RSI |
| `--rsi-ob 70` | `70` | Umbral overbought — SHORT solo si RSI >= este valor |
| `--rsi-os 30` | `30` | Umbral oversold — LONG solo si RSI <= este valor |

Sin `--rsi`, los demás flags `--rsi-*` no tienen efecto.

### Ejemplos

```bash
# RSI con defaults (período 14, ob=70, os=30)
npm run backtest -- --from 2025-01-01 --to 2025-03-31 --intervals 1 \
  --tp1rr 2.0 --tp1size 100 --no-breakeven \
  --z1min 1.95 --z1max 2.06 --no-zone2 \
  --rsi

# RSI estricto — solo extremos claros
npm run backtest -- --from 2025-01-01 --to 2025-03-31 --intervals 1 \
  --tp1rr 2.0 --tp1size 100 --no-breakeven \
  --z1min 1.95 --z1max 2.06 --no-zone2 \
  --rsi --rsi-ob 75 --rsi-os 25

# RSI más permisivo — captura más señales
npm run backtest -- --from 2025-01-01 --to 2025-03-31 --intervals 1 \
  --tp1rr 2.0 --tp1size 100 --no-breakeven \
  --z1min 1.95 --z1max 2.06 --no-zone2 \
  --rsi --rsi-ob 60 --rsi-os 40

# RSI con período más corto (más reactivo)
npm run backtest -- --from 2025-01-01 --to 2025-03-31 --intervals 1 \
  --tp1rr 2.0 --tp1size 100 --no-breakeven \
  --z1min 1.95 --z1max 2.06 --no-zone2 \
  --rsi --rsi-period 7 --rsi-ob 65 --rsi-os 35
```

---

## MACD (Moving Average Convergence Divergence)

El MACD tiene dos modos: `histogram` (default) y `signal`.

### Modo histogram (default con `--macd`)

Usa el **histograma** = línea MACD − línea de señal.

- **SHORT**: entra solo si `histogram >= threshold` (momentum alcista = posible agotamiento → reversión bajista)
- **LONG**: entra solo si `histogram <= -threshold` (momentum bajista = posible agotamiento → reversión alcista)

El threshold por defecto es `0`: basta con que el histograma sea positivo (SHORT) o negativo (LONG).
Con `--macd-level N` se exige que el momentum sea más pronunciado.

### Modo signal (con `--macd-signal`)

Usa el **cruce** entre la línea MACD y la línea de señal.

- **SHORT**: entra solo si `MACD > signal` (cruce alcista reciente, momentum a favor del short de reversión)
- **LONG**: entra solo si `MACD < signal` (cruce bajista reciente)

### Flags

| Flag | Default | Descripción |
|------|---------|-------------|
| `--macd` | (desactivado) | Habilita filtro MACD en modo histograma |
| `--macd-signal` | (desactivado) | Habilita filtro MACD en modo cruce de señal |
| `--macd-level 0` | `0` | Umbral del histograma. SHORT si hist >= N, LONG si hist <= -N |
| `--macd-fast 12` | `12` | Período de la EMA rápida |
| `--macd-slow 26` | `26` | Período de la EMA lenta |
| `--macd-signal-period 9` | `9` | Período de la línea de señal |

`--macd` y `--macd-signal` son mutuamente excluyentes: si se pasan los dos, `--macd-signal` tiene prioridad.

### Ejemplos

```bash
# MACD histograma básico (> 0 para shorts, < 0 para longs)
npm run backtest -- --from 2025-01-01 --to 2025-03-31 --intervals 1 \
  --tp1rr 2.0 --tp1size 100 --no-breakeven \
  --z1min 1.95 --z1max 2.06 --no-zone2 \
  --macd

# MACD con umbral — exige momentum más fuerte
npm run backtest -- --from 2025-01-01 --to 2025-03-31 --intervals 1 \
  --tp1rr 2.0 --tp1size 100 --no-breakeven \
  --z1min 1.95 --z1max 2.06 --no-zone2 \
  --macd --macd-level 500

# MACD cruce de señal
npm run backtest -- --from 2025-01-01 --to 2025-03-31 --intervals 1 \
  --tp1rr 2.0 --tp1size 100 --no-breakeven \
  --z1min 1.95 --z1max 2.06 --no-zone2 \
  --macd-signal

# MACD con períodos personalizados (más sensible)
npm run backtest -- --from 2025-01-01 --to 2025-03-31 --intervals 1 \
  --tp1rr 2.0 --tp1size 100 --no-breakeven \
  --z1min 1.95 --z1max 2.06 --no-zone2 \
  --macd --macd-fast 8 --macd-slow 17 --macd-signal-period 9
```

---

## Combinando RSI + MACD

Se pueden activar los dos filtros al mismo tiempo. El trade solo se ejecuta si **ambos** confirman.

```bash
# RSI sobrecompra/sobreventa + MACD histograma positivo/negativo
npm run backtest -- --from 2025-01-01 --to 2025-03-31 --intervals 1 \
  --tp1rr 2.0 --tp1size 100 --no-breakeven \
  --z1min 1.95 --z1max 2.06 --no-zone2 \
  --rsi --rsi-ob 70 --rsi-os 30 \
  --macd

# RSI + MACD con umbral — doble confirmación fuerte
npm run backtest -- --from 2025-01-01 --to 2025-03-31 --intervals 1 \
  --tp1rr 2.0 --tp1size 100 --no-breakeven \
  --z1min 1.95 --z1max 2.06 --no-zone2 \
  --rsi --rsi-ob 70 --rsi-os 30 \
  --macd --macd-level 500

# RSI permisivo + cruce de señal MACD
npm run backtest -- --from 2025-01-01 --to 2025-03-31 --intervals 1 \
  --tp1rr 2.0 --tp1size 100 --no-breakeven \
  --z1min 1.95 --z1max 2.06 --no-zone2 \
  --rsi --rsi-ob 65 --rsi-os 35 \
  --macd-signal
```

---

## Notas

**Cuántos trades esperar**

Cada filtro reduce el número de trades. La estrategia sin filtros ya es selectiva (zona Fibonacci
sobre trompos específicos). Agregar RSI o MACD puede reducir los trades un 30–70% dependiendo
de los umbrales. Con menos de ~30 trades los resultados no son estadísticamente significativos.

**Qué `--macd-level` usar**

Los valores del histograma MACD dependen del precio del activo. Para BTCUSDT en 1m, el
histograma suele moverse en rangos de ±50 a ±2000 según la volatilidad del momento.
Empezar con `--macd` sin nivel para ver el comportamiento base, luego ajustar `--macd-level`
según la distribución de valores observada en los trades.

**Orden de procesamiento**

```
zona trompo detectada
  → filtro RSI  (si --rsi)   → descarta o continúa
  → filtro MACD (si --macd)  → descarta o continúa
  → TradePlan emitido
```

**Cálculo sobre las velas del timeframe activo**

Los indicadores se calculan sobre el mismo array de velas 1m que usa la estrategia para
detectar el trompo. Para RSI(14) se necesitan al menos 15 velas cerradas; para MACD(12,26,9)
al menos 44 velas. El período de warmup ya cubre esto para cualquier TF práctico.
