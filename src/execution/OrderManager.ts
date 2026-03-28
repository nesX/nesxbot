import type { TradePlan, TradeGroup, TakeProfit, TimeProvider, Logger } from '../types.js';
import type BrokerAdapter from './BrokerAdapter.js';
import type { PlaceOrderParams } from './BrokerAdapter.js';

/**
 * OrderManager.ts
 *
 * Gestiona el ciclo de vida de órdenes asociadas a un trade abierto.
 *
 * Responsabilidades:
 *   - Colocar el grupo de órdenes asociado a un TradePlan (entrada + SL + TPs)
 *   - Rastrear qué órdenes están pendientes / llenadas / canceladas
 *   - Mover el Stop Loss (trailing stop, breakeven) cuando lo instruye el ExecutionEngine
 *   - Cancelar el grupo completo de órdenes cuando el trade se cierra
 *   - Detectar qué nivel fue tocado (SL o TP) al recibir confirmación de fill
 *
 * NO hace:
 *   - Emitir eventos al MessageBroker — eso es ExecutionEngine
 *   - Calcular tamaño de posición — eso es ExposureManager
 *   - Mantener estado global de posiciones — eso es PositionManager
 *   - Saber si está en modo Live o Dry Run — lo determina el BrokerAdapter inyectado
 */

interface OrderManagerDeps {
  brokerAdapter: Pick<BrokerAdapter, 'placeOrder' | 'cancelOrder'>;
  timeProvider: TimeProvider;
  logger?: Logger;
}

interface OpenPositionParams {
  tradeId: string;
  tradePlan: TradePlan;
  units: number;
  entryType?: 'MARKET' | 'LIMIT';
}

interface TPFillResult {
  remainingUnits: number;
  isFullyClosed: boolean;
}

interface MoveSLResult {
  oldSL: number;
  newSL: number;
  newOrderId: string;
}

class OrderManager {
  private _adapter: Pick<BrokerAdapter, 'placeOrder' | 'cancelOrder'>;
  private _timeProvider: TimeProvider;
  private _logger: Logger;
  private _tradeGroups: Map<string, TradeGroup>;

  constructor({ brokerAdapter, timeProvider, logger }: OrderManagerDeps) {
    if (!brokerAdapter)  throw new Error('OrderManager: se requiere brokerAdapter');
    if (!timeProvider)   throw new Error('OrderManager: se requiere timeProvider');

    this._adapter      = brokerAdapter;
    this._timeProvider = timeProvider;
    this._logger       = logger || {
      info:  (...a: unknown[]) => console.log('[OrderManager]', ...a),
      warn:  (...a: unknown[]) => console.warn('[OrderManager]', ...a),
      error: (...a: unknown[]) => console.error('[OrderManager]', ...a),
    };

    // Map<tradeId, TradeGroup>
    this._tradeGroups = new Map();
  }

  // ---------------------------------------------------------------------------
  // Apertura de posición
  // ---------------------------------------------------------------------------

  /**
   * Coloca el grupo completo de órdenes para un TradePlan ya validado.
   *
   * Secuencia:
   *   1. Orden de entrada (MARKET o LIMIT según entryType)
   *   2. Si la entrada se llena inmediatamente → colocar SL y TPs
   *   3. Si la entrada queda pendiente → el grupo queda en estado WAITING_ENTRY
   */
  async openPosition({
    tradeId,
    tradePlan,
    units,
    entryType = 'LIMIT',
  }: OpenPositionParams): Promise<TradeGroup> {
    this._validateTakeProfits(tradePlan);

    const { symbol, direction, entryPrice, stopLoss, takeProfits } = tradePlan;
    const entrySide: 'BUY' | 'SELL' = direction === 'LONG' ? 'BUY' : 'SELL';

    const group: TradeGroup = {
      tradeId,
      symbol,
      direction,
      units,
      status:          'WAITING_ENTRY',
      entryOrderId:    null,
      slOrderId:       null,
      tpOrderIds:      [],
      tpDefinitions:   takeProfits.map(tp => ({ ...tp })),
      filledTPs:       [],
      currentSL:       stopLoss,
      entryPrice:      null,
      originalSL:      stopLoss,
      remainingUnits:  units,
      openedAt:        null,
    };

    // 1. Colocar orden de entrada
    const entryOrderParams: PlaceOrderParams = {
      symbol,
      side:          entrySide,
      type:          entryType,
      quantity:      units,
      clientOrderId: `${tradeId}-entry`,
    };
    if (entryType === 'LIMIT') {
      entryOrderParams.price = entryPrice;
    }

    const entryOrder = await this._adapter.placeOrder(entryOrderParams);

    group.entryOrderId = entryOrder.orderId;

    // 2. Si la entrada ya está llena (ej. MARKET o DryRunAdapter), colocar SL y TPs
    if (entryOrder.status === 'FILLED') {
      group.status     = 'OPEN';
      group.entryPrice = entryOrder.fillPrice ?? entryPrice;
      group.openedAt   = this._timeProvider.now();

      await this._placeSLandTPs(group, stopLoss, takeProfits);
    }

    this._tradeGroups.set(tradeId, group);

    this._logger.info(
      `[OrderManager] Grupo abierto: ${tradeId} ${symbol} ${direction} ` +
      `${units} units @ ${entryPrice}`
    );

    return { ...group };
  }

