import type { Position, TimeProvider, MessageBroker, Logger } from '../types.js';
import type PositionRepository from './PositionRepository.js';

/**
 * PositionManager.ts
 *
 * Fuente de verdad del estado de posiciones abiertas en NesxTrader.
 *
 * Responsabilidades:
 *   - Mantener un mapa en memoria de todos los trades con status OPEN o PARTIAL
 *   - Reconstruir ese mapa desde la base de datos al iniciar (tolerancia a reinicios)
 *   - Suscribirse a eventos de ejecución y mantener el estado actualizado
 *   - Detectar discrepancias entre el estado local y el estado reportado por el broker
 *   - Proveer consultas sincrónicas del estado actual a otros módulos
 *
 * NO hace:
 *   - Ejecutar órdenes → ExecutionEngine
 *   - Calcular métricas históricas → BacktestEngine
 *   - Persistir datos directamente en SQL → PositionRepository
 *
 * Eventos que consume:
 *   EXECUTION_TRADE_OPENED    → agrega posición al estado en memoria y la persiste
 *   EXECUTION_PARTIAL_FILLED  → actualiza size de la posición y sus TPs
 *   EXECUTION_SL_MOVED        → actualiza stopLoss de la posición
 *   EXECUTION_TRADE_CLOSED    → marca la posición como CLOSED en memoria y en BD
 *
 * Eventos que emite:
 *   SYSTEM_SYNC_DISCREPANCY   → cuando syncWithBroker() detecta diferencias
 */

interface BrokerOrder {
  orderId: string;
  clientOrderId?: string;
}

interface BrokerAdapter {
  getOpenOrders(): Promise<BrokerOrder[]>;
}

interface PositionManagerDeps {
  messageBroker: MessageBroker;
  timeProvider: TimeProvider;
  positionRepository: PositionRepository;
  brokerAdapter?: BrokerAdapter | null;
  logger?: Logger;
}

class PositionManager {
  private _broker: MessageBroker;
  private _time: TimeProvider;
  private _repo: PositionRepository;
  private _adapter: BrokerAdapter | null;
  private _logger: Logger;
  private _positions: Map<string, Position>;
  private _running: boolean;

  constructor({ messageBroker, timeProvider, positionRepository, brokerAdapter, logger }: PositionManagerDeps) {
    if (!messageBroker)      throw new Error('PositionManager: se requiere messageBroker');
    if (!timeProvider)       throw new Error('PositionManager: se requiere timeProvider');
    if (!positionRepository) throw new Error('PositionManager: se requiere positionRepository');

    this._broker  = messageBroker;
    this._time    = timeProvider;
    this._repo    = positionRepository;
    this._adapter = brokerAdapter ?? null;
    this._logger  = logger ?? {
      info:  (...a: unknown[]) => console.log('[PositionManager]', ...a),
      warn:  (...a: unknown[]) => console.warn('[PositionManager]', ...a),
      error: (...a: unknown[]) => console.error('[PositionManager]', ...a),
    };

    // Mapa en memoria: tradeId → Position
    // Solo contiene posiciones con status OPEN o PARTIAL
    this._positions = new Map<string, Position>();
    this._running   = false;
  }

  // ---------------------------------------------------------------------------
  // Ciclo de vida
  // ---------------------------------------------------------------------------

  /**
   * Inicia el PositionManager.
   *
   * Flujo:
   *   1. Recarga posiciones abiertas desde BD (reconstrucción de estado)
   *   2. Se suscribe a los eventos de ejecución del MessageBroker
   */
  async start(): Promise<void> {
    if (this._running) {
      this._logger.warn('PositionManager ya está corriendo — ignorando start()');
      return;
    }

    this._running = true;

    // 1. Reconstruir estado desde BD
    await this._loadOpenPositions();

    // 2. Suscribirse a eventos
    this._broker.subscribe('EXECUTION_TRADE_OPENED', (payload) => {
      return this._handleTradeOpened(payload as Record<string, unknown>).catch((err: Error) => {
        this._logger.error(
          `PositionManager: error no capturado en _handleTradeOpened — ${err.message}`,
          err
        );
      });
    });

    this._broker.subscribe('EXECUTION_PARTIAL_FILLED', (payload) => {
      return this._handlePartialFilled(payload as Record<string, unknown>).catch((err: Error) => {
        this._logger.error(
          `PositionManager: error no capturado en _handlePartialFilled — ${err.message}`,
          err
        );
      });
    });

    this._broker.subscribe('EXECUTION_SL_MOVED', (payload) => {
      return this._handleSLMoved(payload as Record<string, unknown>).catch((err: Error) => {
        this._logger.error(
          `PositionManager: error no capturado en _handleSLMoved — ${err.message}`,
          err
        );
      });
    });

    this._broker.subscribe('EXECUTION_TRADE_CLOSED', (payload) => {
      return this._handleTradeClosed(payload as Record<string, unknown>).catch((err: Error) => {
        this._logger.error(
          `PositionManager: error no capturado en _handleTradeClosed — ${err.message}`,
          err
        );
      });
    });

    this._logger.info(
      `PositionManager iniciado — ${this._positions.size} posición(es) abiertas recuperadas`
    );
  }

