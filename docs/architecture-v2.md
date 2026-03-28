# NesxTrader — Documentación de Arquitectura v2.0

**Trading Bot Algorítmico — Node.js / PostgreSQL / CCXT**
**Marzo 2026**

---

## 1. Topología del Sistema (Módulos Principales)

La arquitectura se divide en 7 pilares completamente desacoplados. Ningún módulo invoca directamente a otro; se comunican exclusivamente a través de un Bus de Eventos. Los dos nuevos módulos (Backtesting Engine y Cross-Cutting Concerns) complementan los 5 pilares originales para habilitar validación de estrategias y testeabilidad completa.

### 1.1. Data Provider (Motor de Ingesta)

Responsable de construir y mantener el MarketState (contexto de mercado) en múltiples temporalidades (MTF: 1s, 1m, 5m, 15m, 1h, 4h).

- **Fase Bootstrapper (REST):** Al iniciar, descarga N velas históricas para estabilizar indicadores con retraso (MACD, RSI).
- **Fase Streamer (WebSockets):** Escucha el mercado en tiempo real, actualizando el buffer en memoria de forma circular.
- **Fase Replay (Backtesting):** Itera sobre velas históricas emitiendo los mismos eventos (CANDLE_CLOSED, MARKET_STATE_UPDATED) al bus. El StrategyEngine no distingue si los datos son live o replay.

### 1.2. Strategy Engine (Cerebro Analítico)

Evalúa el mercado y emite planes de trading. Utiliza el Patrón Strategy para inyectar o retirar módulos de análisis sin afectar el núcleo.

- **StrategyBase (Contrato Formal):** Interfaz que TODA estrategia debe implementar. Define: id único, requiredTimeframes (temporalidades necesarias), y método evaluate(MarketState) que retorna un SignalGroup (con uno o más TradePlans y su política de relación) o null.
- **StrategyRegistry:** Registro central donde se inscriben las estrategias disponibles. Permite activar/desactivar estrategias por configuración, ejecutar N estrategias contra los mismos datos para comparación A/B, y listar estrategias activas para el BacktestRunner.
- **Analyzers:** Módulos conectables. Incluye análisis técnico (obligatorio) y un analizador de IA (opcional).
- **Risk Manager:** Submódulo que define el riesgo asimétrico. Calcula Stop Loss (SL) rígidos y estructurales, y Take Profits (TP) dinámicos basados en la fuerza de la tendencia (Context Score).
- **Lógica Híbrida HTF/LTF:** Las temporalidades mayores (HTF) proyectan zonas de reversión, el motor entra en estado ARMED. Las temporalidades menores (LTF) actúan como Gatillo de Confirmación para evitar órdenes Limit a ciegas.
- **Salida:** Emite un objeto SignalGroup estructurado al bus de eventos.

### 1.3. Execution Engine (Brazo Operativo)

Traduce el TradePlan en órdenes reales o simuladas.

- **Modos Soportados:** Live (vía CCXT), Dry Run (simulado en BD), Backtest (vía FillSimulator). El cambio de modo solo requiere cambiar qué ejecutor escucha el bus de eventos.
- **Gestión OCO:** Utiliza órdenes One Cancels the Other para colocar simultáneamente el SL de protección y el TP de beneficio.
- **Resilience Layer:** Envuelve las llamadas de red con Exponential Backoff para manejar latencias y errores 500 del exchange.

### 1.4. Position Manager (Auditor de Seguridad)

Garantiza que el sistema nunca quede expuesto al mercado por un error de red o de software.

- **Crash Recovery Unit:** Se ejecuta primero al encender el bot. Escanea el exchange para reconstruir operaciones huérfanas antes de procesar nuevos datos.
- **Sync Worker:** Bucle asíncrono que cruza el estado local (PostgreSQL) con la realidad del exchange (CCXT). Si detecta órdenes no cerradas cuando debían estarlo, fuerza el cierre a mercado.

### 1.5. Notification Engine

Escucha pasivamente el bus de eventos y clasifica alertas: INFO para tomas parciales y entradas, WARNING para reintentos, CRITICAL para fallos de sincronización.

### 1.6. Backtesting Engine

Sistema completo de validación de estrategias. No es un simple modo del ExecutionEngine, sino un orquestador independiente que coordina replay de datos, simulación de fills y cálculo de métricas.

#### 1.6.1. BacktestRunner (Orquestador)

Coordina una corrida completa de backtesting. Su responsabilidad es configurar el entorno simulado y ejecutar el ciclo de evaluación.

- **Configuración:** Recibe rango de fechas, símbolo, estrategia(s) a evaluar, y capital inicial.
- **Setup del entorno:** Inyecta el TimeProvider simulado, conecta el DataProvider en modo Replay, y sustituye el ExecutionEngine por el FillSimulator.
- **Ejecución:** Itera vela por vela en el timeframe de la estrategia. Por cada vela, emite CANDLE_CLOSED al bus, permitiendo que el StrategyEngine evalúe normalmente.
- **Multi-estrategia:** Puede ejecutar N estrategias del StrategyRegistry contra los mismos datos históricos para comparación directa.
- **Salida:** Genera un BacktestReport con todas las métricas de rendimiento.

#### 1.6.2. FillSimulator (Motor de Simulación de Fills)

Módulo independiente que determina con precisión si una orden se habría ejecutado y a qué precio real. Es la pieza clave que elimina la ambigüedad intra-vela. Opera con un sistema de resolución adaptativo de dos modos según la disponibilidad de datos granulares.

- **Entrada:** Recibe timestamp de la señal, niveles a vigilar (precio de entrada, SL, TPs) y el símbolo.

**Estrategia de Resolución Adaptativa:**

Antes de resolver cualquier fill, el FillSimulator consulta al CandleRepository si existen datos granulares (1s o 1m) para el símbolo y rango de tiempo requerido. Según la respuesta, selecciona automáticamente uno de dos modos de resolución:

