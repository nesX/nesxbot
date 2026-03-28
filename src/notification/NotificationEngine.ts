/**
 * NotificationEngine.ts
 *
 * Orquestador del modulo Notification.
 *
 * Responsabilidades:
 *   - Suscribirse a eventos relevantes del MessageBroker
 *   - Formatear los payloads de cada evento al texto adecuado
 *   - Enrutar el mensaje formateado a todos los canales registrados
 *   - Aplicar throttling por tipo de evento para evitar spam
 *   - Aislar fallos de canales: un canal que falla no afecta a los demas
 *
 * NO hace:
 *   - Tomar decisiones de trading
 *   - Emitir eventos al MessageBroker (solo consume)
 *   - Operar en modo Backtest (no se instancia en replay)
 *
 * Throttling:
 *   Configurable por tipo de evento via `throttle` en el constructor.
 *   El valor es el minimo de milisegundos entre dos notificaciones del mismo
 *   tipo de evento. Si el intervalo no ha expirado, el evento se descarta
 *   silenciosamente (no produce error).
 *   Por defecto: 60 segundos para todos los eventos no configurados.
 *
 * Canales:
 *   Se pueden agregar con addChannel() antes o despues de start().
 *   ConsoleChannel esta disponible siempre.
 *   TelegramChannel es opcional y se agrega externamente.
 *
 * Ciclo de vida:
 *   start() → suscribe eventos
 *   stop()  → limpia estado interno (suscripciones permanecen activas en el broker,
 *              pero los handlers comprueban this._running antes de actuar)
 */

import type { TimeProvider, MessageBroker, Logger, NotificationMessage } from '../types.js';
import TradeFormatter from './formatters/TradeFormatter.js';
import ErrorFormatter from './formatters/ErrorFormatter.js';

// Eventos que el NotificationEngine escucha y el nivel de cada uno
const EVENT_CONFIG: Record<string, { level: NotificationMessage['level'] }> = {
  STRATEGY_SIGNAL_GENERATED:  { level: 'info'  },
  STRATEGY_ZONE_ARMED:        { level: 'info'  },
  STRATEGY_ZONE_DISARMED:     { level: 'info'  },
  EXECUTION_TRADE_OPENED:     { level: 'info'  },
  EXECUTION_TRADE_CLOSED:     { level: 'info'  },
  EXECUTION_SL_MOVED:         { level: 'info'  },
  EXECUTION_SIGNAL_REJECTED:  { level: 'warn'  },
  SYSTEM_CRITICAL_ERROR:      { level: 'error' },
  SYSTEM_SYNC_DISCREPANCY:    { level: 'warn'  },
};

// Throttling por defecto: 60 segundos entre mensajes del mismo tipo
const DEFAULT_THROTTLE_MS = 60_000;

/** Interfaz minima que deben implementar los canales de salida */
export interface NotificationChannel {
  send(message: NotificationMessage): Promise<void>;
}

interface NotificationEngineOptions {
  messageBroker: MessageBroker;
  timeProvider: TimeProvider;
  throttle?: Record<string, number>;
  logger?: Logger;
}

class NotificationEngine {
  private _broker: MessageBroker;
  private _timeProvider: TimeProvider;
  private _throttleConfig: Record<string, number>;
  _logger: Logger;
  private _channels: NotificationChannel[];
  private _lastSent: Map<string, number>;
  private _running: boolean;

  constructor({
    messageBroker,
    timeProvider,
    throttle = {},
    logger,
  }: NotificationEngineOptions) {
    if (!messageBroker) throw new Error('NotificationEngine: se requiere messageBroker');
    if (!timeProvider)  throw new Error('NotificationEngine: se requiere timeProvider');

    this._broker         = messageBroker;
    this._timeProvider   = timeProvider;
    this._throttleConfig = throttle;
    this._logger         = logger ?? {
      info:  (...a: unknown[]) => console.log('[NotificationEngine]', ...a),
      warn:  (...a: unknown[]) => console.warn('[NotificationEngine]', ...a),
      error: (...a: unknown[]) => console.error('[NotificationEngine]', ...a),
    };

    // Canales de salida registrados
    this._channels = [];

    // Mapa evento → timestamp del ultimo envio exitoso (para throttling)
    this._lastSent = new Map();

    this._running = false;
  }

  // ---------------------------------------------------------------------------
  // Ciclo de vida
  // ---------------------------------------------------------------------------

  /**
   * Inicia el NotificationEngine.
   * Se suscribe a todos los eventos del catalogo.
   */
  start(): void {
    if (this._running) {
      this._logger.warn('NotificationEngine ya esta corriendo — ignorando start()');
      return;
    }

    this._running = true;

    for (const eventName of Object.keys(EVENT_CONFIG)) {
      this._broker.subscribe(eventName, (payload) => {
        return this._handleEvent(eventName, payload).catch(err => {
          this._logger.error(
            `NotificationEngine: error no capturado procesando ${eventName} — ${(err as Error).message}`
          );
        });
      });
    }

    this._logger.info(
      `NotificationEngine iniciado — ` +
      `${this._channels.length} canal(es) | ` +
      `${Object.keys(EVENT_CONFIG).length} eventos suscritos`
    );
  }

  /**
   * Detiene el NotificationEngine.
   * Los handlers de evento comprueban this._running y no actuan si esta detenido.
   * Las suscripciones al MessageBroker permanecen registradas (el broker no
   * expone unsubscribe en la interfaz actual del proyecto).
   */
  stop(): void {
    if (!this._running) return;
    this._running = false;
    this._lastSent.clear();
    this._logger.info('NotificationEngine detenido');
  }