  /**
   * Detiene el PositionManager y limpia el estado en memoria.
   */
  async stop(): Promise<void> {
    if (!this._running) return;
    this._running = false;
    this._positions.clear();
    this._logger.info('PositionManager detenido');
  }

  // ---------------------------------------------------------------------------
  // Consultas (API pública sincrónica)
  // ---------------------------------------------------------------------------

  /**
   * Retorna todas las posiciones abiertas (status OPEN o PARTIAL).
   * Retorna copias inmutables del estado interno.
   */
  getOpenPositions(): Position[] {
    return Array.from(this._positions.values()).map(p => ({ ...p }));
  }

  /**
   * Retorna una posición por su tradeId.
   * Solo busca en el estado en memoria (posiciones abiertas).
   */
  getPosition(tradeId: string): Position | null {
    const position = this._positions.get(tradeId);
    return position ? { ...position } : null;
  }

  // ---------------------------------------------------------------------------
  // Sincronización con broker
  // ---------------------------------------------------------------------------

  /**
   * Compara el estado local con las órdenes abiertas reportadas por el broker.
   * Para cada discrepancia encontrada, emite SYSTEM_SYNC_DISCREPANCY.
   *
   * Una discrepancia ocurre cuando:
   *   - El broker reporta una posición que no existe localmente
   *   - Una posición local no aparece en el broker (posiblemente cerrada externamente)
   *
   * Solo opera si se inyectó un brokerAdapter en el constructor.
   */
  async syncWithBroker(): Promise<void> {
    if (!this._adapter) {
      this._logger.warn('PositionManager.syncWithBroker: no hay brokerAdapter inyectado');
      return;
    }

    let brokerOrders: BrokerOrder[];
    try {
      brokerOrders = await this._adapter.getOpenOrders();
    } catch (err) {
      this._logger.error(
        `PositionManager.syncWithBroker: error consultando broker — ${(err as Error).message}`
      );
      return;
    }

    // Construir un Set de tradeIds que el broker conoce.
    // Se asume que las órdenes del broker tienen clientOrderId con formato
    // "{tradeId}-entry" | "{tradeId}-sl" | "{tradeId}-sl-{ts}" | "{tradeId}-tp{n}".
    const brokerTradeIds = new Set<string>();
    for (const order of brokerOrders) {
      const tradeId = this._extractTradeIdFromOrderId(order.clientOrderId ?? order.orderId);
      if (tradeId) brokerTradeIds.add(tradeId);
    }

    // Detectar posiciones locales que el broker no conoce
    for (const [tradeId, localPosition] of this._positions) {
      if (!brokerTradeIds.has(tradeId)) {
        await this._broker.publish('SYSTEM_SYNC_DISCREPANCY', {
          tradeId,
          localState:  { ...localPosition } as unknown as Record<string, unknown>,
          brokerState: null as unknown as Record<string, unknown>,
          reason:      'posición local sin órdenes en el broker',
          timestamp:   this._time.now(),
        });

        this._logger.warn(
          `PositionManager.syncWithBroker: discrepancia — ` +
          `trade ${tradeId} local pero sin órdenes en broker`
        );
      }
    }

    // Detectar posiciones en el broker que no existen localmente
    for (const brokerId of brokerTradeIds) {
      if (!this._positions.has(brokerId)) {
        await this._broker.publish('SYSTEM_SYNC_DISCREPANCY', {
          tradeId:     brokerId,
          localState:  null as unknown as Record<string, unknown>,
          brokerState: { tradeId: brokerId },
          reason:      'posición en broker sin registro local',
          timestamp:   this._time.now(),
        });

        this._logger.warn(
          `PositionManager.syncWithBroker: discrepancia — ` +
          `trade ${brokerId} en broker pero sin registro local`
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Handlers de eventos del MessageBroker
  // ---------------------------------------------------------------------------

  private async _handleTradeOpened(payload: Record<string, unknown>): Promise<void> {
    if (!this._running) return;

    const {
      tradeId,
      symbol,
      direction,
      entryPrice,
      size,
      stopLoss,
      takeProfits,
      strategyId = '',
      timestamp,
    } = payload;

    if (!tradeId || !symbol || !direction || entryPrice == null) {
      this._logger.warn(
        'PositionManager._handleTradeOpened: payload incompleto, ignorando',
        payload
      );
      return;
    }

    // Evitar duplicados si el evento llega más de una vez
    if (this._positions.has(tradeId as string)) {
      this._logger.warn(
        `PositionManager._handleTradeOpened: trade ${tradeId} ya existe en memoria — ignorando`
      );
      return;
    }

    const rawTPs = Array.isArray(takeProfits) ? takeProfits : [];

    const position: Position = {
      tradeId:     tradeId as string,
      strategyId:  strategyId as string,
      symbol:      symbol as string,
      direction:   direction as 'LONG' | 'SHORT',
      entryPrice:  entryPrice as number,
      entryTime:   (timestamp as number | undefined) ?? this._time.now(),
      stopLoss:    stopLoss as number,
      takeProfits: rawTPs.map((tp: unknown) => ({ ...(tp as { price: number; sizePercent: number }) })),
      size:        size as number,
      status:      'OPEN',
    };

    // Actualizar estado en memoria
    this._positions.set(position.tradeId, position);

    // Persistir en BD (no bloquea si falla — se loggea)
    try {
      await this._repo.save(position);
    } catch (err) {
      this._logger.error(
        `PositionManager: error persistiendo trade ${tradeId} — ${(err as Error).message}`
      );
    }

    this._logger.info(
      `Posición abierta: ${tradeId} ${symbol} ${direction} ${size} @ ${entryPrice}`
    );
  }

  private async _handlePartialFilled(payload: Record<string, unknown>): Promise<void> {
    if (!this._running) return;

    const { tradeId, remainingSize } = payload;

    const position = this._positions.get(tradeId as string);
    if (!position) {
      this._logger.warn(
        `PositionManager._handlePartialFilled: trade ${tradeId} no encontrado en memoria`
      );
      return;
    }

    position.size   = remainingSize as number;
    position.status = 'PARTIAL';

    try {
      await this._repo.update(tradeId as string, { status: 'PARTIAL' });
    } catch (err) {
      this._logger.error(
        `PositionManager: error actualizando parcial ${tradeId} — ${(err as Error).message}`
      );
    }

    this._logger.info(
      `TP parcial: ${tradeId} — size restante: ${remainingSize}`
    );
  }

  private async _handleSLMoved(payload: Record<string, unknown>): Promise<void> {
    if (!this._running) return;

    const { tradeId, newSL, reason = 'manual' } = payload;

    const position = this._positions.get(tradeId as string);
    if (!position) {
      this._logger.warn(
        `PositionManager._handleSLMoved: trade ${tradeId} no encontrado en memoria`
      );
      return;
    }

    const oldSL = position.stopLoss;
    position.stopLoss = newSL as number;

    try {
      await this._repo.update(tradeId as string, { stopLoss: newSL as number });
    } catch (err) {
      this._logger.error(
        `PositionManager: error actualizando SL de ${tradeId} — ${(err as Error).message}`
      );
    }

    this._logger.info(
      `SL actualizado: ${tradeId} ${oldSL} → ${newSL} (${reason})`
    );
  }

  private async _handleTradeClosed(payload: Record<string, unknown>): Promise<void> {
    if (!this._running) return;

    const { tradeId, exitPrice, exitType, pnl, timestamp } = payload;

    if (!this._positions.has(tradeId as string)) {
      this._logger.warn(
        `PositionManager._handleTradeClosed: trade ${tradeId} no encontrado en memoria`
      );
      return;
    }

    // Eliminar del mapa de posiciones abiertas
    this._positions.delete(tradeId as string);

    try {
      await this._repo.update(tradeId as string, {
        status:    'CLOSED',
        exitPrice: exitPrice as number,
        exitTime:  (timestamp as number | undefined) ?? this._time.now(),
        exitType:  exitType as string,
        pnl:       pnl != null ? (pnl as number) : undefined,
      });
    } catch (err) {
      this._logger.error(
        `PositionManager: error cerrando trade ${tradeId} en BD — ${(err as Error).message}`
      );
    }

    this._logger.info(
      `Posición cerrada: ${tradeId} @ ${exitPrice} (${exitType}) PnL: ${pnl}`
    );
  }

  // ---------------------------------------------------------------------------
  // Internos
  // ---------------------------------------------------------------------------

  /**
   * Carga las posiciones abiertas desde la base de datos al mapa en memoria.
   * Llamado únicamente en start() para reconstruir estado tras un reinicio.
   */
  private async _loadOpenPositions(): Promise<void> {
    let openPositions: Position[];
    try {
      openPositions = await this._repo.findOpen();
    } catch (err) {
      this._logger.error(
        `PositionManager._loadOpenPositions: error consultando BD — ${(err as Error).message}`
      );
      return;
    }

    this._positions.clear();

    for (const position of openPositions) {
      this._positions.set(position.tradeId, position);
    }

    this._logger.info(
      `PositionManager: ${this._positions.size} posición(es) cargadas desde BD`
    );
  }

  /**
   * Extrae el tradeId de un clientOrderId con formato "{tradeId}-{suffix}".
   * Los sufijos conocidos son: "entry", "sl", "sl-{ts}", "tp{n}".
   */
  private _extractTradeIdFromOrderId(orderIdOrClientId: string | undefined): string | null {
    if (!orderIdOrClientId) return null;

    // Sufijos conocidos: -entry, -sl, -sl-{digits}, -tp{n}
    const match = orderIdOrClientId.match(
      /^(.+?)(?:-entry|-sl(?:-\d+)?|-tp\d+)$/
    );

    return match ? match[1] : null;
  }
}

export default PositionManager;
