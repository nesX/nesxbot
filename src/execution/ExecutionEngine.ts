import type { TradePlan, TradeGroup, TimeProvider, MessageBroker, Logger } from '../types.js';
import type BrokerAdapter from './BrokerAdapter.js';
import type ExposureManager from './ExposureManager.js';
import type OrderManager from './OrderManager.js';

/**
 * ExecutionEngine.ts
 *
 * Orquestador del módulo Execution.
 *
 * Responsabilidades:
 *   - Suscribirse a STRATEGY_SIGNAL_GENERATED y decidir si ejecutar el TradePlan
 *   - Delegar la validación de riesgo a ExposureManager
 *   - Delegar la gestión de órdenes a OrderManager
 *   - Suscribirse a MARKET_CANDLE_CLOSED para evaluar SL/TP en Dry Run
 *   - Emitir eventos del ciclo de vida del trade al MessageBroker
 *   - Propagar errores críticos irrecuperables via SYSTEM_CRITICAL_ERROR
 *
 * En modo Backtest, este módulo NO se instancia. FillSimulator emite directamente
 * los mismos eventos.
 *
 * NO hace:
 *   - Analizar el mercado — StrategyEngine
 *   - Resolver fills históricos — FillSimulator (Backtest Engine)
 *   - Mantener estado de posiciones — PositionManager
 *   - Calcular PnL — PositionManager
 */

interface TradeRepository {
  save(data: Record<string, unknown>): Promise<void>;
}

interface BrokerAdapterWithDryRun extends BrokerAdapter {
  updateMarketPrice?(symbol: string, price: number): { filled: FilledOrder[] };
}

interface FilledOrder {
  orderId: string;
  symbol: string;
  fillPrice: number | null;
  [key: string]: unknown;
}

interface TradePlanValidation {
  valid: boolean;
  reason?: string;
}

interface ExecutionEngineDeps {
  messageBroker: MessageBroker;
  timeProvider: TimeProvider;
  brokerAdapter: BrokerAdapterWithDryRun;
  exposureManager: ExposureManager;
  orderManager: OrderManager;
  tradeRepository?: TradeRepository;
  logger?: Logger;
}

class ExecutionEngine {
  private _broker: MessageBroker;
  private _timeProvider: TimeProvider;
  private _adapter: BrokerAdapterWithDryRun;
  private _exposure: ExposureManager;
  private _orderManager: OrderManager;
  private _tradeRepository: TradeRepository | null;
  private _logger: Logger;
  private _running: boolean;

  constructor({
    messageBroker,
    timeProvider,
    brokerAdapter,
    exposureManager,
    orderManager,
    tradeRepository,
    logger,
  }: ExecutionEngineDeps) {
    if (!messageBroker)   throw new Error('ExecutionEngine: se requiere messageBroker');
    if (!timeProvider)    throw new Error('ExecutionEngine: se requiere timeProvider');
    if (!brokerAdapter)   throw new Error('ExecutionEngine: se requiere brokerAdapter');
    if (!exposureManager) throw new Error('ExecutionEngine: se requiere exposureManager');
    if (!orderManager)    throw new Error('ExecutionEngine: se requiere orderManager');

    this._broker          = messageBroker;
    this._timeProvider    = timeProvider;
    this._adapter         = brokerAdapter;
    this._exposure        = exposureManager;
    this._orderManager    = orderManager;
    this._tradeRepository = tradeRepository || null;
    this._logger          = logger || {
      info:  (...a: unknown[]) => console.log('[ExecutionEngine]', ...a),
      warn:  (...a: unknown[]) => console.warn('[ExecutionEngine]', ...a),
      error: (...a: unknown[]) => console.error('[ExecutionEngine]', ...a),
    };

    this._running = false;
  }

  // ---------------------------------------------------------------------------
  // Ciclo de vida
  // ---------------------------------------------------------------------------

