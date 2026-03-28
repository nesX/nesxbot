import type { MarketState, TradePlan } from '../types.js';

/**
 * StrategyBase.ts
 *
 * Contrato formal que toda estrategia de NesxTrader debe implementar.
 * No contiene lógica de negocio — solo define la interfaz obligatoria.
 *
 * Reglas de implementación:
 *   - `id` debe ser un string único y estable (se usa como clave en el Registry)
 *   - `requiredTimeframes` debe retornar el conjunto mínimo de timeframes
 *     que la estrategia necesita para funcionar correctamente
 *   - `evaluate()` debe ser lo más pura posible: el estado interno de
 *     la estrategia (zonas armadas, niveles activos) debe ser explícito
 *     y no depender de efectos secundarios externos
 *   - `evaluate()` retorna null si no hay señal en este momento
 *   - `evaluate()` nunca emite eventos directamente — eso es responsabilidad
 *     del StrategyEngine
 */
abstract class StrategyBase {
  /**
   * Identificador único de la estrategia.
   * Convención de nombres: kebab-case con versión. Ej: 'fibonacci-volume-v1'
   */
  abstract get id(): string;

  /**
   * Lista de timeframes que la estrategia necesita en su MarketState.
   * El StrategyEngine garantiza que candles[tf] existe para cada tf de esta lista.
   */
  abstract get requiredTimeframes(): string[];

  /**
   * Evalúa el estado actual del mercado y decide si hay una oportunidad de trading.
   *
   * @param state - Estado del mercado para el símbolo y momento actual
   * @returns TradePlan si hay señal, null si no hay nada
   */
  abstract evaluate(state: MarketState): Promise<TradePlan | null>;
}

export default StrategyBase;