- **Modo Preciso (datos de 1s/1m disponibles):** Consulta las velas granulares desde el timestamp de entrada y recorre secuencialmente hasta encontrar qué nivel se toca primero. La resolución es determinística: no hay suposiciones. Además simula slippage real; si una vela abre directamente más allá del nivel (gap), el fill se registra al precio de apertura de esa vela, no al precio teórico.
- **Modo Pesimista (sin datos granulares):** Cuando no hay datos de 1s ni 1m para el rango, el simulador opera con la vela del timeframe de la estrategia (ej. 15m, 1h). En cada vela evalúa si el rango High-Low contiene tanto el SL como algún TP. Si no hay ambigüedad (solo uno de los dos cae dentro del rango), resuelve normalmente. Si hay ambigüedad (ambos niveles caen dentro del rango), asume siempre el peor escenario: el SL se ejecutó primero. Este enfoque es conservador por diseño; si la estrategia es rentable bajo esta penalización, en la realidad rendirá igual o mejor.

**Jerarquía de Resolución de Datos:**

El FillSimulator intenta resolver con la mayor precisión disponible, descendiendo automáticamente en la jerarquía: primero busca velas de 1 segundo, si no existen busca velas de 1 minuto, y si tampoco existen aplica el modo pesimista con la vela del timeframe de la estrategia. Esta jerarquía es transparente para el BacktestRunner, que no necesita saber qué modo se usó.

**Marcado de Confianza en FillResult:**

Cada FillResult incluye un campo resolution_mode que indica qué modo se usó para resolver ese fill en particular (PRECISE_1S, PRECISE_1M, o PESSIMISTIC). El BacktestReport agrega esta información como un porcentaje de fills resueltos por cada modo, permitiendo evaluar la confiabilidad general de la corrida. Una corrida con 95% de fills en modo preciso es más confiable que una con 60% en modo pesimista.

- **Interfaz de acceso a datos:** Consulta los datos a través del CandleRepository, nunca directamente a tablas. El repositorio expone un método hasGranularData(symbol, from, to, timeframe) que el simulador usa para decidir el modo antes de resolver.
- **Salida:** Retorna un FillResult con: nivel tocado (SL/TP1/TP2/TP3), timestamp exacto, precio real de fill, slippage, y resolution_mode.

#### 1.6.3. MetricsCalculator (Evaluador de Rendimiento)

Recibe el conjunto de trades simulados y calcula métricas estadísticas para evaluar la rentabilidad de la estrategia.

- **Métricas base:** Win Rate, Profit Factor, Expectancy, Total Return, Total Trades.
- **Métricas de riesgo:** Max Drawdown, Sharpe Ratio, Sortino Ratio, Recovery Factor.
- **Métricas por componente:** Rendimiento desglosado por TP (cuánto aporta TP1 vs TP2 vs TP3), efectividad del SL, frecuencia de runners exitosos.
- **Comparación:** Cuando se ejecutan múltiples estrategias, genera un ranking comparativo por Sharpe y Profit Factor.

---

### 1.7. Cross-Cutting Concerns

Servicios transversales que todos los módulos consumen vía inyección de dependencias. Son la clave para la testeabilidad del sistema.

#### 1.7.1. TimeProvider

Abstracción sobre el tiempo del sistema. Todo módulo que necesite la hora actual debe solicitar este servicio, nunca usar Date.now() directamente.

- **Modo Live:** Retorna Date.now() real.
- **Modo Backtest:** Retorna el timestamp de la vela actual en el replay. Esto garantiza que toda la lógica temporal (expiraciones, timeouts, timestamps de órdenes) sea coherente con la simulación.
- **Regla crítica:** Si algún módulo usa Date.now() directamente, el backtest produce datos incorrectos. Esta dependencia debe ser inyectada sin excepción.

#### 1.7.2. MessageBroker (Bus de Eventos)

Interfaz genérica que abstrae el sistema de mensajería. Inicialmente usa EventEmitter de Node.js, pero los módulos nunca lo saben.

- **Métodos:** publish(channel, payload) y subscribe(channel, handler), ambos async.
- **Serialización:** Todo payload es un String JSON puro. Prohibido enviar funciones, instancias de clases o referencias en memoria.
- **Migración futura:** Reemplazable por RabbitMQ o Redis Pub/Sub con impacto cero en el código de negocio.

#### 1.7.3. Logger

Servicio de logging inyectable. En producción escribe a archivos/consola. En tests puede ser un mock silencioso o un colector para assertions.

---

## 2. Reglas de Diseño Innegociables

### 2.1. Inyección de Dependencias Explícita

Cada módulo recibe TODAS sus dependencias por constructor. Nunca importa directamente una implementación concreta (base de datos, bus de eventos, cliente CCXT, TimeProvider, Logger). Esto permite inyectar mocks en tests unitarios e implementaciones reales en producción sin modificar el código del módulo.

### 2.2. Patrón Adaptador para Eventos

Se usa una interfaz genérica MessageBroker. Los módulos consumidores y productores nunca conocen la implementación subyacente.

### 2.3. Serialización Estricta

Todo mensaje enviado al bus es un String JSON puro. Prohibido enviar funciones, instancias de clases o referencias en memoria. Esto garantiza compatibilidad con sistemas de mensajería distribuidos.

### 2.4. Asincronía por Defecto

Todos los métodos de publicación y suscripción (publish, subscribe) usan async/await.

### 2.5. Contrato de Estrategia (StrategyBase)

Toda estrategia debe implementar esta interfaz sin excepción. El contrato define tres propiedades obligatorias:

