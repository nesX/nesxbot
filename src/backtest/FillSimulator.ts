import { randomUUID } from 'crypto';
import type { TradePlan, Candle, FillResult, ExitFill, TakeProfit, TimeProvider, Logger, GranularDataInfo } from '../types.js';

// Slippage por defecto en modo PESSIMISTIC cuando no hay datos granulares.
// Expresado como fracción del precio de entrada (0.0005 = 0.05%).
const DEFAULT_SLIPPAGE_FRACTION = 0.0005;

// Cantidad máxima de días a conservar en el cache de velas 1s.
// Cada día ocupa ~3-4 MB de RAM (86 400 velas × 5 columnas numéricas).
const MAX_1S_CACHE_DAYS = 30;

type ResolutionMode = 'PRECISE_1S' | 'PRECISE_1M' | 'PESSIMISTIC';

interface CandleRepository {
  hasGranularData(symbol: string, from: number, to: number): Promise<GranularDataInfo>;
  getCandles(symbol: string, timeframe: string, from: number, to: number): Promise<Candle[]>;
}

/** Cierre parcial o final de una posición con su peso relativo. */
interface StagedFill {
  price: number;
  timestamp: number;
  type: string;
  tpLevel: number | null;
  sizePercent: number;
  hadAmbiguity: boolean;
}

class FillSimulator {
  private _repo: CandleRepository;
  private _timeProvider: TimeProvider;
  private _logger: Logger;
  /** Comisión taker por lado, en % del notional (ej: 0.04 = 0.04%). 0 = sin fees. */
  private _takerFeePercent: number;

  /**
   * Cache de velas 1s agrupadas por día.
   * Clave: `symbol:YYYY-MM-DD`
   * Valor: array de velas del día completo, ordenadas por openTime ASC.
   *
   * Se usa un Map para mantener el orden de inserción y poder evictar entradas
   * viejas con una política LRU sencilla cuando se supera MAX_1S_CACHE_DAYS.
   */
  private _cache1s = new Map<string, Candle[]>();

  /**
   * Cache de resultados de hasGranularData.
   * Clave: `symbol:from:to`
   * Valor: GranularDataInfo
   */
  private _granularCache = new Map<string, GranularDataInfo>();

  constructor({ candleRepository, timeProvider, logger, takerFeePercent }: {
    candleRepository: CandleRepository;
    timeProvider: TimeProvider;
    logger?: Logger;
    takerFeePercent?: number;
  }) {
    if (!candleRepository || typeof (candleRepository as CandleRepository).hasGranularData !== 'function') {
      throw new Error('FillSimulator: se requiere candleRepository con método hasGranularData()');
    }
    if (!timeProvider || typeof (timeProvider as TimeProvider).now !== 'function') {
      throw new Error('FillSimulator: se requiere timeProvider con método now()');
    }

    this._repo            = candleRepository;
    this._timeProvider    = timeProvider;
    this._takerFeePercent = takerFeePercent && takerFeePercent > 0 ? takerFeePercent : 0;
    this._logger       = logger || {
      info:  (...a: unknown[]) => console.log('[FillSimulator]', ...a),
      warn:  (...a: unknown[]) => console.warn('[FillSimulator]', ...a),
      error: (...a: unknown[]) => console.error('[FillSimulator]', ...a),
    };
  }

