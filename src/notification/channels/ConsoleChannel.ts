/**
 * ConsoleChannel.ts
 *
 * Canal de notificacion que escribe en la consola del proceso.
 * Siempre disponible — no requiere configuracion externa.
 * Util en desarrollo y como fallback cuando Telegram no esta configurado.
 *
 * Formato de salida:
 *   [NOTIFICATION] [LEVEL] [ISO timestamp] mensaje
 *
 * Implementa la interfaz NotificationChannel:
 *   async send(message) — message: { text: string, level: 'info'|'warn'|'error' }
 */

import type { TimeProvider, NotificationMessage } from '../../types.js';

interface ConsoleChannelOptions {
  timeProvider?: TimeProvider;
}

class ConsoleChannel {
  private _timeProvider: TimeProvider | null;

  constructor(opts: ConsoleChannelOptions = {}) {
    this._timeProvider = opts.timeProvider ?? null;
  }

  /**
   * Envia un mensaje a la consola.
   */
  async send(message: NotificationMessage): Promise<void> {
    const { text, level = 'info' } = message;

    const ts = this._timeProvider
      ? new Date(this._timeProvider.now()).toISOString()
      : new Date().toISOString();

    const prefix = `[NOTIFICATION] [${level.toUpperCase()}] [${ts}]`;

    switch (level) {
      case 'error':
        console.error(`${prefix} ${text}`);
        break;
      case 'warn':
        console.warn(`${prefix} ${text}`);
        break;
      default:
        console.log(`${prefix} ${text}`);
    }
  }
}

export default ConsoleChannel;