- **id:** Identificador único de la estrategia (string).
- **requiredTimeframes:** Array de temporalidades que la estrategia necesita (ej. ['1m', '15m', '4h']). El DataProvider usa esto para saber qué datos cargar.
- **evaluate(MarketState):** Método asíncrono que recibe el estado de mercado completo y retorna un SignalGroup (que contiene uno o más TradePlans con su política de relación), o null si no hay señal. Una vela puede generar múltiples señales simultáneas (ej. un LONG en un nivel y un SHORT en otro), y la política de cómo se relacionan es decisión exclusiva de la estrategia.

Agregar una nueva estrategia se reduce a: crear un archivo, implementar la interfaz, registrarla en el StrategyRegistry. Cero modificaciones al resto del sistema.

### 2.6. Acceso a Datos vía Repositorio

Ningún módulo de negocio (estrategia, simulador, runner) accede directamente a tablas de base de datos. Todo acceso pasa por interfaces de repositorio (CandleRepository, TradeRepository, ExecutionRepository). Esto permite cambiar el esquema de almacenamiento, migrar a otro motor de BD, o inyectar repositorios in-memory para tests sin impactar la lógica de negocio.

---

## 3. Detalles de Implementación Profundos

### 3.1. Estructura del Objeto SignalGroup

Cuando una estrategia detecta una oportunidad, emite un SignalGroup al bus de eventos vía el evento SIGNAL_GENERATED. Un SignalGroup agrupa una o más señales que nacen del mismo evento de mercado y define la política de relación entre ellas. Esto es responsabilidad exclusiva de la estrategia.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| group_id | UUID | Identificador único del grupo |
| strategy_id | String | ID de la estrategia que generó el grupo |
| symbol | String | Par de trading (ej. BTC/USDT) |
| timestamp | Number | Timestamp vía TimeProvider |
| group_policy | Enum | Política de relación entre señales del grupo (ver detalle abajo) |
| signals | Array\<TradePlan\> | Lista de TradePlans individuales (1 o más) |

**Políticas de Grupo (group_policy):**

- **SEQUENTIAL:** Las señales son complementarias y pueden coexistir. Si el precio llega primero a la zona de venta, se ejecuta el SHORT. Si luego llega a la zona de compra, puede cerrar la venta (o parte) y abrir el LONG. Ambas señales viven de forma independiente una vez emitidas.
- **EXCLUSIVE:** Las señales son mutuamente excluyentes. Cuando una señal del grupo se llena (orden ejecutada), las demás se cancelan automáticamente. Útil cuando la estrategia quiere apostar solo a una dirección pero no sabe cuál llegará primero.
- **INDEPENDENT:** Las señales no tienen relación entre sí. Se procesan como si fueran de eventos separados. Cada una vive y muere por su cuenta. Es el comportamiento por defecto para estrategias que emiten una sola señal.

La política es decisión de la estrategia, no del motor. Una misma estrategia puede emitir un grupo SEQUENTIAL en un contexto y un grupo EXCLUSIVE en otro, dependiendo de sus condiciones internas. El ExecutionEngine (o FillSimulator en backtest) solo necesita respetar la política al gestionar fills.

### 3.2. Estructura del Objeto TradePlan (El Contrato)

Cada TradePlan individual dentro de un SignalGroup tiene esta estructura:

| Campo | Tipo | Descripción |
|-------|------|-------------|
| id | UUID | Identificador único de la señal |
| group_id | UUID | Referencia al SignalGroup padre |
| symbol | String | Par de trading (ej. BTC/USDT) |
| action | Enum | LONG o SHORT |
| strategy_id | String | ID de la estrategia que generó la señal |
| entry_price | Number | Precio objetivo de entrada (para órdenes Limit) |
| timestamp | Number | Timestamp vía TimeProvider (no Date.now()) |
| risk_params.sl_price | Number | Precio del Stop Loss rígido |
| risk_params.context_score | Enum | Fuerza de tendencia (STRONG_BULLISH, etc.) |
| risk_params.take_profits | Array | Lista de TPs con level, price y percentage |

Nota: Un precio null en take_profits indica un Runner (porcentaje que se deja correr hasta recibir señal técnica de salida). El campo entry_price es necesario para que el PositionSizer calcule la distancia al SL y determine el tamaño de la posición.

### 3.3. Position Sizing (Dimensionamiento de Posición)

Define cuántas unidades comprar o vender en cada operación. Es un submódulo del Risk Manager que se ejecuta entre la emisión de la señal y la colocación de la orden. Sin esta pieza, ni el backtest ni el live pueden funcionar con métricas reales.

**Fórmula base — Riesgo Fijo por Trade:**

El tamaño de posición se calcula con la fórmula: `Position Size = (Capital Disponible × Riesgo por Trade) / Distancia al SL`. Donde Capital Disponible es el capital no comprometido en posiciones abiertas, Riesgo por Trade es un porcentaje fijo configurable (ej. 1%, 1.5%, 2%), y Distancia al SL es el valor absoluto de la diferencia entre el precio de entrada y el Stop Loss.

**Ejemplo concreto:**

Capital disponible: 10,000 USDT. Riesgo por trade: 1.5% (150 USDT). Entry price: 64,000. SL price: 63,800. Distancia al SL: 200 USDT. Position size: 150 / 200 = 0.75 unidades. Si el SL se toca, la pérdida es exactamente 150 USDT (1.5% del capital). Este cálculo es idéntico en live y en backtest.

**Parámetros configurables del PositionSizer:**

| Parámetro | Tipo | Descripción |
|-----------|------|-------------|
| risk_per_trade | Number | Porcentaje máximo de capital a arriesgar por operación (ej. 0.015 = 1.5%) |
| min_position_size | Number | Tamaño mínimo de posición permitido por el exchange (ej. 0.001 BTC) |
| max_position_size | Number | Tamaño máximo de posición sin importar el cálculo (techo de seguridad) |
| use_available_capital | Boolean | Si true, usa solo capital no comprometido. Si false, usa capital total (más agresivo) |