  /**
   * Simula el fill completo de un trade (entrada + salida) sobre datos históricos.
   * Soporta cierres parciales: al tocar TP1 cierra sizePercent% y mueve SL a breakeven,
   * luego continúa buscando TP2 o el nuevo SL en las velas siguientes.
   */
  async simulateFill(tradePlan: TradePlan, contextCandle: Candle): Promise<FillResult> {
    this._validateTradePlan(tradePlan);
    this._validateContextCandle(contextCandle);

    const tradeId = randomUUID();

    // La señal solo es accionable cuando la vela de contexto CIERRA. Por eso la
    // entrada se busca a partir del cierre de esa vela (openTime + su duración),
    // nunca dentro de su propio período — eso sería lookahead (rellenar a un precio
    // que existió antes de que la señal se conociera). Ver docs/audit (H1).
    const tfMs = this._timeframeToMs(contextCandle.timeframe);
    const from = contextCandle.openTime + tfMs;
    const to   = from + 24 * 60 * 60 * 1000; // +24h de tiempo operable

    const granularity = await this._hasGranularDataCached(tradePlan.symbol, from, to);

    let fillResult: FillResult;

    if (granularity.has1s) {
      fillResult = await this._simulatePrecise(
        tradeId, tradePlan, contextCandle, from, to, '1s', 'PRECISE_1S'
      );
    } else if (granularity.has1m) {
      fillResult = await this._simulatePrecise(
        tradeId, tradePlan, contextCandle, from, to, '1m', 'PRECISE_1M'
      );
    } else {
      fillResult = this._simulatePessimistic(tradeId, tradePlan, contextCandle);
    }

    this._logger.info(
      `FillSimulator [${fillResult.resolution_mode}] trade=${tradeId} ` +
      `${tradePlan.symbol} ${tradePlan.direction} ` +
      `pnl=${fillResult.pnl.toFixed(2)} ` +
      `exit=${fillResult.exitFill.type}` +
      (fillResult.partialFills.length > 0 ? ` partials=${fillResult.partialFills.length}` : '') +
      (fillResult.had_ambiguity ? ' [AMBIGUOUS]' : '')
    );

    return fillResult;
  }

  // ---------------------------------------------------------------------------
  // Modos de resolución
  // ---------------------------------------------------------------------------

  private async _simulatePrecise(
    tradeId: string,
    tradePlan: TradePlan,
    contextCandle: Candle,
    from: number,
    to: number,
    timeframe: string,
    mode: ResolutionMode
  ): Promise<FillResult> {
    const candles = timeframe === '1s'
      ? await this._getCandles1sCached(tradePlan.symbol, from, to)
      : await this._repo.getCandles(tradePlan.symbol, timeframe, from, to);

    if (candles.length === 0) {
      this._logger.warn(
        `FillSimulator: ${mode} solicitado pero getCandles devolvió 0 velas. ` +
        `Fallback a PESSIMISTIC.`
      );
      return this._simulatePessimistic(tradeId, tradePlan, contextCandle);
    }

    // Buscar el primer candle donde el precio realmente toca la zona de entrada.
    // Para LONG: precio cae hasta entryPrice (low <= entryPrice).
    // Para SHORT: precio sube hasta entryPrice (high >= entryPrice).
    // Guard anti-lookahead explícito: solo velas en/después de `from` (= cierre de
    // la vela de señal). Redundante con el filtro de la query en producción, pero
    // garantiza la invariante aunque el repositorio no filtre (ver docs/audit H1).
    const entryConditionMet = (c: Candle) =>
      c.openTime >= from && (
        tradePlan.direction === 'LONG'
          ? c.low  <= tradePlan.entryPrice
          : c.high >= tradePlan.entryPrice
      );

    const entryIdx = candles.findIndex(entryConditionMet);

    if (entryIdx === -1) {
      // La zona nunca fue tocada en los datos granulares — fallback a PESSIMISTIC
      this._logger.warn(
        `FillSimulator: zona de entrada no tocada en datos ${mode}. Fallback a PESSIMISTIC.`
      );
      return this._simulatePessimistic(tradeId, tradePlan, contextCandle);
    }

    const entryCandle    = candles[entryIdx];
    const slippage       = this._estimateSlippage(tradePlan.entryPrice, entryCandle);
    const entryPrice     = tradePlan.direction === 'LONG'
      ? tradePlan.entryPrice + slippage
      : tradePlan.entryPrice - slippage;
    const entryTimestamp = entryCandle.openTime;

    // Escanear para TP/SL a partir del candle de entrada (inclusive)
    const candlesFromEntry = candles.slice(entryIdx);
    const stagedFills = this._findExitMultiStage(tradePlan, entryPrice, candlesFromEntry, false);

    return this._buildFillResult(tradeId, tradePlan, entryPrice, entryTimestamp, slippage, stagedFills, mode);
  }

