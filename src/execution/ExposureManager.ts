import type { TradePlan, TradeSize, ExposureCheck, Logger } from '../types.js';
import type BrokerAdapter from './BrokerAdapter.js';

/**
 * ExposureManager.ts
 *
 * Fuente única de verdad sobre el riesgo activo del sistema.
 *
 * Responsabilidades:
 *   - Validar si un TradePlan puede ejecutarse según las reglas de riesgo
 *   - Calcular el tamaño de posición basado en riskPercent y balance disponible
 *   - Rastrear el riesgo activo total para impedir sobreexposición
 *   - Actualizar su estado cuando se abren y cierran trades
 *
 * Reglas de riesgo configurables:
 *   - maxRiskPerTradePercent: riesgo máximo por trade individual (default 2%)
 *   - maxOpenTrades:          número máximo de posiciones simultáneas (default 5)
 *   - maxRiskPerSymbolPercent: exposición máxima por símbolo (default 5%)
 *   - maxTotalRiskPercent:     riesgo total máximo del portafolio (default 10%)
 *
 * NO hace:
 *   - Colocar órdenes — eso es ExecutionEngine
 *   - Persistir posiciones — eso es PositionManager
 *   - Calcular PnL — eso es PositionManager
 */

interface ExposureConfig {
  maxRiskPerTradePercent?: number;
  maxOpenTrades?: number;
  maxRiskPerSymbolPercent?: number;
  maxTotalRiskPercent?: number;
}

interface ActiveTradeRecord {
  symbol: string;
  riskPercent: number;
  riskAmount: number;
}

const DEFAULT_CONFIG: Required<ExposureConfig> = {
  maxRiskPerTradePercent:  2,
  maxOpenTrades:           5,
  maxRiskPerSymbolPercent: 5,
  maxTotalRiskPercent:     10,
};

interface ExposureManagerDeps {
  brokerAdapter: Pick<BrokerAdapter, 'getBalance'>;
  config?: ExposureConfig;
  logger?: Logger;
}

class ExposureManager {
  private _adapter: Pick<BrokerAdapter, 'getBalance'>;
  private _config: Required<ExposureConfig>;
  private _logger: Logger;
  private _activeTrades: Map<string, ActiveTradeRecord>;

  constructor({ brokerAdapter, config, logger }: ExposureManagerDeps) {
    if (!brokerAdapter) throw new Error('ExposureManager: se requiere brokerAdapter');

    this._adapter = brokerAdapter;
    this._config  = { ...DEFAULT_CONFIG, ...(config || {}) };
    this._logger  = logger || {
      info:  (...a: unknown[]) => console.log('[ExposureManager]', ...a),
      warn:  (...a: unknown[]) => console.warn('[ExposureManager]', ...a),
      error: (...a: unknown[]) => console.error('[ExposureManager]', ...a),
    };

    // Estado de riesgo activo
    // Map<tradeId, { symbol, riskPercent, riskAmount }>
    this._activeTrades = new Map();
  }

  // ---------------------------------------------------------------------------
  // Interfaz pública
  // ---------------------------------------------------------------------------