  /**
   * Inicia el ExecutionEngine.
   * Se suscribe a STRATEGY_SIGNAL_GENERATED y MARKET_CANDLE_CLOSED.
   */
  async start(): Promise<void> {
    if (this._running) {
      this._logger.warn('ExecutionEngine ya está corriendo — ignorando start()');
      return;
    }

    this._running = true;

    this._broker.subscribe('STRATEGY_SIGNAL_GENERATED', (payload) => {
      return this._handleSignal(payload as Record<string, unknown>).catch(err => {
        this._logger.error(
          `ExecutionEngine: error no capturado en _handleSignal — ${(err as Error).message}`,
          err
        );
      });
    });

    this._broker.subscribe('MARKET_CANDLE_CLOSED', (payload) => {
      return this._handleCandleClosed(payload as Record<string, unknown>).catch(err => {
        this._logger.error(
          `ExecutionEngine: error no capturado en _handleCandleClosed — ${(err as Error).message}`,
          err
        );
      });
    });

    this._logger.info('ExecutionEngine iniciado');
  }

  /**
   * Detiene el ExecutionEngine.
   */
  async stop(): Promise<void> {
    if (!this._running) return;
    this._running = false;
    this._logger.info('ExecutionEngine detenido');
  }

  // ---------------------------------------------------------------------------
  // Handlers de eventos
  // ---------------------------------------------------------------------------

  /**
   * Handler principal: procesa una señal del StrategyEngine.
   */
  private async _handleSignal(payload: Record<string, unknown>): Promise<void> {
    if (!this._running) return;

    const { tradePlan } = payload;

    if (!tradePlan) {
      this._logger.warn('ExecutionEngine: STRATEGY_SIGNAL_GENERATED sin tradePlan');
      return;
    }

    const plan = tradePlan as TradePlan;

    // 1. Validar TPs ordenados (detecta error antes de consultar el broker)
    const tpValidation = this._validateTradePlan(plan);
    if (!tpValidation.valid) {
      await this._rejectSignal(plan, tpValidation.reason!);
      return;
    }

    // 2. Verificar exposición
    let canExecute;
    try {
      canExecute = await this._exposure.canExecute(plan);
    } catch (err) {
      this._logger.error(
        `ExecutionEngine: error en ExposureManager.canExecute — ${(err as Error).message}`
      );
      await this._rejectSignal(plan, `Error en validación de riesgo: ${(err as Error).message}`);
      return;
    }

    if (!canExecute.allowed) {
      await this._rejectSignal(plan, canExecute.reason!);
      return;
    }

    // 3. Calcular tamaño
    let sizing;
    try {
      sizing = await this._exposure.calculateSize(plan);
    } catch (err) {
      this._logger.error(
        `ExecutionEngine: error en ExposureManager.calculateSize — ${(err as Error).message}`
      );
      await this._rejectSignal(plan, `Error calculando tamaño: ${(err as Error).message}`);
      return;
    }

    // 4. Abrir posición
    const tradeId = this._generateTradeId(plan);

    let group: TradeGroup;
    try {
      group = await this._orderManager.openPosition({
        tradeId,
        tradePlan: plan,
        units: sizing.units,
      });
    } catch (err) {
      this._logger.error(
        `ExecutionEngine: error abriendo posición para ${tradeId} — ${(err as Error).message}`
      );
      await this._handleBrokerError(err as Error, plan.symbol);
      return;
    }

    // 5. Registrar en ExposureManager
    this._exposure.registerOpenTrade(
      tradeId,
      plan.symbol,
      plan.riskPercent,
      sizing.riskAmount
    );

    // 6. Persistir si hay repositorio
    if (this._tradeRepository) {
      try {
        await this._tradeRepository.save({
          tradeId,
          tradePlan: plan,
          units:      sizing.units,
          notional:   sizing.notional,
          riskAmount: sizing.riskAmount,
          openedAt:   this._timeProvider.now(),
        });
      } catch (err) {
        this._logger.error(
          `ExecutionEngine: error persistiendo trade ${tradeId} — ${(err as Error).message}`
        );
      }
    }

    // 7. Emitir EXECUTION_TRADE_OPENED
    await this._broker.publish('EXECUTION_TRADE_OPENED', {
      tradeId,
      symbol:      plan.symbol,
      direction:   plan.direction,
      entryPrice:  group.entryPrice ?? plan.entryPrice,
      size:        sizing.units,
      stopLoss:    plan.stopLoss,
      takeProfits: plan.takeProfits as unknown as Record<string, unknown>[],
      timestamp:   this._timeProvider.now(),
    });

    this._logger.info(
      `Trade abierto: ${tradeId} ${plan.symbol} ${plan.direction} ` +
      `${sizing.units} units @ ${plan.entryPrice}`
    );
  }

