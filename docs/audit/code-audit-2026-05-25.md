# Auditoría de código base — motor de backtest (2026-05-25)

Revisión de bugs y deuda técnica del **código de infraestructura** que ejecuta y genera
backtests. **No** se auditaron las estrategias (lógica subjetiva). Base verde al momento de
la auditoría: 413 tests, typecheck `src` limpio.

Archivos revisados: `src/backtest/{FillSimulator,MetricsCalculator,BacktestRunner,BacktestRepository}.ts`,
`src/data/{CandleRepository,ReplayProvider}.ts`, `src/shared/MessageBroker.ts`,
`src/strategy/{StrategyEngine,MarketStateBuilder,CandleAggregator}.ts`,
`scripts/lib/{backtest,db,InMemoryCandleRepository,env}.ts`, `src/types.ts`.

Leyenda: 🔴 alta · 🟠 media · 🟡 baja · ✅ corregido en esta auditoría · 📝 documentado (requiere decisión)

---

## 🔴 Hallazgos de alta prioridad (correctitud — cambian resultados)

### H1 · Lookahead en la entrada del FillSimulator ✅ CORREGIDO (2026-05-25)
**Archivo:** `src/backtest/FillSimulator.ts:83-84, 127-168`

> **Resultado del fix — crítico.** Re-corrida de referencia BTCUSDT Q1-2024, mismos 1163 trades:
>
> | Métrica | Antes (lookahead) | Después (honesto) |
> |---|---|---|
> | Win rate | 53.65% | **39.04%** |
> | Profit factor | 1.06 | **0.55** |
> | Capital final | $12.904 | **$396** |
> | Max drawdown | 28% | **96%** |
>
> El lookahead convertía una estrategia **perdedora** en aparentemente rentable. TODOS los
> resultados de backtest anteriores a este fix están contaminados y deben descartarse.
>
> **Fix aplicado:** la entrada se busca desde `contextCandle.openTime + tfMs` (cierre de la vela
> de señal), con un guard explícito `c.openTime >= from` en el escaneo de entrada (robusto aunque
> el repo no filtre). `tfMs` se deriva de `contextCandle.timeframe` vía `_timeframeToMs()`.
> Tests actualizados (velas granulares posicionadas tras el cierre de la señal). 413 tests verdes.

`simulateFill` toma `from = contextCandle.openTime` y busca la entrada desde la **primera**
vela granular de ese rango. La `contextCandle` es la vela que **acaba de cerrar** cuando se
generó la señal. Por lo tanto las primeras velas 1s (las del propio minuto de la señal,
`[openTime, openTime+60s)`) son anteriores al momento en que la señal existió.

Si `entryPrice` se tocó **durante** ese minuto, el simulador rellena ahí — un fill que en
real no se pudo colocar (la orden no existía aún). Es **sesgo de anticipación (lookahead)**
con tendencia optimista.

- **Impacto práctico:** probablemente **bajo** para entradas por proyección (Fibonacci/zona),
  porque la zona suele estar lejos del precio en la vela de señal; el toque ocurre en velas
  posteriores. Pero es un bug de principio que erosiona la confianza del sistema autónomo, y
  puede ser grande en zonas muy ajustadas.
- **Por qué NO se corrigió aquí:** está horneado en el diseño y en los tests
  (`FillSimulator.unit.test.ts:160-182` asume entrada en una vela con el mismo `openTime` que
  la contextCandle). Corregirlo cambia **todos** los números históricos y obliga a re-basar
  tests. Es una decisión semántica, no un parche.
- **Fix recomendado:** iniciar el escaneo de entrada en `contextCandle.openTime + tfMs`,
  derivando `tfMs` de `contextCandle.timeframe`. Actualizar los tests para reflejar la entrada
  en la vela siguiente. Re-correr una corrida de referencia y comparar el delta.

### H2 · CandleAggregator no alinea a límites de reloj 📝
**Archivo:** `src/strategy/CandleAggregator.ts:25-31`

Agrupa velas 1m en bloques de N **contando desde el índice 0** del array, no desde un límite
de reloj (`:00, :05, :10...`). Si el array no empieza en un múltiplo de N, las velas
agregadas (`5m`, `15m`, ...) **no coinciden** con las del exchange/TradingView.

- **Impacto:** las estrategias con `candleInterval > 1` ven velas distintas a las reales →
  señales distintas a lo que valida un humano en TradingView. El default es `candleInterval=1`
  (no afectado), por eso no es crítico hoy.
- **No corregido:** cambia la semántica de las velas de toda estrategia multi-minuto (zona que
  el usuario pidió no tocar). No hay tests de CandleAggregator que lo cubran.
- **Fix recomendado:** agrupar por `floor(openTime / (N*60000))` y emitir una vela por bloque
  de reloj. Agregar tests de alineación. Decidir junto al usuario por el cambio de resultados.

---

## 🟠 Hallazgos de prioridad media

### M1 · Sortino = 0 cuando no hay trades perdedores 📝
**Archivo:** `src/backtest/MetricsCalculator.ts:110-123`

Si no hay pérdidas, `sortinoRatio` retorna `0` — indistinguible de "sin edge". Una estrategia
perfecta (solo ganancias) parece tener ratio nulo, lo que la hunde en cualquier ranking.

- **Es intencional** según el test `MetricsCalculator.unit.test.ts:354` (`expect(...).toBe(0)`),
  por eso no se cambió. Recomendación: documentar el caveat y, al rankear, tratar Sortino=0
  con `totalTrades>0` y sin pérdidas como "tope" (no como cero). Mismo caso para Sharpe con
  `stdDev=0`.

