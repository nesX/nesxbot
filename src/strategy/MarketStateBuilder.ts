import type { Candle, MarketState, TimeProvider, Logger } from '../types.js';

/**
 * MarketStateBuilder.ts
 *
 * Construye y mantiene actualizado el MarketState para cada par/timeframe.
 * Consume eventos MARKET_CANDLE_CLOSED y acumula velas en una ventana deslizante.
 *
 * Diseño:
 *   - Una instancia gestiona todos los símbolos y timeframes activos.
 *   - Por cada (symbol, timeframe) mantiene un buffer circular de tamaño configurable.
 *   - El MarketState se construye bajo demanda llamando a build(symbol, timeframes).
 *   - El TimeProvider se inyecta para que el timestamp del estado sea coherente
 *     con el reloj del sistema (sea real o simulado en backtest).
 *
 * El MarketStateBuilder NO sabe qué estrategias existen ni qué timeframes necesitan.
 * Esa decisión la toma el StrategyEngine al llamar build().
 */

interface MarketStateBuilderDeps {
  timeProvider: TimeProvider;
  maxCandles?: number;
  logger?: Logger;
}

interface CandlePayload {
  symbol: string;
  timeframe: string;
  candle: Candle;
}

class MarketStateBuilder {
  private _timeProvider: TimeProvider;
  _maxCandles: number;
  private _logger: Logger;

  /** Almacén de velas indexado por clave "symbol:timeframe". */
  private _buffers: Map<string, Candle[]>;

  constructor({ timeProvider, maxCandles, logger }: MarketStateBuilderDeps) {
    if (!timeProvider || typeof timeProvider.now !== 'function') {
      throw new Error('MarketStateBuilder: se requiere timeProvider con método now()');
    }

    this._timeProvider = timeProvider;
    this._maxCandles   = (typeof maxCandles === 'number' && maxCandles > 0)
      ? maxCandles
      : 500;
    this._logger       = logger ?? {
      info:  (...a: unknown[]) => console.log('[MarketStateBuilder]', ...a),
      warn:  (...a: unknown[]) => console.warn('[MarketStateBuilder]', ...a),
      error: (...a: unknown[]) => console.error('[MarketStateBuilder]', ...a),
    };

    this._buffers = new Map();
  }

  /**
   * Procesa una vela cerrada y la agrega al buffer correspondiente.
   * Llamado por el StrategyEngine al recibir MARKET_CANDLE_CLOSED.
   */
  addCandle({ symbol, timeframe, candle }: Partial<CandlePayload>): void {
    if (!symbol || !timeframe || !candle) {
      this._logger.warn(
        'MarketStateBuilder.addCandle: payload incompleto — ignorando',
        { symbol, timeframe, hasCandle: !!candle }
      );
      return;
    }

    const key    = this._key(symbol, timeframe);
    const buffer = this._getOrCreateBuffer(key);

    buffer.push(candle);

    // Mantener el buffer dentro del tamaño máximo (ventana deslizante)
    if (buffer.length > this._maxCandles) {
      buffer.shift();
    }
  }

  /**
   * Construye un objeto MarketState para un símbolo dado con los timeframes solicitados.
   * Si algún timeframe aún no tiene velas, retorna un array vacío para ese timeframe.
   */
  build(symbol: string, timeframes: string[]): MarketState {
    if (!symbol) {
      throw new Error('MarketStateBuilder.build: se requiere symbol');
    }
    if (!Array.isArray(timeframes) || timeframes.length === 0) {
      throw new Error('MarketStateBuilder.build: timeframes debe ser un array no vacío');
    }

    const candles: Record<string, Candle[]> = {};
    for (const tf of timeframes) {
      const key    = this._key(symbol, tf);
      const buffer = this._buffers.get(key);
      // Retorna una copia shallow del array para que la estrategia no mute el buffer
      candles[tf] = buffer ? buffer.slice() : [];
    }

    // currentPrice = close de la última vela disponible entre todos los timeframes.
    // Se toma el timeframe de mayor granularidad (primer elemento de la lista si están
    // ordenados de menor a mayor, aunque la estrategia declara el orden).
    // Usamos el timeframe que tenga la vela más reciente.
    const currentPrice = this._resolveCurrentPrice(symbol, timeframes);

    return {
      symbol,
      timestamp:    this._timeProvider.now(),
      candles,
      currentPrice,
    };
  }

  /**
   * Retorna cuántas velas hay almacenadas para un (symbol, timeframe).
   * Útil para pruebas y diagnóstico.
   */
  getCandleCount(symbol: string, timeframe: string): number {
    const key    = this._key(symbol, timeframe);
    const buffer = this._buffers.get(key);
    return buffer ? buffer.length : 0;
  }

  /**
   * Elimina todos los buffers almacenados. Útil entre runs de backtest.
   */
  reset(): void {
    this._buffers.clear();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private _key(symbol: string, timeframe: string): string {
    return `${symbol}:${timeframe}`;
  }

  private _getOrCreateBuffer(key: string): Candle[] {
    if (!this._buffers.has(key)) {
      this._buffers.set(key, []);
    }
    return this._buffers.get(key)!;
  }

  /**
   * Determina el precio actual buscando la vela más reciente entre todos
   * los timeframes disponibles para el símbolo.
   *
   * @returns close de la vela más reciente, o 0 si no hay datos
   */
  private _resolveCurrentPrice(symbol: string, timeframes: string[]): number {
    let latestCandle: Candle | null = null;

    for (const tf of timeframes) {
      const key    = this._key(symbol, tf);
      const buffer = this._buffers.get(key);
      if (!buffer || buffer.length === 0) continue;

      const last = buffer[buffer.length - 1];
      if (!latestCandle || last.openTime > latestCandle.openTime) {
        latestCandle = last;
      }
    }

    return latestCandle ? latestCandle.close : 0;
  }
}

export default MarketStateBuilder;