Si el tamaño calculado es menor que min_position_size del exchange, la señal se descarta con estado CANCELED y razón INSUFFICIENT_SIZE. Esto se registra en el backtest como una señal válida que no pudo ejecutarse por restricción de capital.

### 3.4. Exposure Manager (Gestión de Exposición Simultánea)

Controla cuánto capital puede estar expuesto al mercado en cualquier momento. Se ejecuta antes del PositionSizer como un filtro de admisión. Si la señal no pasa el filtro de exposición, nunca llega al cálculo de tamaño.

**Tres niveles de protección:**

- **Nivel 1 — Capital total en riesgo:** Suma del riesgo de todas las posiciones abiertas. No puede exceder un porcentaje máximo del capital total (ej. 6%). Si abrir una nueva posición supera este límite, la señal se encola o descarta.
- **Nivel 2 — Posiciones concurrentes:** Número máximo de posiciones abiertas simultáneamente (ej. 3-4). Protege contra sobreexposición en mercados volátiles donde muchas señales se activan a la vez.
- **Nivel 3 — Exposición por símbolo:** Número máximo de posiciones abiertas en el mismo par (ej. 2). Evita concentración excesiva en un solo activo.

**Parámetros configurables del ExposureManager:**

| Parámetro | Tipo | Descripción |
|-----------|------|-------------|
| max_total_risk_pct | Number | Porcentaje máximo de capital total en riesgo simultáneo (ej. 0.06 = 6%) |
| max_concurrent_positions | Number | Máximo de posiciones abiertas al mismo tiempo |
| max_positions_per_symbol | Number | Máximo de posiciones por par de trading |
| on_limit_reached | Enum | Acción cuando se alcanza un límite: DISCARD (descarta la señal) o QUEUE (encola para reevaluar cuando se libere espacio) |

El ExposureManager es especialmente importante en backtest. Sin estos límites, el simulador asume capital infinito y las métricas no reflejan la realidad operativa. Cuando una señal se descarta por límites de exposición, se registra con estado REJECTED y razón específica (MAX_RISK, MAX_POSITIONS, o MAX_SYMBOL) para poder analizar cuántas oportunidades se perdieron por restricción de capital.

**Interacción con SignalGroup:**

Cuando llega un SignalGroup con múltiples señales, el ExposureManager evalúa el grupo completo antes de admitir señales individuales. En política EXCLUSIVE solo reserva cupo para una posición (ya que solo una se llenará). En política SEQUENTIAL reserva cupo para todas las señales del grupo. Si el grupo completo no cabe dentro de los límites, se puede admitir parcialmente (ej. solo la primera señal) dependiendo de la configuración.

### 3.5. Estructura del Objeto FillResult

El FillSimulator retorna este objeto por cada nivel evaluado:

| Campo | Tipo | Descripción |
|-------|------|-------------|
| level_hit | Enum | ENTRY, SL, TP1, TP2, TP3, EXPIRED |
| timestamp | Number | Timestamp exacto (de la vela granular que tocó el nivel, o de la vela de estrategia en modo pesimista) |
| expected_price | Number | Precio teórico del nivel |
| actual_fill_price | Number | Precio real de fill (puede diferir por gap/slippage en modo preciso, o igual a expected en modo pesimista) |
| slippage | Number | Diferencia entre expected y actual (en unidades de precio) |
| resolution_mode | Enum | PRECISE_1S (resuelto con velas de 1s), PRECISE_1M (resuelto con velas de 1m), PESSIMISTIC (sin datos granulares, peor escenario asumido) |
| had_ambiguity | Boolean | Indica si SL y algún TP caían dentro del rango de la misma vela. Solo relevante en modo PESSIMISTIC para saber cuántos fills fueron penalizados |

### 3.6. Estructura del Objeto BacktestReport

Resultado final de una corrida de backtesting:

| Campo | Tipo | Descripción |
|-------|------|-------------|
| strategy_id | String | Estrategia evaluada |
| symbol | String | Par evaluado |
| period | Object | Rango de fechas (from, to) |
| initial_capital | Number | Capital inicial simulado |
| final_capital | Number | Capital al cierre de la simulación |
| total_trades | Number | Cantidad total de operaciones |
| win_rate | Number | Porcentaje de trades ganadores |
| profit_factor | Number | Ganancia bruta / Pérdida bruta |
| max_drawdown | Number | Máxima caída porcentual desde un pico |
| sharpe_ratio | Number | Retorno ajustado por riesgo |
| sortino_ratio | Number | Retorno ajustado por riesgo a la baja |
| expectancy | Number | Ganancia esperada por trade |
| tp_breakdown | Object | Rendimiento desglosado por cada nivel de TP |
| resolution_confidence | Object | Porcentaje de fills resueltos por cada modo: precise_1s, precise_1m, pessimistic. Indica la confiabilidad general de la corrida |
| pessimistic_penalties | Number | Cantidad de fills donde se asumió peor escenario por ambigüedad sin datos granulares |
| rejected_signals | Object | Señales descartadas por límites de exposición, desglosadas por razón (MAX_RISK, MAX_POSITIONS, MAX_SYMBOL, INSUFFICIENT_SIZE) |
| group_policy_stats | Object | Estadísticas por política de grupo: cuántos EXCLUSIVE cancelaron la señal hermana, cuántos SEQUENTIAL generaron trades complementarios |
| trades | Array | Lista detallada de cada trade con fills |

### 3.7. Máquina de Estados (Ciclo de Vida de la Orden)

El flujo de una operación es estrictamente unidireccional para facilitar la auditoría:

