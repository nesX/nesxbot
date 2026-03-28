/**
 * BinanceAdapter.ts
 *
 * Implementa el acceso a Binance via REST (bootstrap) y WebSocket (streaming).
 * Es la única clase del sistema que conoce el formato de Binance.
 * Toda conversión de formato ocurre en normalizers.ts.
 *
 * Reconexión WebSocket:
 *   - Reintenta con backoff exponencial (base 1s, máximo 60s)
 *   - Después de MAX_RETRIES intentos fallidos, emite SYSTEM_CRITICAL_ERROR
 */

import https from 'https';
import WebSocket from 'ws';
import type { Candle, MessageBroker, TimeProvider, Logger } from '../types.js';
import { normalizeRestKline, normalizeWsKline, timeframeToBinanceInterval } from './normalizers.js';

const BINANCE_REST_HOST = 'api.binance.com';
const BINANCE_WS_BASE   = 'wss://stream.binance.com:9443/stream';

const WS_MAX_RETRIES       = 5;
const WS_BACKOFF_BASE_MS   = 1000;
const WS_BACKOFF_MAX_MS    = 60_000;
const REST_KLINES_ENDPOINT = '/api/v3/klines';
const REST_DEFAULT_LIMIT   = 500;

interface BinanceAdapterDeps {
  messageBroker: MessageBroker;
  timeProvider: TimeProvider;
  logger?: Logger;
}

interface Subscription {
  symbol: string;
  timeframe: string;
}

class BinanceAdapter {
  private _broker: MessageBroker;
  private _timeProvider: TimeProvider;
  private _logger: Logger;
  private _ws: WebSocket | null;
  private _wsRetries: number;
  private _wsReconnecting: boolean;
  private _wsDestroyed: boolean;
  private _candleHandler: ((candle: Candle) => void) | null;
  private _activeStreams: string[];

  constructor({ messageBroker, timeProvider, logger }: BinanceAdapterDeps) {
    if (!messageBroker || typeof messageBroker.publish !== 'function') {
      throw new Error('BinanceAdapter: se requiere messageBroker con método publish()');
    }
    if (!timeProvider || typeof timeProvider.now !== 'function') {
      throw new Error('BinanceAdapter: se requiere timeProvider con método now()');
    }

    this._broker       = messageBroker;
    this._timeProvider = timeProvider;
    this._logger       = logger ?? {
      info:  (...args: unknown[]) => console.log('[BinanceAdapter]', ...args),
      warn:  (...args: unknown[]) => console.warn('[BinanceAdapter]', ...args),
      error: (...args: unknown[]) => console.error('[BinanceAdapter]', ...args),
    };

    this._ws             = null;
    this._wsRetries      = 0;
    this._wsReconnecting = false;
    this._wsDestroyed    = false;
    this._candleHandler  = null;
    this._activeStreams   = [];
  }

  // ---------------------------------------------------------------------------
  // REST
  // ---------------------------------------------------------------------------

  /**
   * Descarga N velas históricas para un símbolo y timeframe via REST.
   *
   * @param symbol
   * @param timeframe
   * @param limit - Máximo 1000 según API de Binance
   */
  async fetchKlines(symbol: string, timeframe: string, limit = REST_DEFAULT_LIMIT): Promise<Candle[]> {
    const interval = timeframeToBinanceInterval(timeframe);
    const path = `${REST_KLINES_ENDPOINT}?symbol=${symbol}&interval=${interval}&limit=${limit}`;

    this._logger.info(`REST fetchKlines ${symbol}/${timeframe} limit=${limit}`);

    const rawKlines = await this._restGet(path) as unknown[][];

    return rawKlines.map(k => normalizeRestKline(k, symbol, timeframe));
  }

  /**
   * Descarga velas históricas dentro de un rango de tiempo.
   *
   * @param symbol
   * @param timeframe
   * @param startTime - ms epoch
   * @param endTime   - ms epoch
   * @param limit
   */
  async fetchKlinesByRange(
    symbol: string,
    timeframe: string,
    startTime: number,
    endTime: number,
    limit = 1000
  ): Promise<Candle[]> {
    const interval = timeframeToBinanceInterval(timeframe);
    const path =
      `${REST_KLINES_ENDPOINT}?symbol=${symbol}&interval=${interval}` +
      `&startTime=${startTime}&endTime=${endTime}&limit=${limit}`;

    this._logger.info(`REST fetchKlinesByRange ${symbol}/${timeframe} ${startTime}→${endTime}`);

    const rawKlines = await this._restGet(path) as unknown[][];
    return rawKlines.map(k => normalizeRestKline(k, symbol, timeframe));
  }

  // ---------------------------------------------------------------------------
  // WebSocket
  // ---------------------------------------------------------------------------