  // ---------------------------------------------------------------------------
  // Confirmación de fill de entrada
  // ---------------------------------------------------------------------------

  /**
   * Llamado cuando la orden de entrada se llena (para órdenes LIMIT pendientes).
   * Coloca el SL y los TPs una vez confirmado el fill.
   */
  async onEntryFilled(
    tradeId: string,
    fillPrice: number,
    tradePlan: TradePlan,
  ): Promise<TradeGroup> {
    const group = this._getGroup(tradeId);

    if (group.status !== 'WAITING_ENTRY') {
      throw new Error(
        `OrderManager.onEntryFilled: trade ${tradeId} no está en estado WAITING_ENTRY ` +
        `(estado actual: ${group.status})`
      );
    }

    group.status     = 'OPEN';
    group.entryPrice = fillPrice;
    group.openedAt   = this._timeProvider.now();

    await this._placeSLandTPs(group, tradePlan.stopLoss, tradePlan.takeProfits);

    this._logger.info(
      `[OrderManager] Entrada confirmada: ${tradeId} @ ${fillPrice}`
    );

    return { ...group };
  }

  // ---------------------------------------------------------------------------
  // Gestión de TPs parciales
  // ---------------------------------------------------------------------------

  /**
   * Registra el fill de un TP parcial y actualiza el tamaño restante.
   */
  registerTPFill(
    tradeId: string,
    tpIndex: number,
    fillPrice: number,
    filledUnits: number,
  ): TPFillResult {
    const group = this._getGroup(tradeId);

    (group.filledTPs as unknown[]).push({
      tpIndex,
      fillPrice,
      filledUnits,
      timestamp: this._timeProvider.now(),
    });
    group.remainingUnits = Math.max(0, group.remainingUnits - filledUnits);

    const isFullyClosed = group.remainingUnits <= 0;
    if (isFullyClosed) {
      group.status = 'CLOSED';
    }

    this._logger.info(
      `[OrderManager] TP${tpIndex + 1} fill: ${tradeId} @ ${fillPrice}, ` +
      `unidades restantes: ${group.remainingUnits}`
    );

    return { remainingUnits: group.remainingUnits, isFullyClosed };
  }

  // ---------------------------------------------------------------------------
  // Movimiento de Stop Loss
  // ---------------------------------------------------------------------------

  /**
   * Mueve el Stop Loss a un nuevo precio.
   * Cancela la orden SL anterior y coloca una nueva.
   */
  async moveSL(tradeId: string, newSLPrice: number): Promise<MoveSLResult> {
    const group = this._getGroup(tradeId);

    if (group.status !== 'OPEN') {
      throw new Error(
        `OrderManager.moveSL: trade ${tradeId} no está abierto ` +
        `(estado actual: ${group.status})`
      );
    }

    const oldSL = group.currentSL;

    // 1. Cancelar la orden SL anterior
    if (group.slOrderId) {
      await this._adapter.cancelOrder(group.slOrderId, group.symbol);
    }

    // 2. Colocar nueva orden SL
    const slSide: 'BUY' | 'SELL' = group.direction === 'LONG' ? 'SELL' : 'BUY';
    const slOrder = await this._adapter.placeOrder({
      symbol:          group.symbol,
      side:            slSide,
      type:            'STOP_LOSS',
      quantity:        group.remainingUnits,
      stopPrice:       newSLPrice,
      clientOrderId:   `${tradeId}-sl-${this._timeProvider.now()}`,
    });

    group.slOrderId  = slOrder.orderId;
    group.currentSL  = newSLPrice;

    this._logger.info(
      `[OrderManager] SL movido: ${tradeId} ${oldSL} → ${newSLPrice}`
    );

    return { oldSL, newSL: newSLPrice, newOrderId: slOrder.orderId };
  }

  // ---------------------------------------------------------------------------
  // Cierre de posición
  // ---------------------------------------------------------------------------

