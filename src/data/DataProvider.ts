/**
 * DataProvider.ts
 *
 * Orquesta el bootstrap REST y el streaming WebSocket de Binance.
 * Emite MARKET_CANDLE_CLOSED al MessageBroker por cada vela cerrada.
 *
 * Ciclo de vida:
 *   1. start(symbols, timeframes):
 *      a. Para cada (symbol, timeframe), carga BOOTSTRAP_CANDLES velas via REST
 *         y emite MARKET_CANDLE_CLOSED para cada una (con isClosed=true)
 *      b. Inicia el WebSocket — solo las velas con isClosed=true generan evento
 *
 *   2. stop():
 *      Desconecta el WebSocket.
 *
 * El DataProvider NO sabe si el sistema está en modo Live o Dry Run.
 * Para Backtest, el BacktestEngine usa ReplayProvider en su lugar.
 */

import type { Candle, MessageBroker, TimeProvider, Logger } from '../types.js';

interface Adapter {
  fetchKlines(symbol: string, timeframe: string, limit: number): Promise<Candle[]>;
  connectWebSocket(
    subscriptions: Array<{ symbol: string; timeframe: string }>,
    onCandle: (candle: Candle) => void
  ): void;
  disconnectWebSocket(): void;
}

interface Repository {
  getCandles(symbol: string, timeframe: string, from: number, to: number): Promise<Candle[]>;
}

interface DataProviderDeps {
  adapter: Adapter;
  repository: Repository;
  messageBroker: MessageBroker;
  timeProvider: TimeProvider;
  logger?: Logger;
  bootstrapCandles?: number;
}

const BOOTSTRAP_CANDLES = 500;

class DataProvider {
  private _adapter: Adapter;
  private _repository: Repository;
  private _broker: MessageBroker;
  private _timeProvider: TimeProvider;
  private _bootstrapCandles: number;
  private _logger: Logger;
  private _running: boolean;

  constructor({ adapter, repository, messageBroker, timeProvider, logger, bootstrapCandles }: DataProviderDeps) {
    if (!adapter)       throw new Error('DataProvider: se requiere adapter');
    if (!repository)    throw new Error('DataProvider: se requiere repository');
    if (!messageBroker) throw new Error('DataProvider: se requiere messageBroker');
    if (!timeProvider)  throw new Error('DataProvider: se requiere timeProvider');

    this._adapter          = adapter;
    this._repository       = repository;
    this._broker           = messageBroker;
    this._timeProvider     = timeProvider;
    this._bootstrapCandles = bootstrapCandles ?? BOOTSTRAP_CANDLES;
    this._logger           = logger ?? {
      info:  (...a: unknown[]) => console.log('[DataProvider]', ...a),
      warn:  (...a: unknown[]) => console.warn('[DataProvider]', ...a),
      error: (...a: unknown[]) => console.error('[DataProvider]', ...a),
    };

    this._running = false;
  }

  /**
   * Inicia el DataProvider: bootstrap REST + WebSocket streaming.
   *
   * @param symbols    - Ej. ['BTCUSDT', 'ETHUSDT']
   * @param timeframes - Ej. ['1m', '15m', '4h']
   */
  async start(symbols: string[], timeframes: string[]): Promise<void> {
    if (this._running) {
      this._logger.warn('DataProvider ya está corriendo — ignorando start()');
      return;
    }

    this._running = true;
    this._logger.info(`Iniciando para ${symbols.length} símbolos, ${timeframes.length} timeframes`);

    // 1. Bootstrap: descarga velas históricas para cada (symbol, timeframe)
    await this._bootstrap(symbols, timeframes);

    // 2. WebSocket: streaming en tiempo real
    const subscriptions: Array<{ symbol: string; timeframe: string }> = [];
    for (const symbol of symbols) {
      for (const timeframe of timeframes) {
        subscriptions.push({ symbol, timeframe });
      }
    }

    this._adapter.connectWebSocket(subscriptions, (candle) => {
      this._handleLiveCandle(candle);
    });

    this._logger.info('Bootstrap completo. WebSocket activo.');
  }

  /**
   * Detiene el DataProvider y cierra el WebSocket.
   */
  async stop(): Promise<void> {
    if (!this._running) return;
    this._running = false;
    this._adapter.disconnectWebSocket();
    this._logger.info('DataProvider detenido');
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async _bootstrap(symbols: string[], timeframes: string[]): Promise<void> {
    const pairs: Array<{ symbol: string; timeframe: string }> = [];
    for (const symbol of symbols) {
      for (const timeframe of timeframes) {
        pairs.push({ symbol, timeframe });
      }
    }

    // Bootstrap secuencial para no saturar la API de Binance
    for (const { symbol, timeframe } of pairs) {
      try {
        this._logger.info(`Bootstrap ${symbol}/${timeframe} (${this._bootstrapCandles} velas)`);
        const candles = await this._adapter.fetchKlines(
          symbol,
          timeframe,
          this._bootstrapCandles
        );

        for (const candle of candles) {
          await this._emitCandleClosed(candle);
        }

        this._logger.info(`Bootstrap ${symbol}/${timeframe} OK — ${candles.length} velas emitidas`);
      } catch (err) {
        this._logger.error(
          `Bootstrap ${symbol}/${timeframe} falló: ${(err as Error).message} — continuando con los demás`
        );
      }
    }
  }

  private _handleLiveCandle(candle: Candle): void {
    if (!candle.isClosed) {
      // Vela en progreso: no emitir evento (solo velas cerradas generan señales)
      return;
    }
    this._emitCandleClosed(candle).catch(err => {
      this._logger.error(`Error emitiendo MARKET_CANDLE_CLOSED: ${(err as Error).message}`);
    });
  }

  private async _emitCandleClosed(candle: Candle): Promise<void> {
    const payload = {
      symbol:    candle.symbol,
      timeframe: candle.timeframe,
      timestamp: this._timeProvider.now(),
      candle:    candle as unknown as Record<string, unknown>,
    };

    await this._broker.publish('MARKET_CANDLE_CLOSED', payload);
  }
}

export default DataProvider;
