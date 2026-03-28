/**
 * ReplayProvider.ts
 *
 * Modo backtest: reproduce datos históricos emitiendo exactamente los mismos
 * eventos que el DataProvider en modo live (MARKET_CANDLE_CLOSED).
 *
 * El StrategyEngine NO puede distinguir si los datos vienen del DataProvider
 * o del ReplayProvider — la firma del payload es idéntica.
 *
 * El TimeProvider se avanza a cada openTime de la vela antes de emitir,
 * garantizando coherencia temporal en toda la simulación.
 *
 * Uso:
 *   const replay = new ReplayProvider({ repository, messageBroker, timeProvider });
 *   await replay.replay('BTCUSDT', '15m', from, to);
 */

import type { Candle, MessageBroker, Logger } from '../types.js';

/**
 * ReplayProvider requires a TimeProvider that supports setTime(), so we define
 * a stricter local interface rather than the optional variant from types.ts.
 */
interface ReplayTimeProvider {
  now(): number;
  setTime(ms: number): void;
}

interface Repository {
  getCandles(symbol: string, timeframe: string, from: number, to: number): Promise<Candle[]>;
}

interface ReplayProviderDeps {
  repository: Repository;
  messageBroker: MessageBroker;
  timeProvider: ReplayTimeProvider;
  logger?: Logger;
}

interface Subscription {
  symbol: string;
  timeframe: string;
}

class ReplayProvider {
  private _repository: Repository;
  private _broker: MessageBroker;
  private _timeProvider: ReplayTimeProvider;
  private _logger: Logger;

  constructor({ repository, messageBroker, timeProvider, logger }: ReplayProviderDeps) {
    if (!repository)    throw new Error('ReplayProvider: se requiere repository');
    if (!messageBroker) throw new Error('ReplayProvider: se requiere messageBroker');
    if (!timeProvider)  throw new Error('ReplayProvider: se requiere timeProvider');

    if (typeof timeProvider.setTime !== 'function') {
      throw new Error(
        'ReplayProvider: timeProvider debe implementar setTime(ms) para avanzar el tiempo del backtest'
      );
    }

    this._repository   = repository;
    this._broker       = messageBroker;
    this._timeProvider = timeProvider;
    this._logger       = logger ?? {
      info:  (...a: unknown[]) => console.log('[ReplayProvider]', ...a),
      warn:  (...a: unknown[]) => console.warn('[ReplayProvider]', ...a),
      error: (...a: unknown[]) => console.error('[ReplayProvider]', ...a),
    };
  }

  /**
   * Itera sobre el histórico en orden cronológico estricto y emite
   * MARKET_CANDLE_CLOSED por cada vela.
   *
   * @param symbol
   * @param timeframe
   * @param from - Timestamp de inicio en ms (inclusive)
   * @param to   - Timestamp de fin en ms (inclusive)
   * @returns Cantidad de eventos emitidos
   */
  async replay(symbol: string, timeframe: string, from: number, to: number): Promise<number> {
    if (typeof from !== 'number' || typeof to !== 'number') {
      throw new Error('ReplayProvider.replay: from y to deben ser timestamps en ms');
    }
    if (from > to) {
      throw new Error(
        `ReplayProvider.replay: from (${from}) no puede ser mayor que to (${to})`
      );
    }

    this._logger.info(
      `Iniciando replay ${symbol}/${timeframe} ` +
      `${new Date(from).toISOString()} → ${new Date(to).toISOString()}`
    );

    const candles = await this._repository.getCandles(symbol, timeframe, from, to);

    if (candles.length === 0) {
      this._logger.warn(`Replay ${symbol}/${timeframe}: sin velas en el rango solicitado`);
      return 0;
    }

    // Verificar orden cronológico — el repositorio ya ordena ASC, pero lo
    // validamos explícitamente para garantizar el invariante del backtest.
    this._assertChronologicalOrder(candles, symbol, timeframe);

    let emitted = 0;

    for (const candle of candles) {
      // Avanzar el reloj del backtest al momento de esta vela ANTES de emitir.
      // Esto garantiza que cualquier módulo que llame timeProvider.now() durante
      // el procesamiento del evento recibe el timestamp correcto de la simulación.
      this._timeProvider.setTime(candle.openTime);

      const payload = {
        symbol:    candle.symbol,
        timeframe: candle.timeframe,
        timestamp: this._timeProvider.now(),
        candle:    candle as unknown as Record<string, unknown>,
      };

      await this._broker.publish('MARKET_CANDLE_CLOSED', payload);
      emitted += 1;
    }

    this._logger.info(
      `Replay ${symbol}/${timeframe} completado — ${emitted} velas emitidas`
    );

    return emitted;
  }

  /**
   * Versión multi-símbolo: reproduce varios pares en paralelo intercalando
   * los eventos en orden cronológico global.
   *
   * Útil cuando el StrategyEngine necesita más de un símbolo para decidir
   * (ej. correlaciones). Los eventos se intercalan por openTime ASC.
   *
   * @param subscriptions - Pares y timeframes a reproducir
   * @param from - Timestamp de inicio en ms
   * @param to   - Timestamp de fin en ms
   * @returns Total de eventos emitidos
   */
  async replayMulti(subscriptions: Subscription[], from: number, to: number): Promise<number> {
    if (from > to) {
      throw new Error(`ReplayProvider.replayMulti: from (${from}) > to (${to})`);
    }

    // Cargar todas las velas para todos los pares
    const allCandleArrays = await Promise.all(
      subscriptions.map(({ symbol, timeframe }) =>
        this._repository.getCandles(symbol, timeframe, from, to)
      )
    );

    // Aplanar y ordenar por openTime ASC (orden cronológico global)
    const allCandles = allCandleArrays
      .flat()
      .sort((a, b) => a.openTime - b.openTime);

    if (allCandles.length === 0) {
      this._logger.warn('replayMulti: sin velas en el rango solicitado');
      return 0;
    }

    let emitted = 0;

    for (const candle of allCandles) {
      this._timeProvider.setTime(candle.openTime);

      const payload = {
        symbol:    candle.symbol,
        timeframe: candle.timeframe,
        timestamp: this._timeProvider.now(),
        candle:    candle as unknown as Record<string, unknown>,
      };

      await this._broker.publish('MARKET_CANDLE_CLOSED', payload);
      emitted += 1;
    }

    this._logger.info(`replayMulti completado — ${emitted} velas emitidas`);
    return emitted;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private _assertChronologicalOrder(candles: Candle[], symbol: string, timeframe: string): void {
    for (let i = 1; i < candles.length; i++) {
      if (candles[i].openTime <= candles[i - 1].openTime) {
        throw new Error(
          `ReplayProvider: velas fuera de orden cronológico en ${symbol}/${timeframe}. ` +
          `Índice ${i}: openTime=${candles[i].openTime} <= anterior=${candles[i - 1].openTime}`
        );
      }
    }
  }
}

export default ReplayProvider;
