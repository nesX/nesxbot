import type { OrderResult, Balance, Order } from '../types.js';

/**
 * BrokerAdapter.ts
 *
 * Interfaz abstracta que todo adaptador de broker debe implementar.
 *
 * Responsabilidades:
 *   - Define el contrato formal entre ExecutionEngine y cualquier broker concreto
 *   - BinanceAdapter y DryRunAdapter implementan esta interfaz
 *   - ExecutionEngine nunca sabe qué implementación concreta está usando
 *
 * Regla fundamental: si un método no está implementado en la subclase, lanza
 * un error descriptivo en lugar de fallar silenciosamente.
 */

export interface PlaceOrderParams {
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'MARKET' | 'LIMIT' | 'STOP_LOSS' | 'TAKE_PROFIT';
  quantity: number;
  price?: number;
  stopPrice?: number;
  clientOrderId?: string;
}

abstract class BrokerAdapter {
  /**
   * Coloca una orden en el broker.
   */
  async placeOrder(_order: PlaceOrderParams): Promise<OrderResult> {
    throw new Error(`${this.constructor.name}: debe implementar placeOrder(order)`);
  }

  /**
   * Cancela una orden activa.
   */
  async cancelOrder(_orderId: string, _symbol: string): Promise<{ success: boolean }> {
    throw new Error(`${this.constructor.name}: debe implementar cancelOrder(orderId, symbol)`);
  }

  /**
   * Retorna todas las órdenes abiertas, opcionalmente filtradas por símbolo.
   */
  async getOpenOrders(_symbol?: string): Promise<Order[]> {
    throw new Error(`${this.constructor.name}: debe implementar getOpenOrders(symbol)`);
  }

  /**
   * Retorna el balance disponible en la cuenta.
   */
  async getBalance(): Promise<Balance> {
    throw new Error(`${this.constructor.name}: debe implementar getBalance()`);
  }
}

export default BrokerAdapter;
