/**
 * TelegramChannel.ts
 *
 * Canal de notificacion que envia mensajes via Telegram Bot API.
 * Utiliza fetch nativo de Node.js 20+ (sin dependencias externas).
 *
 * Retry policy:
 *   - Hasta maxRetries intentos ante errores de red (5xx, timeout, ECONNRESET)
 *   - Backoff lineal entre reintentos (retryDelayMs * intento)
 *   - Errores 4xx se consideran no recuperables (token invalido, chat no encontrado)
 *     y no se reintenta
 *
 * Implementa la interfaz NotificationChannel:
 *   async send(message) — message: { text: string, level: 'info'|'warn'|'error' }
 *
 * Lanzar excepciones desde send() esta permitido — NotificationEngine las captura
 * y las loggea sin propagarlas.
 */

import type { TimeProvider, Logger, NotificationMessage } from '../../types.js';

interface TelegramChannelOptions {
  botToken: string;
  chatId: string | number;
  maxRetries?: number;
  retryDelayMs?: number;
  timeProvider?: TimeProvider;
  logger?: Logger;
}

/** Error interno con statusCode para distinguir errores HTTP */
class TelegramHttpError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

class TelegramChannel {
  private _botToken: string;
  private _chatId: string;
  private _maxRetries: number;
  private _retryDelayMs: number;
  private _timeProvider: TimeProvider | null;
  private _logger: Logger;
  private _apiBase: string;

  constructor({
    botToken,
    chatId,
    maxRetries = 3,
    retryDelayMs = 500,
    timeProvider,
    logger,
  }: TelegramChannelOptions) {
    if (!botToken) throw new Error('TelegramChannel: se requiere botToken');
    if (!chatId)   throw new Error('TelegramChannel: se requiere chatId');

    this._botToken     = botToken;
    this._chatId       = String(chatId);
    this._maxRetries   = maxRetries;
    this._retryDelayMs = retryDelayMs;
    this._timeProvider = timeProvider ?? null;
    this._logger       = logger ?? {
      info:  (...a: unknown[]) => console.log('[TelegramChannel]', ...a),
      warn:  (...a: unknown[]) => console.warn('[TelegramChannel]', ...a),
      error: (...a: unknown[]) => console.error('[TelegramChannel]', ...a),
    };

    this._apiBase = `https://api.telegram.org/bot${this._botToken}`;
  }

  /**
   * Envia un mensaje via Telegram.
   * Reintenta ante errores transitorios (red, 5xx) con backoff lineal.
   */
  async send(message: NotificationMessage): Promise<void> {
    const { text } = message;

    let lastError: Error = new Error('unknown error');

    for (let attempt = 1; attempt <= this._maxRetries + 1; attempt++) {
      try {
        await this._sendRequest(text);
        return; // exito
      } catch (err) {
        lastError = err as Error;

        // Errores 4xx: no recuperables — no reintentar
        if (err instanceof TelegramHttpError && err.statusCode >= 400 && err.statusCode < 500) {
          throw new Error(
            `TelegramChannel: error no recuperable (HTTP ${err.statusCode}) — ${err.message}`
          );
        }

        if (attempt <= this._maxRetries) {
          const delay = this._retryDelayMs * attempt;
          this._logger.warn(
            `TelegramChannel: intento ${attempt} fallido — reintentando en ${delay}ms. ` +
            `Error: ${lastError.message}`
          );
          await this._sleep(delay);
        }
      }
    }

    throw new Error(
      `TelegramChannel: todos los reintentos fallaron (${this._maxRetries + 1} intentos). ` +
      `Ultimo error: ${lastError.message}`
    );
  }

  // ---------------------------------------------------------------------------
  // Internos
  // ---------------------------------------------------------------------------

  /**
   * Realiza una llamada POST a la API de Telegram.
   */
  private async _sendRequest(text: string): Promise<void> {
    const url  = `${this._apiBase}/sendMessage`;
    const body = JSON.stringify({
      chat_id:    this._chatId,
      text,
      parse_mode: 'Markdown',
    });

    let response: Response;
    try {
      response = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal:  AbortSignal.timeout(10_000), // timeout de 10s
      });
    } catch (networkErr) {
      // Error de red (timeout, ECONNRESET, etc.)
      throw new Error(`Error de red al contactar Telegram: ${(networkErr as Error).message}`);
    }

    if (!response.ok) {
      throw new TelegramHttpError(
        `Telegram API respondio con HTTP ${response.status}`,
        response.status,
      );
    }
  }

  /**
   * Pausa la ejecucion por `ms` milisegundos.
   */
  private _sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default TelegramChannel;