  /**
   * Inicia el streaming WebSocket para los pares y timeframes indicados.
   * Llama a `onCandle` por cada vela recibida (cerrada o en progreso).
   *
   * @param subscriptions
   * @param onCandle - Callback para cada vela normalizada
   */
  connectWebSocket(subscriptions: Subscription[], onCandle: (candle: Candle) => void): void {
    if (typeof onCandle !== 'function') {
      throw new Error('BinanceAdapter.connectWebSocket: onCandle debe ser una función');
    }

    this._candleHandler = onCandle;
    this._wsDestroyed   = false;
    this._wsRetries     = 0;

    // Construir los stream names: <symbol_lower>@kline_<interval>
    this._activeStreams = subscriptions.map(({ symbol, timeframe }) => {
      const interval = timeframeToBinanceInterval(timeframe);
      return `${symbol.toLowerCase()}@kline_${interval}`;
    });

    this._openWebSocket();
  }

  /**
   * Cierra el WebSocket y cancela reconexiones pendientes.
   */
  disconnectWebSocket(): void {
    this._wsDestroyed = true;
    if (this._ws) {
      this._ws.removeAllListeners();
      this._ws.close();
      this._ws = null;
    }
    this._logger.info('WebSocket desconectado manualmente');
  }

  // ---------------------------------------------------------------------------
  // Internals — WebSocket
  // ---------------------------------------------------------------------------

  _buildWsUrl(): string {
    const streams = this._activeStreams.join('/');
    return `${BINANCE_WS_BASE}?streams=${streams}`;
  }

  _openWebSocket(): void {
    if (this._wsDestroyed) return;

    const url = this._buildWsUrl();
    this._logger.info(`WebSocket conectando → ${url}`);

    const ws = new WebSocket(url);
    this._ws = ws;

    ws.on('open', () => {
      this._logger.info('WebSocket conectado');
      this._wsRetries      = 0;
      this._wsReconnecting = false;
    });

    ws.on('message', (raw) => {
      this._handleWsMessage(raw.toString());
    });

    ws.on('error', (err) => {
      this._logger.warn(`WebSocket error: ${err.message}`);
      // El evento 'close' se dispara automáticamente después de 'error' en la librería ws
    });

    ws.on('close', (code, reason) => {
      if (this._wsDestroyed) return;

      this._logger.warn(`WebSocket cerrado (code=${code}, reason=${reason})`);
      this._scheduleReconnect();
    });
  }

  _handleWsMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this._logger.warn(`WebSocket: mensaje no parseable: ${(err as Error).message}`);
      return;
    }

    // Combined stream: { stream: 'btcusdt@kline_1m', data: { e, k, ... } }
    const msg = parsed as Record<string, unknown>;
    const data = (msg['data'] ?? msg) as Record<string, unknown>;
    if (!data || data['e'] !== 'kline' || !data['k']) return;

    let candle: Candle;
    try {
      candle = normalizeWsKline(data['k'] as Record<string, unknown>);
    } catch (err) {
      this._logger.warn(`WebSocket: error normalizando kline: ${(err as Error).message}`);
      return;
    }

    if (typeof this._candleHandler === 'function') {
      this._candleHandler(candle);
    }
  }

  _scheduleReconnect(): void {
    if (this._wsDestroyed || this._wsReconnecting) return;

    this._wsRetries += 1;

    if (this._wsRetries > WS_MAX_RETRIES) {
      this._logger.error(
        `WebSocket: ${WS_MAX_RETRIES} reintentos fallidos — emitiendo SYSTEM_CRITICAL_ERROR`
      );
      this._broker.publish('SYSTEM_CRITICAL_ERROR', {
        source:      'DataProvider',
        message:     `WebSocket de Binance no pudo reconectarse después de ${WS_MAX_RETRIES} intentos`,
        recoverable: false,
      });
      return;
    }

    this._wsReconnecting = true;

    const delay = Math.min(
      WS_BACKOFF_BASE_MS * Math.pow(2, this._wsRetries - 1),
      WS_BACKOFF_MAX_MS
    );

    this._logger.warn(
      `WebSocket: reintento ${this._wsRetries}/${WS_MAX_RETRIES} en ${delay}ms`
    );

    setTimeout(() => {
      this._wsReconnecting = false;
      this._openWebSocket();
    }, delay);
  }

  // ---------------------------------------------------------------------------
  // Internals — REST
  // ---------------------------------------------------------------------------

  /**
   * Realiza una petición GET a la API REST de Binance y devuelve el body parseado.
   *
   * @param path - Path con query string incluido
   */
  _restGet(path: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: BINANCE_REST_HOST,
        path,
        method:  'GET',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent':   'NesxTrader/1.0',
        },
      };

      const req = https.request(options, (res) => {
        const chunks: Buffer[] = [];

        res.on('data', (chunk: Buffer) => chunks.push(chunk));

        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');

          if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
            return reject(
              new Error(
                `BinanceAdapter REST ${res.statusCode}: ${path} → ${body.slice(0, 200)}`
              )
            );
          }

          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch (err) {
            return reject(
              new Error(`BinanceAdapter REST: respuesta no JSON en ${path}: ${(err as Error).message}`)
            );
          }

          resolve(parsed);
        });
      });

      req.on('error', (err: Error) => {
        reject(new Error(`BinanceAdapter REST error de red en ${path}: ${err.message}`));
      });

      req.end();
    });
  }
}

export default BinanceAdapter;
