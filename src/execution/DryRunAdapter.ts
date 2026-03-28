import type { OrderResult, Balance, Order, TimeProvider, Logger } from '../types.js';
import BrokerAdapter, { type PlaceOrderParams } from './BrokerAdapter.js';

/**
 * DryRunAdapter.ts
 *
 * Implementación simulada del BrokerAdapter para el modo Dry Run.
 *
 * Responsabilidades:
 *   - Simular fills instantáneos al precio solicitado con slippage configurable
 *   - Mantener estado de órdenes en memoria (no persiste en BD)
 *   - Exponer la misma interfaz que BinanceAdapter — ExecutionEngine no sabe
 *     qué adaptador está usando
 *
 * Comportamiento de fills:
 *   - Órdenes MARKET: fill inmediato al precio de mercado actual con slippage
 *   - Órdenes LIMIT: fill inmediato si el precio actual toca el nivel, o se
 *     registran como pendientes para que el OrderManager las evalúe en cada vela
 *   - Slippage: configurable, default 0.05% — se aplica en contra del trader
 *     (BUY: precio sube, SELL: precio baja)
 *
 * NO hace:
 *   - Persistir estado en base de datos
 *   - Emitir eventos — eso es responsabilidad del ExecutionEngine
 *   - Calcular PnL — eso es responsabilidad del PositionManager
 */

const DEFAULT_SLIPPAGE_PERCENT = 0.05;
const DEFAULT_INITIAL_BALANCE  = 10_000;

let _orderIdCounter = 1;
function generateOrderId(): string {
  return `dry-${Date.now()}-${_orderIdCounter++}`;
}

interface StoredOrder extends Order {
  side: string;
  type: string;
}

interface DryRunAdapterOptions {
  slippagePercent?: number;
  initialBalance?: number;
  timeProvider?: TimeProvider;
  logger?: Logger;
}

class DryRunAdapter extends BrokerAdapter {
  private _slippagePercent: number;
  private _balance: number;
  private _totalBalance: number;
  private _timeProvider: TimeProvider;
  private _logger: Logger;
  private _orders: Map<string, StoredOrder>;
  private _marketPrices: Map<string, number>;

  constructor({
    slippagePercent,
    initialBalance,
    timeProvider,
    logger,
  }: DryRunAdapterOptions = {}) {
    super();

    this._slippagePercent = slippagePercent ?? DEFAULT_SLIPPAGE_PERCENT;
    this._balance         = initialBalance  ?? DEFAULT_INITIAL_BALANCE;
    this._totalBalance    = this._balance;
    this._timeProvider    = timeProvider || { now: () => Date.now() };
    this._logger          = logger || {
      info:  (...a: unknown[]) => console.log('[DryRunAdapter]', ...a),
      warn:  (...a: unknown[]) => console.warn('[DryRunAdapter]', ...a),
      error: (...a: unknown[]) => console.error('[DryRunAdapter]', ...a),
    };

    // Estado en memoria
    // Map<orderId, StoredOrder>
    this._orders = new Map();

    // Precio de mercado actual por símbolo (actualizado externamente via updateMarketPrice)
    // Map<symbol, number>
    this._marketPrices = new Map();
  }

  // ---------------------------------------------------------------------------
  // Interfaz pública (BrokerAdapter)
  // ---------------------------------------------------------------------------