| Estado | Descripción | Aplica en Backtest |
|--------|-------------|-------------------|
| PENDING_ENTRY | Evento emitido, esperando confirmación de llenado inicial | Sí (vía FillSimulator) |
| OPEN | Orden inicial llenada. SL y TPs colocados y vivos | Sí |
| PARTIALLY_CLOSED | TP1 alcanzado. SL se mueve a Break Even | Sí |
| CLOSED | Operación finalizada (por SL, todos los TPs o salida por señal) | Sí |
| CANCELED / EXPIRED | El gatillo se activó pero la orden no se llenó | Sí (por timeout simulado) |
| REJECTED | Señal descartada por ExposureManager (límites) o PositionSizer (tamaño insuficiente). Se registra con razón específica | Sí (crítico para métricas realistas) |
| ORPHANED / ERROR | Estado crítico gestionado por el Sync Worker | No aplica |

### 3.8. Estructura Relacional Base (PostgreSQL)

El modelo utiliza un esquema Padre-Hijo para evaluar estadísticamente el rendimiento de las tomas parciales:

- **Tabla Trades (Padre):** Almacena el ID, strategy_id, group_id, dirección, SL inicial, position_size, estado de la máquina de estados, y flag is_backtest para distinguir trades simulados de reales.
- **Tabla Executions (Hijo):** Almacena cada llenado individual (Entrada, TP1, TP2, Salida Final) vinculado al ID del Trade padre. Incluye expected_price y actual_fill_price para medir slippage.
- **Tabla Signal_Groups:** Registro de cada grupo de señales emitido, con su group_policy (SEQUENTIAL, EXCLUSIVE, INDEPENDENT). Vincula las señales hermanas para auditar la relación entre trades del mismo evento.
- **Tabla Rejected_Signals:** Registro de señales válidas que no se ejecutaron por límites de exposición o tamaño insuficiente. Almacena la razón (MAX_RISK, MAX_POSITIONS, MAX_SYMBOL, INSUFFICIENT_SIZE) para analizar oportunidades perdidas.
- **Tabla Backtest_Runs:** Registro de cada corrida de backtesting con parámetros (estrategia, símbolo, rango, capital, configuración de riesgo y exposición) y métricas resultado.
- **Tabla Candles_1s / Candles_1m (Datos Históricos):** Almacenamiento de velas históricas indexadas por símbolo y timestamp. Consultadas exclusivamente a través del CandleRepository.

**Fuente de datos existente (market-tracker, solo lectura):**

NesxTrader no descarga velas de Binance. Los datos históricos se leen de la base de datos existente de market-tracker a través del CandleRepository:

- `binance_candles`: velas de 1m de múltiples cryptos. Columnas: symbol, timeframe, timestamp (integer), open, high, low, close, volume, quote_asset_volume, number_of_trades, taker_buy_base_volume, taker_buy_quote_volume.
- `binance_klines_1s`: velas de 1 segundo (solo BTC/USDT y ETH/USDT). Columnas: symbol, open_time (bigint), open_timestamp (timestamptz), open_price, high_price, low_price, close_price, volume, close_time, quote_asset_volume, trades_count, taker_buy_base_volume, taker_buy_quote_volume.
- Vistas materializadas en schema `analytics`: candles_5m, candles_10m, candles_15m, candles_30m, candles_1h, candles_2h, candles_4h, candles_8h, candles_12h, candles_1d. Columnas: bucket, open_time, close_time, symbol, open, high, low, close, volume.

El CandleRepository absorbe las diferencias de nombres de columnas entre tablas y expone un formato normalizado al resto del sistema. Las tablas propias de NesxTrader (trades, executions, signal_groups, etc.) viven en un schema separado (`nesxtrader`) dentro de la misma instancia PostgreSQL.

---

## 4. Flujo Completo de Backtesting

El backtesting es la piedra angular para validar si una estrategia es rentable antes de arriesgar capital real. El flujo completo es el siguiente:

### 4.1. Inicialización

1. El BacktestRunner recibe la configuración: estrategia(s), símbolo, rango de fechas, capital inicial, parámetros de riesgo (risk_per_trade) y límites de exposición (max_total_risk, max_positions).
2. Configura el TimeProvider en modo simulado (timestamp inicial = inicio del rango).
3. Conecta el DataProvider en modo Replay (carga velas del CandleRepository en vez de WebSocket).
4. Sustituye el ExecutionEngine real por el FillSimulator.
5. Inicializa el ExposureManager y PositionSizer con los parámetros de la corrida.
6. Inicializa el StrategyEngine con la(s) estrategia(s) del StrategyRegistry.

### 4.2. Ciclo de Evaluación

1. El DataProvider (Replay) emite CANDLE_CLOSED con la siguiente vela histórica.
2. El StrategyEngine evalúa el MarketState actualizado y, si hay señal, emite SIGNAL_GENERATED con un SignalGroup (uno o más TradePlans con su group_policy).
3. El ExposureManager recibe el SignalGroup y evalúa si las señales caben dentro de los límites. Señales que no pasan se registran como REJECTED con su razón. En política EXCLUSIVE solo reserva cupo para una posición.
4. Para cada señal admitida, el PositionSizer calcula el tamaño de posición basado en el capital disponible, el riesgo por trade y la distancia al SL. Si el tamaño es menor al mínimo del exchange, la señal se descarta como INSUFFICIENT_SIZE.
5. El FillSimulator recibe cada TradePlan con su position_size calculado, consulta las velas granulares desde el timestamp de la señal, y resuelve qué nivel se toca primero (entrada, SL, TPs).
6. Para cada fill, el FillSimulator emite los mismos eventos que el ExecutionEngine real (ORDER_FILLED, SL_HIT, TP_HIT). En política EXCLUSIVE, si una señal se llena, emite GROUP_SIGNAL_CANCELED para las hermanas.
7. El capital disponible se actualiza tras cada fill (liberando riesgo en SL/TP, sumando/restando PnL). El ExposureManager refleja las posiciones abiertas actuales.
8. El TimeProvider avanza al timestamp de la siguiente vela. El ciclo se repite hasta agotar el rango.