  private _simulatePessimistic(tradeId: string, tradePlan: TradePlan, contextCandle: Candle): FillResult {
    const slippage    = tradePlan.entryPrice * DEFAULT_SLIPPAGE_FRACTION;
    const entryPrice  = tradePlan.direction === 'LONG'
      ? tradePlan.entryPrice + slippage
      : tradePlan.entryPrice - slippage;
    const entryTimestamp = contextCandle.openTime;

    const stagedFills = this._findExitMultiStage(tradePlan, entryPrice, [contextCandle], true);

    return this._buildFillResult(tradeId, tradePlan, entryPrice, entryTimestamp, slippage, stagedFills, 'PESSIMISTIC');
  }

  // ---------------------------------------------------------------------------
  // Lógica multi-etapa
  // ---------------------------------------------------------------------------

  /**
   * Recorre las velas buscando TP1, luego TP2..., moviendo el SL a breakeven tras cada TP parcial.
   * Retorna un array de cierres ordenados: [TP1?, TP2?, ..., finalExit].
   */
  private _findExitMultiStage(
    tradePlan: TradePlan,
    entryPrice: number,
    candles: Candle[],
    pessimistic: boolean
  ): StagedFill[] {
    const sortedTps = this._sortedTakeProfits(tradePlan);
    const fills: StagedFill[] = [];

    let currentSL = tradePlan.stopLoss;
    let tpIdx     = 0;

    for (const candle of candles) {
      if (tpIdx >= sortedTps.length) break;

      const currentTp = sortedTps[tpIdx];
      const hit = this._evaluateCandle(tradePlan.direction, currentSL, currentTp, candle, pessimistic);

      if (!hit) continue;

      if (hit.type === 'SL') {
        const remainingSize = sortedTps.slice(tpIdx).reduce((s, tp) => s + tp.sizePercent, 0);
        fills.push({
          price:        hit.price,
          timestamp:    candle.openTime,
          type:         'SL',
          tpLevel:      null,
          sizePercent:  remainingSize,
          hadAmbiguity: hit.hadAmbiguity,
        });
        return fills;
      }

      // TP hit — cierre parcial
      fills.push({
        price:        hit.price,
        timestamp:    candle.openTime,
        type:         this._tpTypeName(currentTp, sortedTps),
        tpLevel:      this._tpIndex(currentTp, sortedTps),
        sizePercent:  currentTp.sizePercent,
        hadAmbiguity: hit.hadAmbiguity,
      });

      tpIdx++;

      // Mover SL a breakeven después del primer TP parcial (si la estrategia lo indica)
      if (tpIdx === 1 && tpIdx < sortedTps.length && tradePlan.moveSlToBreakeven !== false) {
        currentSL = entryPrice;
      }

      if (tpIdx >= sortedTps.length) return fills; // todos los TPs alcanzados
    }

    // Sin más velas — cierre MANUAL del tamaño restante
    if (tpIdx < sortedTps.length) {
      const lastCandle    = candles[candles.length - 1];
      const remainingSize = sortedTps.slice(tpIdx).reduce((s, tp) => s + tp.sizePercent, 0);
      fills.push({
        price:        lastCandle.close,
        timestamp:    lastCandle.openTime,
        type:         'MANUAL',
        tpLevel:      null,
        sizePercent:  remainingSize,
        hadAmbiguity: false,
      });
    }

    return fills;
  }

