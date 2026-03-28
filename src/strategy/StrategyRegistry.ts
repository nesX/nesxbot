/**
 * StrategyRegistry.ts
 *
 * Registro central de estrategias disponibles en NesxTrader.
 *
 * Responsabilidades:
 *   - Almacenar instancias de estrategias indexadas por su id
 *   - Validar que toda estrategia registrada implementa StrategyBase correctamente
 *   - Resolver estrategias por id para el StrategyEngine
 *
 * Regla de diseño:
 *   El StrategyEngine nunca importa una estrategia directamente.
 *   Solo interactúa con ellas a través de este Registry.
 *   Agregar una nueva estrategia = crear el archivo + registrarla aquí.
 *   Cero cambios en StrategyEngine.
 */

import StrategyBase from './StrategyBase.js';

class StrategyRegistry {
  private _strategies: Map<string, StrategyBase>;

  constructor() {
    this._strategies = new Map();
  }

  /**
   * Registra una estrategia en el Registry.
   *
   * Validaciones:
   *   - Debe ser instancia de StrategyBase
   *   - Debe tener un `id` string no vacío
   *   - Debe tener `requiredTimeframes` como array no vacío
   *   - No puede registrarse dos estrategias con el mismo id
   *
   * @throws {Error} si la estrategia no cumple el contrato
   */
  register(strategy: StrategyBase): void {
    if (!(strategy instanceof StrategyBase)) {
      throw new Error(
        `StrategyRegistry.register: la estrategia debe ser instancia de StrategyBase. ` +
        `Recibido: ${(strategy as unknown as { constructor?: { name?: string } })?.constructor?.name ?? typeof strategy}`
      );
    }

    // Acceder a id dispara el getter — si no está implementado, lanza aquí
    let strategyId: string;
    try {
      strategyId = strategy.id;
    } catch (err) {
      throw new Error(
        `StrategyRegistry.register: strategy.id lanzó error — ${(err as Error).message}`
      );
    }

    if (typeof strategyId !== 'string' || strategyId.trim() === '') {
      throw new Error(
        `StrategyRegistry.register: strategy.id debe ser un string no vacío. ` +
        `Recibido: ${JSON.stringify(strategyId)}`
      );
    }

    // Acceder a requiredTimeframes — si no está implementado, lanza aquí
    let timeframes: string[];
    try {
      timeframes = strategy.requiredTimeframes;
    } catch (err) {
      throw new Error(
        `StrategyRegistry.register: strategy.requiredTimeframes lanzó error — ${(err as Error).message}`
      );
    }

    if (!Array.isArray(timeframes) || timeframes.length === 0) {
      throw new Error(
        `StrategyRegistry.register: strategy.requiredTimeframes debe ser un array no vacío ` +
        `en estrategia '${strategyId}'. Recibido: ${JSON.stringify(timeframes)}`
      );
    }

    if (this._strategies.has(strategyId)) {
      throw new Error(
        `StrategyRegistry.register: ya existe una estrategia con id '${strategyId}'`
      );
    }

    this._strategies.set(strategyId, strategy);
  }

  /**
   * Resuelve una estrategia por su id.
   *
   * @throws {Error} si el id no está registrado
   */
  resolve(id: string): StrategyBase {
    const strategy = this._strategies.get(id);
    if (!strategy) {
      const available = Array.from(this._strategies.keys()).join(', ') || '(ninguna)';
      throw new Error(
        `StrategyRegistry.resolve: estrategia '${id}' no encontrada. ` +
        `Disponibles: ${available}`
      );
    }
    return strategy;
  }

  /**
   * Retorna todas las estrategias registradas.
   */
  getAll(): StrategyBase[] {
    return Array.from(this._strategies.values());
  }

  /**
   * Retorna true si la estrategia con ese id está registrada.
   */
  has(id: string): boolean {
    return this._strategies.has(id);
  }

  /**
   * Cantidad de estrategias registradas.
   */
  get size(): number {
    return this._strategies.size;
  }
}

export default StrategyRegistry;