  /**
   * Handler de vela cerrada: evalúa si algún SL o TP fue tocado (Dry Run / Live).
   */
  private async _handleCandleClosed(payload: Record<string, unknown>): Promise<void> {
    if (!this._running) return;

    const symbol = payload['symbol'] as string;
    const candle = payload['candle'] as Record<string, unknown> | undefined;
    if (!candle) return;

    const currentPrice = candle['close'] as number;

    // Si el adapter soporta updateMarketPrice (DryRunAdapter), procesamos fills
    if (typeof this._adapter.updateMarketPrice !== 'function') return;

    let fillResult: { filled: FilledOrder[] };
    try {
      fillResult = this._adapter.updateMarketPrice(symbol, currentPrice);
    } catch (err) {
      this._logger.error(
        `ExecutionEngine: error actualizando precio de mercado para ${symbol} — ${(err as Error).message}`
      );
      return;
    }

    if (!fillResult || !fillResult.filled || fillResult.filled.length === 0) return;

    for (const filledOrder of fillResult.filled) {
      await this._processFill(filledOrder).catch(err => {
        this._logger.error(
          `ExecutionEngine: error procesando fill de orden ${filledOrder.orderId} — ` +
          `${(err as Error).message}`
        );
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Procesamiento de fills
  // ---------------------------------------------------------------------------

  /**
   * Procesa el fill de una orden (SL o TP) y emite el evento correspondiente.
   */
  private async _processFill(filledOrder: FilledOrder): Promise<void> {
    const { orderId, symbol, fillPrice } = filledOrder;

    // Encontrar el trade al que pertenece esta orden
    const tradeId = this._findTradeByOrderId(orderId);
    if (!tradeId) {
      this._logger.warn(
        `ExecutionEngine: fill recibido para orden ${orderId} sin trade asociado`
      );
      return;
    }

    const group = this._orderManager.getGroup(tradeId);
    if (!group) return;

    const resolvedFillPrice = fillPrice ?? 0;
    const now = this._timeProvider.now();

    // ¿Es el SL?
    if (orderId === group.slOrderId) {
      await this._handleSLFill(tradeId, group, resolvedFillPrice, now);
      return;
    }

    // ¿Es un TP?
    const tpIndex = group.tpOrderIds.indexOf(orderId);
    if (tpIndex !== -1) {
      await this._handleTPFill(tradeId, group, tpIndex, resolvedFillPrice, now);
    }
  }

  /**
   * Procesa el fill del Stop Loss.
   */
  private async _handleSLFill(
    tradeId: string,
    group: TradeGroup,
    fillPrice: number,
    timestamp: number,
  ): Promise<void> {
    const pnl = this._calculatePnL(group, fillPrice, group.remainingUnits);

    await this._orderManager.closeGroup(tradeId, 'SL');

    this._exposure.unregisterTrade(tradeId);

    await this._broker.publish('EXECUTION_TRADE_CLOSED', {
      tradeId,
      exitPrice: fillPrice,
      exitType:  'SL',
      pnl,
      timestamp,
    });

    this._logger.info(
      `Trade cerrado por SL: ${tradeId} @ ${fillPrice} PnL: ${pnl}`
    );
  }

  /**
   * Procesa el fill de un Take Profit (parcial o total).
   */
  private async _handleTPFill(
    tradeId: string,
    group: TradeGroup,
    tpIndex: number,
    fillPrice: number,
    timestamp: number,
  ): Promise<void> {
    const tp      = this._getTradePlanTP(group, tpIndex);
    const tpUnits = group.units * ((tp ? tp.sizePercent : 100) / 100);

    const { remainingUnits, isFullyClosed } = this._orderManager.registerTPFill(
      tradeId,
      tpIndex,
      fillPrice,
      tpUnits
    );

    const partialPnL = this._calculatePnL(group, fillPrice, tpUnits);

    if (isFullyClosed) {
      await this._orderManager.closeGroup(tradeId, 'TP_FINAL');
      this._exposure.unregisterTrade(tradeId);

      await this._broker.publish('EXECUTION_TRADE_CLOSED', {
        tradeId,
        exitPrice: fillPrice,
        exitType:  'TP',
        pnl:       partialPnL,
        timestamp,
      });

      this._logger.info(
        `Trade cerrado por TP final: ${tradeId} @ ${fillPrice}`
      );
    } else {
      await this._broker.publish('EXECUTION_PARTIAL_FILLED', {
        tradeId,
        tpLevel:       tpIndex + 1,
        fillPrice,
        remainingSize: remainingUnits,
        timestamp,
      });

      this._logger.info(
        `TP${tpIndex + 1} parcial: ${tradeId} @ ${fillPrice}, ` +
        `restantes: ${remainingUnits}`
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Operaciones sobre trades activos (API pública del módulo)
  // ---------------------------------------------------------------------------

  /**
   * Mueve el Stop Loss de un trade abierto.
   */
  async moveSL(tradeId: string, newSLPrice: number, reason = 'manual'): Promise<void> {
    const group = this._orderManager.getGroup(tradeId);
    if (!group) {
      this._logger.warn(`ExecutionEngine.moveSL: trade ${tradeId} no encontrado`);
      return;
    }

    const { oldSL, newSL } = await this._orderManager.moveSL(tradeId, newSLPrice);

    await this._broker.publish('EXECUTION_SL_MOVED', {
      tradeId,
      oldSL,
      newSL,
      reason,
      timestamp: this._timeProvider.now(),
    });

    this._logger.info(
      `SL movido: ${tradeId} ${oldSL} → ${newSL} (${reason})`
    );
  }

  /**
   * Cierra un trade manualmente (por solicitud externa).
   */
  async closeTrade(tradeId: string, currentPrice: number): Promise<void> {
    const group = this._orderManager.getGroup(tradeId);
    if (!group) {
      this._logger.warn(`ExecutionEngine.closeTrade: trade ${tradeId} no encontrado`);
      return;
    }

    const closeSide: 'BUY' | 'SELL' = group.direction === 'LONG' ? 'SELL' : 'BUY';
    try {
      await this._adapter.placeOrder({
        symbol:        group.symbol,
        side:          closeSide,
        type:          'MARKET',
        quantity:      group.remainingUnits,
        clientOrderId: `${tradeId}-close-manual`,
      });
    } catch (err) {
      this._logger.error(
        `ExecutionEngine.closeTrade: error cerrando ${tradeId} — ${(err as Error).message}`
      );
      await this._handleBrokerError(err as Error, group.symbol);
      return;
    }

    const pnl = this._calculatePnL(group, currentPrice, group.remainingUnits);

    await this._orderManager.closeGroup(tradeId, 'MANUAL');
    this._exposure.unregisterTrade(tradeId);

    await this._broker.publish('EXECUTION_TRADE_CLOSED', {
      tradeId,
      exitPrice: currentPrice,
      exitType:  'MANUAL',
      pnl,
      timestamp: this._timeProvider.now(),
    });

    this._logger.info(`Trade cerrado manualmente: ${tradeId} @ ${currentPrice}`);
  }

  // ---------------------------------------------------------------------------
  // Helpers internos
  // ---------------------------------------------------------------------------

  /**
   * Valida los campos críticos del TradePlan antes de procesarlo.
   */
  private _validateTradePlan(tradePlan: TradePlan): TradePlanValidation {
    const required = [
      'strategyId', 'symbol', 'direction', 'entryPrice',
      'stopLoss', 'takeProfits', 'riskPercent',
    ] as const;

    for (const field of required) {
      const value = tradePlan[field];
      if (value === undefined || value === null) {
        return { valid: false, reason: `Campo requerido ausente: ${field}` };
      }
    }

    if (!['LONG', 'SHORT'].includes(tradePlan.direction)) {
      return { valid: false, reason: `direction inválido: ${tradePlan.direction}` };
    }

    if (!Array.isArray(tradePlan.takeProfits) || tradePlan.takeProfits.length === 0) {
      return { valid: false, reason: 'se requiere al menos un Take Profit' };
    }

    const { direction, takeProfits, entryPrice, stopLoss } = tradePlan;

    for (let i = 1; i < takeProfits.length; i++) {
      const prev = takeProfits[i - 1];
      const curr = takeProfits[i];

      if (direction === 'LONG' && curr.price <= prev.price) {
        return {
          valid:  false,
          reason: `TPs desordenados en posición LONG — TP${i + 1} (${curr.price}) ` +
                  `debe ser mayor que TP${i} (${prev.price})`,
        };
      }

      if (direction === 'SHORT' && curr.price >= prev.price) {
        return {
          valid:  false,
          reason: `TPs desordenados en posición SHORT — TP${i + 1} (${curr.price}) ` +
                  `debe ser menor que TP${i} (${prev.price})`,
        };
      }
    }

    if (direction === 'LONG' && stopLoss >= entryPrice) {
      return {
        valid:  false,
        reason: `SL (${stopLoss}) debe estar por debajo de entryPrice (${entryPrice}) para LONG`,
      };
    }

    if (direction === 'SHORT' && stopLoss <= entryPrice) {
      return {
        valid:  false,
        reason: `SL (${stopLoss}) debe estar por encima de entryPrice (${entryPrice}) para SHORT`,
      };
    }

    return { valid: true };
  }

  /**
   * Emite EXECUTION_SIGNAL_REJECTED y loggea la razón.
   */
  private async _rejectSignal(tradePlan: TradePlan, reason: string): Promise<void> {
    await this._broker.publish('EXECUTION_SIGNAL_REJECTED', {
      strategyId: tradePlan.strategyId,
      symbol:     tradePlan.symbol,
      reason,
      timestamp:  this._timeProvider.now(),
    });

    this._logger.warn(
      `Señal rechazada: ${tradePlan.strategyId} ${tradePlan.symbol} — ${reason}`
    );
  }

  /**
   * Maneja errores del broker distinguiendo si son recuperables o críticos.
   */
  private async _handleBrokerError(err: Error, symbol: string): Promise<void> {
    const isRecoverable = this._isRecoverableError(err);

    if (!isRecoverable) {
      await this._broker.publish('SYSTEM_CRITICAL_ERROR', {
        source:      'ExecutionEngine',
        symbol,
        error:       err.message,
        recoverable: false,
        timestamp:   this._timeProvider.now(),
      });

      this._logger.error(
        `Error crítico de broker para ${symbol}: ${err.message}`
      );
    } else {
      this._logger.warn(
        `Error recuperable de broker para ${symbol}: ${err.message}`
      );
    }
  }

  /**
   * Heurística para determinar si un error de broker es recuperable.
   */
  private _isRecoverableError(err: Error): boolean {
    const message = err.message.toLowerCase();
    const recoverablePatterns = ['timeout', 'econnreset', 'econnrefused', 'network', 'rate limit'];
    return recoverablePatterns.some(p => message.includes(p));
  }

  /**
   * Genera un tradeId único basado en la estrategia, símbolo y timestamp.
   */
  private _generateTradeId(tradePlan: TradePlan): string {
    return `${tradePlan.strategyId}-${tradePlan.symbol}-${this._timeProvider.now()}`;
  }

  /**
   * Busca el tradeId asociado a una orderId recorriendo todos los grupos activos.
   */
  private _findTradeByOrderId(orderId: string): string | null {
    for (const tradeId of this._orderManager.getActiveTradeIds()) {
      const group = this._orderManager.getGroup(tradeId);
      if (!group) continue;

      if (group.entryOrderId === orderId) return tradeId;
      if (group.slOrderId    === orderId) return tradeId;
      if (group.tpOrderIds.includes(orderId)) return tradeId;
    }
    return null;
  }

  /**
   * Obtiene la definición de un TP desde las definiciones almacenadas en el grupo.
   */
  private _getTradePlanTP(
    group: TradeGroup,
    tpIndex: number,
  ): { price: number; sizePercent: number } | null {
    if (group.tpDefinitions && group.tpDefinitions[tpIndex]) {
      return group.tpDefinitions[tpIndex];
    }
    return null;
  }

  /**
   * Calcula el PnL de un fill dado el estado del grupo.
   */
  private _calculatePnL(group: TradeGroup, exitPrice: number, units: number): number {
    if (!group.entryPrice) return 0;

    const diff = group.direction === 'LONG'
      ? exitPrice - group.entryPrice
      : group.entryPrice - exitPrice;

    return diff * units;
  }
}

export default ExecutionEngine;