  /**
   * Evalúa si una vela toca el SL o el TP actual.
   * En caso de ambigüedad (ambos tocados en la misma vela), aplica la heurística de distancia al open,
   * o fuerza SL si pessimistic=true.
   */
  private _evaluateCandle(
    direction: 'LONG' | 'SHORT',
    sl: number,
    tp: TakeProfit,
    candle: Candle,
    pessimistic: boolean
  ): { type: 'SL' | 'TP'; price: number; hadAmbiguity: boolean } | null {
    const { high, low } = candle;

    const slHit = direction === 'LONG' ? low  <= sl       : high >= sl;
    const tpHit = direction === 'LONG' ? high >= tp.price : low  <= tp.price;

    if (!slHit && !tpHit) return null;

    if (slHit && tpHit) {
      if (pessimistic) {
        return { type: 'SL', price: sl, hadAmbiguity: true };
      }
      const distToSl = Math.abs(candle.open - sl);
      const distToTp = Math.abs(candle.open - tp.price);
      if (distToSl <= distToTp) {
        return { type: 'SL', price: sl, hadAmbiguity: true };
      }
      return { type: 'TP', price: tp.price, hadAmbiguity: true };
    }

    if (slHit) return { type: 'SL', price: sl, hadAmbiguity: false };
    return { type: 'TP', price: tp.price, hadAmbiguity: false };
  }

  // ---------------------------------------------------------------------------
  // Construcción del FillResult
  // ---------------------------------------------------------------------------

  private _buildFillResult(
    tradeId: string,
    tradePlan: TradePlan,
    entryPrice: number,
    entryTimestamp: number,
    slippage: number,
    stagedFills: StagedFill[],
    mode: ResolutionMode
  ): FillResult {
    const lastFill     = stagedFills[stagedFills.length - 1];
    const partialFills = stagedFills.slice(0, -1);

    const exitFill: ExitFill = {
      price:     lastFill.price,
      timestamp: lastFill.timestamp,
      type:      lastFill.type,
      tpLevel:   lastFill.tpLevel,
    };

    const partialExitFills: ExitFill[] = partialFills.map(f => ({
      price:     f.price,
      timestamp: f.timestamp,
      type:      f.type,
      tpLevel:   f.tpLevel,
    }));

    const hadAmbiguity = stagedFills.some(f => f.hadAmbiguity);

    return {
      tradeId,
      entryFill: {
        price:     entryPrice,
        timestamp: entryTimestamp,
        slippage,
      },
      partialFills: partialExitFills,
      exitFill,
      pnl:             this._calculatePnlFromFills(tradePlan, entryPrice, stagedFills),
      pnlPercent:      this._pnlPercentFromFills(tradePlan, entryPrice, stagedFills),
      resolution_mode: mode,
      had_ambiguity:   hadAmbiguity,
    };
  }

  // ---------------------------------------------------------------------------
  // Cálculo de PnL ponderado
  // ---------------------------------------------------------------------------

  /**
   * PnL en R-múltiplos ponderado por el sizePercent de cada cierre.
   * Ejemplo: TP1 (50%) a 1R + TP2 (50%) a 2R = 1.5R * riskPercent
   */
  private _calculatePnlFromFills(
    tradePlan: TradePlan,
    entryPrice: number,
    fills: StagedFill[]
  ): number {
    const slDistance = Math.abs(entryPrice - tradePlan.stopLoss);
    if (slDistance === 0) return 0;

    const riskPercent = tradePlan.riskPercent || 1;
    const direction   = tradePlan.direction;

    const grossPnl = fills.reduce((total, fill) => {
      const priceDelta = direction === 'LONG'
        ? fill.price - entryPrice
        : entryPrice - fill.price;
      const rMultiple = priceDelta / slDistance;
      return total + rMultiple * riskPercent * (fill.sizePercent / 100);
    }, 0);

    // Comisiones (round-trip: entrada full + salidas que suman 1 notional).
    // fee% del capital = 2 · feeTaker% · (riskPercent/100) · (entry/slDistance).
    // Para SL 0.5% y risk 1% a 0.04%/lado ≈ 0.16% de comisión por trade.
    const fee = this._takerFeePercent > 0
      ? 2 * this._takerFeePercent * (riskPercent / 100) * (entryPrice / slDistance)
      : 0;

    return grossPnl - fee;
  }