### M2 · MessageBroker sin aislamiento de errores por handler 📝
**Archivo:** `src/shared/MessageBroker.ts:12-16`

`publish` hace `await handler(payload)` en serie. Si **un** suscriptor lanza, los handlers
restantes no se ejecutan y el `publish` rechaza, **abortando todo el backtest** (p.ej. desde
el loop de `ReplayProvider`). Para un bucle autónomo que corre miles de backtests, un handler
defectuoso mata la corrida entera.

- **Trade-off:** el comportamiento actual es fail-fast (puede ser deseable para no enmascarar
  bugs). Recomendación: envolver cada handler en try/catch con log y un canal de error, o al
  menos aislar por handler manteniendo un modo estricto opcional. Decisión de diseño.

### M3 · Ventana de retención fija de 24h en el fill 📝
**Archivo:** `src/backtest/FillSimulator.ts:84, 244-256`

El escaneo de TP/SL solo cubre `[entry, entry+24h]`. Si ni TP ni SL se tocan en 24h, el trade
se cierra `MANUAL` al `close` de la última vela. Es un máximo de holding **hardcodeado** y no
configurable; puede no coincidir con la intención de la estrategia (swing multi-día).

- **Fix recomendado:** parametrizar la ventana (`maxHoldMs`) en el TradePlan o config del
  FillSimulator. Bajo riesgo si default = 24h (preserva comportamiento).

### M4 · `npm run typecheck` no cubría `scripts/` ✅
**Archivos:** `package.json`, `scripts/grid-search-worker.ts`, `scripts/backtest-profile.ts`

El typecheck del proyecto solo cubría `src/**`. Los scripts (incluido el pipeline de backtest)
acumulaban errores de tipo sin detectarse: `grid-search-worker.ts` y `backtest-profile.ts`
pasaban `zoneLifetime: Infinity`, propiedad **inexistente** en `SpinningTopFibConfig` (el
campo real es `zoneExpiry`). `Infinity` ≡ "sin expiración" ≡ default, así que era un no-op.

- **Corregido:** se removieron las líneas `zoneLifetime` (preserva comportamiento) y se agregó
  `npm run typecheck:all` (typechea `src` + `scripts`), cableado al gate de `npm run exp`.
  Verificado: `typecheck:all` exit 0, 413 tests verdes.

---

## 🟡 Deuda técnica / menor

| # | Archivo | Detalle | Estado |
|---|---------|---------|--------|
| L1 | `MetricsCalculator.ts:40` | `pessimistic_penalties` cuenta **todo** `had_ambiguity` (incluye la heurística de distancia en modo PRECISE), no solo penalizaciones PESSIMISTIC. Nombre engañoso. | 📝 |
| L2 | `MetricsCalculator.ts:99-123` | Sharpe/Sortino **no anualizados** ni con tasa libre de riesgo — son media/desvío por trade. No comparables entre estrategias de distinta frecuencia. | 📝 |
| L3 | `grid-search.ts:230` | `expectancy` se mostraba con prefijo `$` pero está en R (R-múltiplos), no dólares. | ✅ corregido a `…R` |
| L4 | `StrategyEngine.ts:118-122` | `stop()` no hace `unsubscribe` del broker. Inofensivo hoy (instancias frescas por run) pero si se reusa una instancia con start/stop/start → doble suscripción → evaluaciones duplicadas. | 📝 |
| L5 | `FillSimulator.ts:511-522` | El cache 1s evita por **FIFO**, no LRU (el comentario dice "LRU"). Re-acceder un día no lo refresca → puede evictar días calientes. Impacto: perf menor. | 📝 |
| L6 | `CandleRepository.ts` / general | Sin validación de integridad de datos (gaps de velas, `high<low`, `volume<0`). Datos corruptos producirían fills/métricas silenciosamente erróneas. | 📝 |
| L7 | `MarketStateBuilder.ts:99` | `build` devuelve `buffer.slice()` (copia shallow) pero comparte **referencias** de las velas; una estrategia que mute una vela corrompe el buffer. | 📝 |
| L8 | `CandleRepository.ts` | Dualidad de unidades de timestamp (segundos en `binance_candles`, ms en `binance_klines_1s`). Manejada correctamente hoy, pero frágil ante nuevas queries. | 📝 |

---

## Lo que está bien (no tocar)

- **Resolución de ambigüedad SL/TP** (`FillSimulator._evaluateCandle`) — heurística de distancia
  al open + modo pessimistic forzando SL. Sólida.
- **Gotcha `open_timestamp` vs `open_time`** (`CandleRepository._getCandles1s`) — filtra por
  `open_timestamp` (timestamptz) para chunk exclusion de TimescaleDB. Correcto.
- **Orden cronológico** (`ReplayProvider._assertChronologicalOrder`) — invariante validado.
- **Coherencia temporal** — `TimeProvider` inyectado y avanzado antes de cada emisión.
- **Búsqueda binaria** (`InMemoryCandleRepository.sliceByOpenTime`) — correcta, O(log n).
- **Aislamiento de errores de estrategia** (`StrategyEngine._evaluateStrategy`) — una excepción
  en `evaluate()` no rompe el loop.

---

## Recomendación de orden de ataque

1. ~~**H1 (lookahead)**~~ — ✅ HECHO. Reveló que los resultados previos estaban inflados (PF
   1.06 → 0.55). Todo backtest anterior al 2026-05-25 debe descartarse.
2. **M3 (ventana 24h configurable)** — barato y desbloquea estrategias de mayor holding.
3. **H2 (alineación de velas)** — antes de usar `candleInterval>1` en serio.
4. **M1/L2 (métricas de ranking)** — importan cuando el bucle empiece a rankear muchas corridas.
5. El resto (deuda menor) — oportunista.