  /**
   * Verifica si un TradePlan puede ejecutarse sin violar las reglas de riesgo.
   */
  async canExecute(tradePlan: TradePlan): Promise<ExposureCheck> {
    const { symbol, riskPercent } = tradePlan;

    // 1. Validar riskPercent del trade individual
    if (riskPercent > this._config.maxRiskPerTradePercent) {
      const reason =
        `riskPercent ${riskPercent}% supera el máximo por trade ` +
        `(${this._config.maxRiskPerTradePercent}%)`;
      this._logger.warn(`[ExposureManager] Señal rechazada: ${reason}`);
      return { allowed: false, reason };
    }

    // 2. Validar número máximo de posiciones abiertas
    if (this._activeTrades.size >= this._config.maxOpenTrades) {
      const reason =
        `número de posiciones abiertas (${this._activeTrades.size}) alcanzó ` +
        `el máximo (${this._config.maxOpenTrades})`;
      this._logger.warn(`[ExposureManager] Señal rechazada: ${reason}`);
      return { allowed: false, reason };
    }

    // 3. Validar exposición máxima por símbolo
    const symbolRisk = this._getRiskBySymbol(symbol);
    if (symbolRisk + riskPercent > this._config.maxRiskPerSymbolPercent) {
      const reason =
        `riesgo en ${symbol} (${symbolRisk}% activo + ${riskPercent}% nuevo = ` +
        `${symbolRisk + riskPercent}%) superaría el máximo por símbolo ` +
        `(${this._config.maxRiskPerSymbolPercent}%)`;
      this._logger.warn(`[ExposureManager] Señal rechazada: ${reason}`);
      return { allowed: false, reason };
    }

    // 4. Validar riesgo total del portafolio
    const totalRisk = this._getTotalRisk();
    if (totalRisk + riskPercent > this._config.maxTotalRiskPercent) {
      const reason =
        `riesgo total (${totalRisk}% activo + ${riskPercent}% nuevo = ` +
        `${totalRisk + riskPercent}%) superaría el máximo del portafolio ` +
        `(${this._config.maxTotalRiskPercent}%)`;
      this._logger.warn(`[ExposureManager] Señal rechazada: ${reason}`);
      return { allowed: false, reason };
    }

    return { allowed: true };
  }

  /**
   * Calcula el tamaño de posición para asumir exactamente riskPercent del balance.
   */
  async calculateSize(tradePlan: TradePlan): Promise<TradeSize> {
    const { entryPrice, stopLoss, riskPercent } = tradePlan;

    const { available: balance } = await this._adapter.getBalance();

    const riskAmount  = balance * (riskPercent / 100);
    const riskPerUnit = Math.abs(entryPrice - stopLoss);

    if (riskPerUnit === 0) {
      throw new Error(
        'ExposureManager.calculateSize: entryPrice y stopLoss son iguales — ' +
        'imposible calcular tamaño (división por cero)'
      );
    }

    const units    = riskAmount / riskPerUnit;
    const notional = units * entryPrice;

    return { units, notional, riskAmount };
  }

  /**
   * Retorna la exposición actual del portafolio.
   */
  async getCurrentExposure(): Promise<{ openRisk: number; openTrades: number }> {
    return {
      openRisk:   this._getTotalRisk(),
      openTrades: this._activeTrades.size,
    };
  }

  // ---------------------------------------------------------------------------
  // Gestión de estado de trades activos
  // ---------------------------------------------------------------------------

  /**
   * Registra un trade abierto para contabilizar su riesgo.
   * Llamado por ExecutionEngine tras abrir una posición.
   */
  registerOpenTrade(
    tradeId: string,
    symbol: string,
    riskPercent: number,
    riskAmount: number,
  ): void {
    if (this._activeTrades.has(tradeId)) {
      this._logger.warn(
        `[ExposureManager] registerOpenTrade: trade ${tradeId} ya está registrado`
      );
      return;
    }

    this._activeTrades.set(tradeId, { symbol, riskPercent, riskAmount });
    this._logger.info(
      `[ExposureManager] Trade ${tradeId} registrado: ${symbol} ` +
      `riesgo=${riskPercent}% (${riskAmount})`
    );
  }

  /**
   * Elimina un trade del registro de exposición activa.
   * Llamado por ExecutionEngine cuando un trade es cerrado.
   */
  unregisterTrade(tradeId: string): void {
    if (!this._activeTrades.has(tradeId)) {
      this._logger.warn(
        `[ExposureManager] unregisterTrade: trade ${tradeId} no encontrado`
      );
      return;
    }

    this._activeTrades.delete(tradeId);
    this._logger.info(`[ExposureManager] Trade ${tradeId} eliminado del registro de exposición`);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Suma el riskPercent de todos los trades activos en un símbolo.
   */
  private _getRiskBySymbol(symbol: string): number {
    let total = 0;
    for (const trade of this._activeTrades.values()) {
      if (trade.symbol === symbol) {
        total += trade.riskPercent;
      }
    }
    return total;
  }

  /**
   * Suma el riskPercent de todos los trades activos en el portafolio.
   */
  private _getTotalRisk(): number {
    let total = 0;
    for (const trade of this._activeTrades.values()) {
      total += trade.riskPercent;
    }
    return total;
  }
}

export default ExposureManager;