  /**
   * Simula la colocación de una orden.
   *
   * Para órdenes MARKET: fill inmediato con slippage.
   * Para órdenes LIMIT/STOP_LOSS/TAKE_PROFIT: se registran como 'PENDING'
   * y se evalúan cuando se actualiza el precio de mercado.
   */
  async placeOrder(order: PlaceOrderParams): Promise<OrderResult> {
    this._validateOrder(order);

    const orderId = order.clientOrderId || generateOrderId();
    const now     = this._timeProvider.now();

    const stored: StoredOrder = {
      orderId,
      symbol:    order.symbol,
      side:      order.side,
      type:      order.type,
      quantity:  order.quantity,
      price:     order.price     ?? null,
      stopPrice: order.stopPrice ?? null,
      status:    'PENDING',
      createdAt: now,
      filledAt:  null,
      fillPrice: null,
    };

    if (order.type === 'MARKET') {
      const marketPrice = this._getMarketPrice(order.symbol);
      const fillPrice   = this._applySlippage(marketPrice, order.side as 'BUY' | 'SELL');

      stored.status    = 'FILLED';
      stored.fillPrice = fillPrice;
      stored.filledAt  = now;

      this._logger.info(
        `[DryRun] MARKET ${order.side} ${order.quantity} ${order.symbol} @ ${fillPrice} ` +
        `(slippage: ${this._slippagePercent}%)`
      );
    } else {
      // Para órdenes límite/stop, verificar si el precio actual ya satisface la condición.
      const currentPrice = this._marketPrices.get(order.symbol);
      if (currentPrice !== undefined && this._isTriggered(stored, currentPrice)) {
        const fillPrice  = this._applySlippage(currentPrice, order.side as 'BUY' | 'SELL');
        stored.status    = 'FILLED';
        stored.fillPrice = fillPrice;
        stored.filledAt  = now;

        this._logger.info(
          `[DryRun] ${order.type} ${order.side} ${order.quantity} ${order.symbol} ` +
          `@ ${fillPrice} — llenado inmediato (precio actual satisface el nivel)`
        );
      } else {
        this._logger.info(
          `[DryRun] ${order.type} ${order.side} ${order.quantity} ${order.symbol} ` +
          `@ ${order.price ?? order.stopPrice} — en espera`
        );
      }
    }

    this._orders.set(orderId, stored);

    const result: OrderResult = { orderId, status: stored.status as OrderResult['status'] };
    if (stored.fillPrice !== null) {
      result.fillPrice = stored.fillPrice;
    }
    return result;
  }

  /**
   * Cancela una orden pendiente.
   */
  async cancelOrder(orderId: string, _symbol?: string): Promise<{ success: boolean }> {
    const order = this._orders.get(orderId);

    if (!order) {
      this._logger.warn(`[DryRun] cancelOrder: orden ${orderId} no encontrada`);
      return { success: false };
    }

    if (order.status === 'FILLED') {
      this._logger.warn(`[DryRun] cancelOrder: orden ${orderId} ya está llena, no se puede cancelar`);
      return { success: false };
    }

    order.status = 'CANCELED';
    this._logger.info(`[DryRun] Orden ${orderId} cancelada`);
    return { success: true };
  }

  /**
   * Retorna las órdenes activas (PENDING), opcionalmente filtradas por símbolo.
   */
  async getOpenOrders(symbol?: string): Promise<Order[]> {
    const open: Order[] = [];
    for (const order of this._orders.values()) {
      if (order.status !== 'PENDING') continue;
      if (symbol && order.symbol !== symbol) continue;
      open.push({ ...order });
    }
    return open;
  }

  /**
   * Retorna el balance disponible simulado.
   */
  async getBalance(): Promise<Balance> {
    return {
      available: this._balance,
      total:     this._totalBalance,
    };
  }

  // ---------------------------------------------------------------------------
  // API específica del DryRunAdapter (no presente en BrokerAdapter)
  // ---------------------------------------------------------------------------

  /**
   * Actualiza el precio de mercado actual para un símbolo.
   * Llamado por el ExecutionEngine cuando llega MARKET_CANDLE_CLOSED.
   * Tras actualizar, evalúa si alguna orden pendiente debe llenarse.
   */
  updateMarketPrice(symbol: string, price: number): { filled: Order[] } {
    this._marketPrices.set(symbol, price);
    return this._evaluatePendingOrders(symbol, price);
  }

  /**
   * Retorna el historial completo de órdenes (útil para reporting).
   */
  getAllOrders(): Order[] {
    return Array.from(this._orders.values()).map(o => ({ ...o }));
  }