  /**
   * Agrega un canal de salida.
   * Puede llamarse antes o despues de start().
   * El canal debe implementar: async send({ text, level })
   */
  addChannel(channel: NotificationChannel | null | undefined): void {
    if (!channel || typeof (channel as NotificationChannel).send !== 'function') {
      throw new Error('NotificationEngine.addChannel: el canal debe implementar send(message)');
    }
    this._channels.push(channel);
    this._logger.info(
      `NotificationEngine: canal agregado (${(channel as { constructor: { name?: string } }).constructor?.name || 'anonimo'}). ` +
      `Total: ${this._channels.length}`
    );
  }

  // ---------------------------------------------------------------------------
  // Handler central de eventos
  // ---------------------------------------------------------------------------

  /**
   * Procesa un evento del MessageBroker:
   *   1. Verifica que el engine este corriendo
   *   2. Aplica throttling
   *   3. Formatea el mensaje
   *   4. Envia a todos los canales en paralelo
   */
  private async _handleEvent(eventName: string, payload: unknown): Promise<void> {
    if (!this._running) return;

    if (this._channels.length === 0) {
      this._logger.warn(
        `NotificationEngine: evento ${eventName} recibido pero no hay canales registrados`
      );
      return;
    }

    // Throttling
    if (this._isThrottled(eventName)) {
      this._logger.info(
        `NotificationEngine: evento ${eventName} suprimido por throttling`
      );
      return;
    }

    // Formatear
    let text: string;
    try {
      text = this._format(eventName, payload);
    } catch (err) {
      this._logger.error(
        `NotificationEngine: error formateando ${eventName} — ${(err as Error).message}`
      );
      return;
    }

    const level = EVENT_CONFIG[eventName]?.level ?? 'info';
    const message: NotificationMessage = { text, level };

    // Registrar timestamp antes del envio (para que un fallo no resetee el throttle)
    this._lastSent.set(eventName, this._timeProvider.now());

    // Enviar a todos los canales en paralelo; cada fallo se aísla
    const sends = this._channels.map(channel => this._sendToChannel(channel, message, eventName));
    await Promise.all(sends);
  }

  // ---------------------------------------------------------------------------
  // Formatters
  // ---------------------------------------------------------------------------

  /**
   * Selecciona el formatter correcto y retorna el texto listo para enviar.
   */
  private _format(eventName: string, payload: unknown): string {
    switch (eventName) {
      case 'EXECUTION_TRADE_OPENED':
        return TradeFormatter.formatTradeOpened(
          payload as unknown as Parameters<typeof TradeFormatter.formatTradeOpened>[0]
        );

      case 'EXECUTION_TRADE_CLOSED':
        return TradeFormatter.formatTradeClosed(
          payload as unknown as Parameters<typeof TradeFormatter.formatTradeClosed>[0]
        );

      case 'EXECUTION_SL_MOVED':
        return TradeFormatter.formatSLMoved(
          payload as unknown as Parameters<typeof TradeFormatter.formatSLMoved>[0]
        );

      case 'STRATEGY_SIGNAL_GENERATED':
        return TradeFormatter.formatSignalGenerated(
          payload as unknown as Parameters<typeof TradeFormatter.formatSignalGenerated>[0]
        );

      case 'EXECUTION_SIGNAL_REJECTED':
        return TradeFormatter.formatSignalRejected(
          payload as unknown as Parameters<typeof TradeFormatter.formatSignalRejected>[0]
        );

      case 'STRATEGY_ZONE_ARMED':
        return TradeFormatter.formatZoneArmed(
          payload as unknown as Parameters<typeof TradeFormatter.formatZoneArmed>[0]
        );

      case 'STRATEGY_ZONE_DISARMED':
        return TradeFormatter.formatZoneDisarmed(
          payload as unknown as Parameters<typeof TradeFormatter.formatZoneDisarmed>[0]
        );

      case 'SYSTEM_CRITICAL_ERROR':
        return ErrorFormatter.formatCriticalError(
          payload as unknown as Parameters<typeof ErrorFormatter.formatCriticalError>[0]
        );

      case 'SYSTEM_SYNC_DISCREPANCY':
        return ErrorFormatter.formatSyncDiscrepancy(
          payload as unknown as Parameters<typeof ErrorFormatter.formatSyncDiscrepancy>[0]
        );

      default:
        return `Evento: ${eventName} | ${JSON.stringify(payload)}`;
    }
  }

  // ---------------------------------------------------------------------------
  // Throttling
  // ---------------------------------------------------------------------------

  /**
   * Determina si el evento debe suprimirse por throttling.
   */
  private _isThrottled(eventName: string): boolean {
    const limitMs = this._throttleConfig[eventName] !== undefined
      ? this._throttleConfig[eventName]
      : DEFAULT_THROTTLE_MS;

    // throttle = 0 → sin limite
    if (limitMs === 0) return false;

    const lastTs = this._lastSent.get(eventName);
    if (lastTs == null) return false;

    const elapsed = this._timeProvider.now() - lastTs;
    return elapsed < limitMs;
  }

  // ---------------------------------------------------------------------------
  // Envio aislado por canal
  // ---------------------------------------------------------------------------

  /**
   * Intenta enviar un mensaje a un canal.
   * Si el canal falla, loggea el error pero NO propaga la excepcion ni
   * emite ningun evento critico (regla del modulo: fallo de notificacion
   * no es SYSTEM_CRITICAL_ERROR).
   */
  private async _sendToChannel(
    channel: NotificationChannel,
    message: NotificationMessage,
    eventName: string,
  ): Promise<void> {
    try {
      await channel.send(message);
    } catch (err) {
      this._logger.error(
        `NotificationEngine: fallo al enviar notificacion de ${eventName} ` +
        `via ${(channel as { constructor: { name?: string } }).constructor?.name || 'canal'} — ${(err as Error).message}`
      );
    }
  }
}

export default NotificationEngine;