  /**
   * Cierra un trade cancelando todas las órdenes pendientes del grupo.
   * No coloca orden de salida — eso lo hace el ExecutionEngine si es necesario.
   */
  async closeGroup(tradeId: string, reason = 'manual'): Promise<void> {
    const group = this._getGroup(tradeId);

    if (group.status === 'CLOSED') {
      this._logger.warn(`[OrderManager] closeGroup: trade ${tradeId} ya está cerrado`);
      return;
    }

    group.status = 'CLOSED';

    // Cancelar SL pendiente
    if (group.slOrderId) {
      try {
        await this._adapter.cancelOrder(group.slOrderId, group.symbol);
      } catch (err) {
        this._logger.error(
          `[OrderManager] Error cancelando SL ${group.slOrderId}: ${(err as Error).message}`
        );
      }
    }

    // Cancelar TPs pendientes
    for (const tpOrderId of group.tpOrderIds) {
      try {
        await this._adapter.cancelOrder(tpOrderId, group.symbol);
      } catch (err) {
        this._logger.error(
          `[OrderManager] Error cancelando TP ${tpOrderId}: ${(err as Error).message}`
        );
      }
    }

    this._logger.info(`[OrderManager] Grupo cerrado: ${tradeId} (${reason})`);
  }

  // ---------------------------------------------------------------------------
  // Consultas
  // ---------------------------------------------------------------------------

  /**
   * Retorna el estado actual del grupo de un trade.
   */
  getGroup(tradeId: string): TradeGroup | null {
    const group = this._tradeGroups.get(tradeId);
    return group ? { ...group } : null;
  }

  /**
   * Retorna los IDs de todos los trades en estado OPEN o WAITING_ENTRY.
   */
  getActiveTradeIds(): string[] {
    const ids: string[] = [];
    for (const [id, group] of this._tradeGroups) {
      if (group.status === 'OPEN' || group.status === 'WAITING_ENTRY') {
        ids.push(id);
      }
    }
    return ids;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Coloca las órdenes de Stop Loss y Take Profits después de confirmar la entrada.
   */
  private async _placeSLandTPs(
    group: TradeGroup,
    stopLoss: number,
    takeProfits: TakeProfit[],
  ): Promise<void> {
    const { symbol, direction, remainingUnits, tradeId } = group;
    const slSide: 'BUY' | 'SELL' = direction === 'LONG' ? 'SELL' : 'BUY';
    const tpSide: 'BUY' | 'SELL' = direction === 'LONG' ? 'SELL' : 'BUY';

    // Colocar Stop Loss
    const slOrder = await this._adapter.placeOrder({
      symbol,
      side:          slSide,
      type:          'STOP_LOSS',
      quantity:      remainingUnits,
      stopPrice:     stopLoss,
      clientOrderId: `${tradeId}-sl`,
    });

    group.slOrderId = slOrder.orderId;

    // Colocar Take Profits
    group.tpOrderIds = [];
    for (let i = 0; i < takeProfits.length; i++) {
      const tp       = takeProfits[i];
      const tpUnits  = remainingUnits * (tp.sizePercent / 100);

      const tpOrder = await this._adapter.placeOrder({
        symbol,
        side:          tpSide,
        type:          'TAKE_PROFIT',
        quantity:      tpUnits,
        price:         tp.price,
        clientOrderId: `${tradeId}-tp${i + 1}`,
      });

      group.tpOrderIds.push(tpOrder.orderId);
    }
  }

  /**
   * Valida que los TPs estén ordenados correctamente según la dirección.
   * LONG: precios de TP deben ser menores a mayores (subiendo desde la entrada)
   * SHORT: precios de TP deben ser mayores a menores (bajando desde la entrada)
   */
  private _validateTakeProfits(tradePlan: TradePlan): void {
    const { direction, takeProfits } = tradePlan;

    if (!takeProfits || takeProfits.length === 0) {
      throw new Error('OrderManager: se requiere al menos un Take Profit');
    }

    for (let i = 1; i < takeProfits.length; i++) {
      const prev = takeProfits[i - 1];
      const curr = takeProfits[i];

      if (direction === 'LONG' && curr.price <= prev.price) {
        throw new Error(
          `OrderManager: TPs desordenados en posición LONG — TP${i} (${curr.price}) ` +
          `debe ser mayor que TP${i - 1} (${prev.price}). ` +
          `Los TPs deben estar ordenados de menor a mayor precio para LONG.`
        );
      }

      if (direction === 'SHORT' && curr.price >= prev.price) {
        throw new Error(
          `OrderManager: TPs desordenados en posición SHORT — TP${i} (${curr.price}) ` +
          `debe ser menor que TP${i - 1} (${prev.price}). ` +
          `Los TPs deben estar ordenados de mayor a menor precio para SHORT.`
        );
      }
    }

    const totalPercent = takeProfits.reduce((sum, tp) => sum + tp.sizePercent, 0);
    if (Math.round(totalPercent) !== 100) {
      throw new Error(
        `OrderManager: la suma de sizePercent de los TPs debe ser 100 ` +
        `(actual: ${totalPercent})`
      );
    }
  }

  /**
   * Obtiene un grupo por tradeId, lanzando si no existe.
   */
  private _getGroup(tradeId: string): TradeGroup {
    const group = this._tradeGroups.get(tradeId);
    if (!group) {
      throw new Error(`OrderManager: trade ${tradeId} no encontrado`);
    }
    return group;
  }
}

export default OrderManager;