  /**
   * Resetea el estado interno (útil entre corridas de test).
   */
  reset(newBalance?: number): void {
    this._orders.clear();
    this._marketPrices.clear();
    if (newBalance !== undefined) {
      this._balance      = newBalance;
      this._totalBalance = newBalance;
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Aplica slippage al precio en función del lado de la orden.
   * BUY: precio sube (más caro para el comprador).
   * SELL: precio baja (menos ingresos para el vendedor).
   */
  private _applySlippage(price: number, side: 'BUY' | 'SELL'): number {
    const factor = this._slippagePercent / 100;
    if (side === 'BUY') {
      return price * (1 + factor);
    }
    return price * (1 - factor);
  }

  /**
   * Obtiene el precio de mercado actual para un símbolo.
   * Si no está registrado, lanza un error descriptivo.
   */
  private _getMarketPrice(symbol: string): number {
    const price = this._marketPrices.get(symbol);
    if (price === undefined) {
      throw new Error(
        `DryRunAdapter: no hay precio de mercado registrado para ${symbol}. ` +
        `Llama updateMarketPrice(symbol, price) antes de colocar órdenes MARKET.`
      );
    }
    return price;
  }

  /**
   * Evalúa las órdenes pendientes de un símbolo dado el nuevo precio.
   * Llena las órdenes cuyo nivel fue tocado.
   */
  private _evaluatePendingOrders(symbol: string, currentPrice: number): { filled: Order[] } {
    const filled: Order[] = [];
    const now    = this._timeProvider.now();

    for (const order of this._orders.values()) {
      if (order.status !== 'PENDING') continue;
      if (order.symbol !== symbol)    continue;

      const triggered = this._isTriggered(order, currentPrice);
      if (!triggered) continue;

      const fillPrice      = this._applySlippage(currentPrice, order.side as 'BUY' | 'SELL');
      order.status         = 'FILLED';
      order.fillPrice      = fillPrice;
      order.filledAt       = now;

      filled.push({ ...order });

      this._logger.info(
        `[DryRun] Orden ${order.orderId} llenada: ${order.type} ${order.side} ` +
        `${order.quantity} ${symbol} @ ${fillPrice}`
      );
    }

    return { filled };
  }

  /**
   * Determina si una orden debe dispararse dado el precio actual.
   */
  private _isTriggered(order: StoredOrder, currentPrice: number): boolean {
    const { type, side, price, stopPrice } = order;

    switch (type) {
      case 'LIMIT':
        // LIMIT BUY: compra si el precio baja al nivel o más bajo
        if (side === 'BUY')  return currentPrice <= (price ?? Infinity);
        // LIMIT SELL: vende si el precio sube al nivel o más alto
        if (side === 'SELL') return currentPrice >= (price ?? -Infinity);
        break;

      case 'STOP_LOSS':
        // STOP_LOSS SELL (protección en LONG): dispara si el precio baja al stop
        if (side === 'SELL') return currentPrice <= (stopPrice ?? Infinity);
        // STOP_LOSS BUY (protección en SHORT): dispara si el precio sube al stop
        if (side === 'BUY')  return currentPrice >= (stopPrice ?? -Infinity);
        break;

      case 'TAKE_PROFIT':
        // TAKE_PROFIT SELL (toma de ganancias en LONG): dispara si el precio sube al nivel
        if (side === 'SELL') return currentPrice >= (price ?? -Infinity);
        // TAKE_PROFIT BUY (toma de ganancias en SHORT): dispara si el precio baja al nivel
        if (side === 'BUY')  return currentPrice <= (price ?? Infinity);
        break;

      default:
        return false;
    }

    return false;
  }

  /**
   * Valida los campos obligatorios de una orden antes de procesarla.
   */
  private _validateOrder(order: PlaceOrderParams): void {
    if (!order.symbol)   throw new Error('DryRunAdapter.placeOrder: se requiere symbol');
    if (!order.side)     throw new Error('DryRunAdapter.placeOrder: se requiere side');
    if (!order.type)     throw new Error('DryRunAdapter.placeOrder: se requiere type');
    if (!order.quantity || order.quantity <= 0) {
      throw new Error('DryRunAdapter.placeOrder: quantity debe ser mayor a 0');
    }

    if (order.type === 'LIMIT' && !order.price) {
      throw new Error('DryRunAdapter.placeOrder: se requiere price para órdenes LIMIT');
    }
    if (order.type === 'STOP_LOSS' && !order.stopPrice) {
      throw new Error('DryRunAdapter.placeOrder: se requiere stopPrice para órdenes STOP_LOSS');
    }
    if (order.type === 'TAKE_PROFIT' && !order.price) {
      throw new Error('DryRunAdapter.placeOrder: se requiere price para órdenes TAKE_PROFIT');
    }
  }
}

export default DryRunAdapter;