### 4.3. Generación de Resultados

1. Al finalizar el rango, el MetricsCalculator procesa todos los trades registrados.
2. Calcula las métricas de rendimiento (win rate, profit factor, sharpe, drawdown, desglose por TP).
3. Si se ejecutaron múltiples estrategias, genera ranking comparativo.
4. Persiste el BacktestReport en la tabla Backtest_Runs para referencia histórica.

---

## 5. Estrategia de Testeabilidad

Gracias a la inyección de dependencias y las interfaces de repositorio, cada módulo es testeable en aislamiento total.

### 5.1. Tests Unitarios

| Módulo | Qué se testea | Dependencias mockeadas |
|--------|---------------|----------------------|
| StrategyEngine | Que emite SignalGroup correcto dado un MarketState específico | MessageBroker, TimeProvider |
| FillSimulator | Que resuelve fills correctamente dados niveles y velas de 1s, y que aplica modo pesimista sin datos granulares | CandleRepository, TimeProvider |
| RiskManager | Que calcula SL/TP correctos dado un context_score | Ninguna (lógica pura) |
| PositionSizer | Que calcula tamaño correcto dado capital, riesgo y distancia al SL. Que rechaza posiciones bajo el mínimo | Ninguna (lógica pura) |
| ExposureManager | Que admite/rechaza señales según límites. Que reserva cupo correcto por group_policy (1 para EXCLUSIVE, N para SEQUENTIAL) | TradeRepository mock |
| MetricsCalculator | Que calcula métricas correctas dado un set de trades | Ninguna (lógica pura) |
| PositionManager | Que detecta órdenes huérfanas y fuerza cierre | DB mock, CCXT mock |

### 5.2. Tests de Integración

Usan una base de datos PostgreSQL de test (contenedor Docker dedicado) y el bus de eventos real. Validan que los módulos se comunican correctamente a través del bus y que los trades se persisten con la estructura Padre-Hijo esperada.

### 5.3. Tests de Backtesting (Regression)

Corridas de backtest con datos históricos conocidos y resultados esperados predefinidos. Si un cambio en el código altera los resultados de una corrida de regression, el test falla. Esto protege contra modificaciones accidentales en la lógica de estrategia o simulación.

---

## 6. Ciclo de Vida de una Nueva Estrategia

El proceso para implementar y validar una nueva estrategia es:

1. **Crear el archivo:** Implementar StrategyBase con id, requiredTimeframes, y evaluate().
2. **Registrar:** Agregarlo al StrategyRegistry (una línea en la configuración).
3. **Backtestear:** Ejecutar el BacktestRunner contra datos históricos. Revisar métricas en el BacktestReport.
4. **Comparar:** Ejecutar la nueva estrategia junto con las existentes contra los mismos datos. Ranking por Sharpe y Profit Factor.
5. **Dry Run:** Si las métricas son aceptables, activar en modo Dry Run contra datos en vivo (sin capital real).
6. **Live:** Una vez validada en Dry Run, activar en modo Live.

En ningún paso se modifica código existente fuera del archivo de la estrategia y la configuración del registry.

---

## 7. Infraestructura y Despliegue

- **Aislamiento:** El bot opera en un entorno Dockerizado.
- **Persistencia:** PostgreSQL/TimescaleDB en su propio contenedor. El historial, tradelog y datos de velas de 1s/1m sobreviven a cualquier reinicio.
- **Resiliencia:** El contenedor de Node.js usa restart: always para disparar el Crash Recovery ante fallos fatales.
- **Testing:** Contenedor PostgreSQL dedicado para tests de integración, levantado y destruido automáticamente en cada suite.

---

## 8. Catálogo Oficial de Eventos (Event Dictionary)

Este catálogo es el contrato formal del bus de eventos. Define exactamente qué eventos existen, quién los emite, quién los consume y qué payload llevan. Ningún módulo debe emitir o escuchar un evento que no esté registrado aquí. Todo payload es un String JSON puro (regla de serialización estricta).

### 8.1. Eventos de Mercado (Market Data)

Mantienen el latido del sistema. Son de alta frecuencia, especialmente en modo WebSocket.

#### MARKET_CANDLE_CLOSED

| Atributo | Detalle |
|----------|---------|
| Emisor | Data Provider (Streamer en live, Replay en backtest) |
| Consumidores | Strategy Engine (recalcula indicadores), Position Manager (actualiza valor del portafolio) |
| Frecuencia | Una vez por cierre de vela en cada timeframe activo |

**Payload:**

| Campo | Tipo | Descripción |
|-------|------|-------------|
| symbol | String | Par de trading (ej. BTC/USDT) |
| timeframe | String | Temporalidad de la vela (1m, 5m, 15m, 1h, 4h) |
| timestamp | Number | Timestamp del cierre de vela (vía TimeProvider) |
| ohlcv.open | Number | Precio de apertura |
| ohlcv.high | Number | Precio máximo |
| ohlcv.low | Number | Precio mínimo |
| ohlcv.close | Number | Precio de cierre |
| ohlcv.volume | Number | Volumen de la vela |

### 8.2. Eventos de Estrategia (Strategy & Signals)

Comunican las decisiones del cerebro analítico al resto del sistema.

#### STRATEGY_ZONE_ARMED

| Atributo | Detalle |
|----------|---------|
| Emisor | Strategy Engine (cuando el precio entra en zona proyectada en HTF) |
| Consumidores | Notification Engine (alerta de vigilancia) |
| Descripción | Indica que se está vigilando una zona de posible reversión. No genera orden, solo alerta |

**Payload:**