  private _pnlPercentFromFills(
    tradePlan: TradePlan,
    entryPrice: number,
    fills: StagedFill[]
  ): number {
    return fills.reduce((total, fill) => {
      const delta = tradePlan.direction === 'LONG'
        ? fill.price - entryPrice
        : entryPrice - fill.price;
      return total + (delta / entryPrice) * 100 * (fill.sizePercent / 100);
    }, 0);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private _sortedTakeProfits(tradePlan: TradePlan): TakeProfit[] {
    const tps = Array.isArray(tradePlan.takeProfits) ? [...tradePlan.takeProfits] : [];
    if (tradePlan.direction === 'LONG') {
      return tps.sort((a, b) => a.price - b.price);
    }
    return tps.sort((a, b) => b.price - a.price);
  }

  private _tpIndex(tp: TakeProfit, sortedTps: TakeProfit[]): number | null {
    const idx = sortedTps.indexOf(tp);
    return idx >= 0 ? idx + 1 : null;
  }

  private _tpTypeName(tp: TakeProfit, sortedTps: TakeProfit[]): string {
    const idx = this._tpIndex(tp, sortedTps);
    if (idx === null) return 'TP';
    if (idx <= 3) return `TP${idx}`;
    return 'TP';
  }

  /**
   * Duración en ms de un timeframe ('1s', '1m', '15m', '1h', '4h', '1d').
   * Si no se puede parsear, asume 1m (la granularidad de replay del backtest).
   */
  private _timeframeToMs(timeframe: string | undefined): number {
    const ONE_MINUTE_MS = 60_000;
    const match = /^(\d+)([smhd])$/.exec(timeframe ?? '');
    if (!match) return ONE_MINUTE_MS;
    const n    = parseInt(match[1], 10);
    const unit = match[2];
    const factor = unit === 's' ? 1000
      : unit === 'm' ? 60_000
      : unit === 'h' ? 3_600_000
      : 86_400_000; // 'd'
    return n * factor;
  }

  private _estimateSlippage(entryPrice: number, firstCandle: Candle | null): number {
    if (!firstCandle) return entryPrice * DEFAULT_SLIPPAGE_FRACTION;
    const spread    = firstCandle.high - firstCandle.low;
    const estimated = spread * 0.10;
    const minimum   = entryPrice * 0.0001;
    return Math.max(estimated, minimum);
  }

  // ---------------------------------------------------------------------------
  // Cache de datos granulares
  // ---------------------------------------------------------------------------

  /**
   * Versión cacheada de _repo.hasGranularData().
   * La clave incluye symbol + from + to para que rangos distintos no colisionen.
   * El resultado es estable durante un run de backtest (los datos no cambian).
   */
  private async _hasGranularDataCached(
    symbol: string,
    from: number,
    to: number
  ): Promise<GranularDataInfo> {
    const key = `${symbol}:${from}:${to}`;
    const cached = this._granularCache.get(key);
    if (cached !== undefined) return cached;

    const result = await this._repo.hasGranularData(symbol, from, to);
    this._granularCache.set(key, result);
    return result;
  }

  /**
   * Devuelve velas 1s para el rango [from, to] usando un cache día por día.
   *
   * Estrategia:
   * 1. Identificar los días calendario que cubre el rango.
   * 2. Por cada día no cacheado, cargarlo completo desde el repo y guardarlo.
   * 3. Filtrar en memoria el subconjunto [from, to] a partir de los días cacheados.
   *
   * Esta aproximación reduce las queries a PG de una por trade a una por día
   * de datos, con un ahorro típico de 50-70× en grid searches.
   */
  private async _getCandles1sCached(symbol: string, from: number, to: number): Promise<Candle[]> {
    const days = this._daysInRange(from, to);

    for (const dayKey of days) {
      const cacheKey = `${symbol}:${dayKey}`;
      if (!this._cache1s.has(cacheKey)) {
        const { dayFrom, dayTo } = this._dayBounds(dayKey);
        const dayCandles = await this._repo.getCandles(symbol, '1s', dayFrom, dayTo);
        this._evictIfNeeded();
        this._cache1s.set(cacheKey, dayCandles);
      }
    }

    // Consolidar todos los días en un único array filtrado por [from, to]
    const result: Candle[] = [];
    for (const dayKey of days) {
      const cacheKey = `${symbol}:${dayKey}`;
      const dayCandles = this._cache1s.get(cacheKey);
      if (!dayCandles) continue;
      for (const c of dayCandles) {
        if (c.openTime >= from && c.openTime <= to) {
          result.push(c);
        }
      }
    }
    return result;
  }

  /**
   * Retorna los identificadores de día (YYYY-MM-DD UTC) que están comprendidos
   * entre `from` y `to` (ambos en ms).
   */
  private _daysInRange(from: number, to: number): string[] {
    const days: string[] = [];
    // Redondear al inicio del día UTC que contiene `from`
    const startOfDay = new Date(from);
    startOfDay.setUTCHours(0, 0, 0, 0);
    const cursor = new Date(startOfDay);

    while (cursor.getTime() <= to) {
      days.push(cursor.toISOString().slice(0, 10)); // YYYY-MM-DD
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return days;
  }

  /**
   * Calcula los timestamps de inicio y fin (en ms) para un día YYYY-MM-DD UTC.
   */
  private _dayBounds(dayKey: string): { dayFrom: number; dayTo: number } {
    const dayFrom = Date.UTC(
      parseInt(dayKey.slice(0, 4), 10),
      parseInt(dayKey.slice(5, 7), 10) - 1,
      parseInt(dayKey.slice(8, 10), 10),
      0, 0, 0, 0
    );
    const dayTo = dayFrom + 24 * 60 * 60 * 1000 - 1;
    return { dayFrom, dayTo };
  }

  /**
   * Si el cache supera MAX_1S_CACHE_DAYS entradas, elimina la entrada más antigua
   * (la primera del Map, ya que Map preserva el orden de inserción).
   */
  private _evictIfNeeded(): void {
    if (this._cache1s.size >= MAX_1S_CACHE_DAYS) {
      const oldestKey = this._cache1s.keys().next().value;
      if (oldestKey !== undefined) {
        this._cache1s.delete(oldestKey);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Validaciones
  // ---------------------------------------------------------------------------

  private _validateTradePlan(tradePlan: unknown): asserts tradePlan is TradePlan {
    if (!tradePlan) {
      throw new Error('FillSimulator: tradePlan es requerido');
    }
    const plan = tradePlan as Record<string, unknown>;
    const required = ['strategyId', 'symbol', 'direction', 'entryPrice', 'stopLoss', 'takeProfits'];
    for (const field of required) {
      if (plan[field] === undefined || plan[field] === null) {
        throw new Error(`FillSimulator: tradePlan.${field} es requerido`);
      }
    }
    if (!['LONG', 'SHORT'].includes(plan['direction'] as string)) {
      throw new Error(`FillSimulator: tradePlan.direction debe ser 'LONG' o 'SHORT'`);
    }
    if (!Array.isArray(plan['takeProfits']) || (plan['takeProfits'] as unknown[]).length === 0) {
      throw new Error('FillSimulator: tradePlan.takeProfits debe ser un array no vacío');
    }
  }

  private _validateContextCandle(candle: unknown): asserts candle is Candle {
    if (!candle) {
      throw new Error('FillSimulator: contextCandle es requerido');
    }
    const c = candle as Record<string, unknown>;
    const required = ['open', 'high', 'low', 'close', 'openTime'];
    for (const field of required) {
      if (c[field] === undefined || c[field] === null) {
        throw new Error(
          `FillSimulator: contextCandle.${field} es requerido (OHLC completo obligatorio)`
        );
      }
    }
  }
}

export default FillSimulator;