| Campo | Tipo | Descripción |
|-------|------|-------------|
| symbol | String | Par de trading |
| zone_price | Number | Precio central de la zona proyectada |
| bias | Enum | Dirección esperada (LONG o SHORT) |
| timeframe_htf | String | Temporalidad mayor que proyectó la zona |
| strategy_id | String | Estrategia que generó la zona |
| timestamp | Number | Timestamp vía TimeProvider |

#### STRATEGY_ZONE_DISARMED

| Atributo | Detalle |
|----------|---------|
| Emisor | Strategy Engine (cuando la zona de vigilancia expira sin confirmación LTF) |
| Consumidores | Notification Engine (alerta de cancelación de vigilancia) |
| Descripción | Indica que la zona armada ya no es válida. El precio salió de la zona sin gatillo o se invalidó por nueva estructura |

**Payload:**

| Campo | Tipo | Descripción |
|-------|------|-------------|
| symbol | String | Par de trading |
| zone_price | Number | Precio de la zona que se desarmó |
| reason | Enum | Razón: EXPIRED (tiempo), INVALIDATED (estructura rota), PRICE_LEFT_ZONE |
| strategy_id | String | Estrategia que había armado la zona |
| timestamp | Number | Timestamp vía TimeProvider |

#### STRATEGY_SIGNAL_GENERATED

| Atributo | Detalle |
|----------|---------|
| Emisor | Strategy Engine (cuando indicadores LTF confirman el gatillo) |
| Consumidores | Exposure Manager (filtro de admisión), Execution Engine (enruta orden), Notification Engine |
| Descripción | Emite un SignalGroup completo. Puede contener 1 o más TradePlans con su política de grupo |

**Payload:**

| Campo | Tipo | Descripción |
|-------|------|-------------|
| group_id | UUID | ID único del grupo de señales |
| strategy_id | String | Estrategia que generó las señales |
| symbol | String | Par de trading |
| timestamp | Number | Timestamp vía TimeProvider |
| group_policy | Enum | SEQUENTIAL, EXCLUSIVE, o INDEPENDENT |
| signals | Array\<TradePlan\> | Lista de TradePlans individuales con entry_price, action, risk_params |

### 8.3. Eventos de Ejecución (Lifecycle / FSM)

Estos eventos cambian el estado en la base de datos del tradelog y actualizan la máquina de estados. En backtest, el FillSimulator emite exactamente los mismos eventos, haciendo el flujo indistinguible del modo live.

#### EXECUTION_SIGNAL_REJECTED

| Atributo | Detalle |
|----------|---------|
| Emisor | Exposure Manager o Position Sizer |
| Consumidores | Motor de BD (registra en Rejected_Signals), Notification Engine (alerta INFO) |
| Descripción | Una señal válida no pudo ejecutarse por restricciones de capital o exposición |

**Payload:**

| Campo | Tipo | Descripción |
|-------|------|-------------|
| trade_id | UUID | ID de la señal rechazada |
| group_id | UUID | ID del grupo al que pertenece |
| symbol | String | Par de trading |
| action | Enum | LONG o SHORT |
| reject_reason | Enum | MAX_RISK, MAX_POSITIONS, MAX_SYMBOL, INSUFFICIENT_SIZE |
| detail | String | Descripción legible (ej. 'Total risk 6.2% exceeds limit 6%') |
| timestamp | Number | Timestamp vía TimeProvider |

#### EXECUTION_TRADE_OPENED

| Atributo | Detalle |
|----------|---------|
| Emisor | Execution Engine (cuando el exchange confirma el llenado de la orden de entrada y coloca las OCO) |
| Consumidores | Position Manager (empieza a auditar), Motor de BD (crea registro Padre en Trades) |
| Descripción | Confirma que la orden de entrada fue llenada y la posición está activa |

**Payload:**

| Campo | Tipo | Descripción |
|-------|------|-------------|
| trade_id | UUID | ID único del trade |
| group_id | UUID | Referencia al SignalGroup padre |
| exchange_order_id | String | ID de la orden en el exchange (null en backtest) |
| symbol | String | Par de trading |
| action | Enum | LONG o SHORT |
| entry_price | Number | Precio real de llenado |
| position_size | Number | Tamaño de posición calculado por PositionSizer |
| sl_price | Number | Stop Loss colocado |
| timestamp | Number | Timestamp vía TimeProvider |

#### EXECUTION_PARTIAL_FILLED

| Atributo | Detalle |
|----------|---------|
| Emisor | Execution Engine, Sync Worker, o FillSimulator (en backtest) |
| Consumidores | Motor de BD (inserta registro Hijo en Executions), Strategy Engine (señal para mover SL), Notification Engine |
| Descripción | Un nivel de Take Profit fue alcanzado. La posición se redujo parcialmente |

**Payload:**

| Campo | Tipo | Descripción |
|-------|------|-------------|
| trade_id | UUID | ID del trade padre |
| level_hit | Number | Nivel de TP alcanzado (1, 2, 3) |
| fill_price | Number | Precio real de llenado del TP |
| expected_price | Number | Precio teórico del TP |
| realized_pnl | Number | Ganancia/pérdida realizada en esta porción |
| remaining_size | Number | Tamaño restante de la posición |
| resolution_mode | Enum | PRECISE_1S, PRECISE_1M, PESSIMISTIC (solo relevante en backtest) |
| timestamp | Number | Timestamp vía TimeProvider |

#### EXECUTION_SL_MOVED

| Atributo | Detalle |
|----------|---------|
| Emisor | Execution Engine (tras recibir EXECUTION_PARTIAL_FILLED de TP1) |
| Consumidores | Position Manager (actualiza nivel de SL que audita), Motor de BD (actualiza SL en tabla Trades), Notification Engine |
| Descripción | El Stop Loss se movió a Break Even (o a otro nivel) tras alcanzar TP1. Protege la ganancia parcial |

**Payload:**

| Campo | Tipo | Descripción |
|-------|------|-------------|
| trade_id | UUID | ID del trade |
| previous_sl | Number | Precio anterior del SL |
| new_sl | Number | Nuevo precio del SL (típicamente el entry_price para Break Even) |
| reason | Enum | TP1_HIT (Break Even), TRAILING, MANUAL |
| timestamp | Number | Timestamp vía TimeProvider |

#### EXECUTION_GROUP_CANCELED

| Atributo | Detalle |
|----------|---------|
| Emisor | Execution Engine o FillSimulator (cuando en política EXCLUSIVE una señal del grupo se llena) |
| Consumidores | Motor de BD (actualiza señales hermanas a CANCELED), Notification Engine |
| Descripción | Se cancelan las señales hermanas de un SignalGroup con política EXCLUSIVE porque una ya fue ejecutada |

**Payload:**

| Campo | Tipo | Descripción |
|-------|------|-------------|
| group_id | UUID | ID del grupo |
| filled_trade_id | UUID | ID de la señal que se llenó (la ganadora) |
| canceled_trade_ids | Array\<UUID\> | IDs de las señales canceladas |
| group_policy | Enum | Siempre EXCLUSIVE en este evento |
| timestamp | Number | Timestamp vía TimeProvider |

#### EXECUTION_TRADE_CLOSED

| Atributo | Detalle |
|----------|---------|
| Emisor | Execution Engine, Sync Worker, o FillSimulator |
| Consumidores | Position Manager (deja de auditar), Motor de BD (actualiza estado Padre a CLOSED), Exposure Manager (libera cupo), Notification Engine |
| Descripción | La operación finalizó completamente. Puede ser por SL, todos los TPs alcanzados, o señal técnica de salida |

**Payload:**

| Campo | Tipo | Descripción |
|-------|------|-------------|
| trade_id | UUID | ID del trade |
| group_id | UUID | ID del grupo al que pertenece |
| close_reason | Enum | SL_HIT, ALL_TPS_HIT, SIGNAL_EXIT, FORCED_CLOSE, SYNC_CORRECTION |
| exit_price | Number | Precio de cierre final |
| total_realized_pnl | Number | PnL total de la operación (sumando todas las ejecuciones parciales) |
| position_size | Number | Tamaño original de la posición |
| resolution_mode | Enum | Modo de resolución (solo en backtest) |
| timestamp | Number | Timestamp vía TimeProvider |

### 8.4. Eventos de Sistema y Auditoría

Vitales para la salud del bot y la resiliencia operativa.

#### SYSTEM_SYNC_DISCREPANCY

| Atributo | Detalle |
|----------|---------|
| Emisor | Position Manager (Sync Worker) |
| Consumidores | Execution Engine (ejecuta Market Order de emergencia), Notification Engine (alerta CRITICAL) |
| Descripción | El estado local (BD) no coincide con la realidad del exchange. Requiere acción correctiva inmediata |

**Payload:**

| Campo | Tipo | Descripción |
|-------|------|-------------|
| trade_id | UUID | ID del trade afectado |
| expected_state | Enum | Estado esperado según la BD local |
| actual_exchange_state | Enum | Estado real en el exchange |
| discrepancy_type | Enum | ORPHANED_ORDER, MISSING_SL, MISSING_TP, SIZE_MISMATCH |
| timestamp | Number | Timestamp vía TimeProvider |

#### SYSTEM_CRITICAL_ERROR

| Atributo | Detalle |
|----------|---------|
| Emisor | Cualquier módulo que capture un error fatal |
| Consumidores | Notification Engine (alerta CRITICAL urgente), proceso principal de Node.js (log y posible process.exit(1) para que Docker reinicie) |
| Descripción | Error irrecuperable que puede requerir reinicio del sistema |

**Payload:**

| Campo | Tipo | Descripción |
|-------|------|-------------|
| module | String | Módulo que generó el error |
| error_code | String | Código de error (ej. EXCHANGE_RATE_LIMIT, DB_CONNECTION_LOST) |
| message | String | Descripción legible del error |
| recoverable | Boolean | Si el sistema puede intentar recuperarse o necesita reinicio |
| timestamp | Number | Timestamp vía TimeProvider |

### Resumen del Catálogo

| Evento | Emisor Principal | Consumidores |
|--------|-----------------|-------------|
| MARKET_CANDLE_CLOSED | Data Provider | Strategy Engine, Position Manager |
| STRATEGY_ZONE_ARMED | Strategy Engine | Notification Engine |
| STRATEGY_ZONE_DISARMED | Strategy Engine | Notification Engine |
| STRATEGY_SIGNAL_GENERATED | Strategy Engine | Exposure Manager, Execution Engine, Notification Engine |
| EXECUTION_SIGNAL_REJECTED | Exposure Manager / PositionSizer | Motor BD, Notification Engine |
| EXECUTION_TRADE_OPENED | Execution Engine | Position Manager, Motor BD |
| EXECUTION_PARTIAL_FILLED | Execution Engine / FillSimulator | Motor BD, Strategy Engine, Notification Engine |
| EXECUTION_SL_MOVED | Execution Engine | Position Manager, Motor BD, Notification Engine |
| EXECUTION_GROUP_CANCELED | Execution Engine / FillSimulator | Motor BD, Notification Engine |
| EXECUTION_TRADE_CLOSED | Execution Engine / FillSimulator | Position Manager, Motor BD, Exposure Manager, Notification Engine |
| SYSTEM_SYNC_DISCREPANCY | Position Manager | Execution Engine, Notification Engine |
| SYSTEM_CRITICAL_ERROR | Cualquier módulo | Notification Engine, Proceso principal |

Todos los eventos son idénticos en modo Live, Dry Run y Backtest. La única diferencia es quién los emite (Execution Engine en live vs FillSimulator en backtest) y campos opcionales como resolution_mode que solo son relevantes en backtest. Ningún consumidor necesita saber en qué modo está operando el sistema.