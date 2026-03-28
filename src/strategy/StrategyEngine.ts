import type { TradePlan, TimeProvider, MessageBroker, Logger } from '../types.js';
import type StrategyBase from './StrategyBase.js';
import type StrategyRegistry from './StrategyRegistry.js';
import type MarketStateBuilder from './MarketStateBuilder.js';

/**
 * StrategyEngine.ts
 *
 * Orquestador principal del módulo Strategy.
 *
 * Responsabilidades:
 *   - Suscribirse al evento MARKET_CANDLE_CLOSED del MessageBroker
 *   - Mantener el MarketState actualizado por par/timeframe via MarketStateBuilder
 *   - Para cada nueva vela, llamar strategy.evaluate(state) en todas las estrategias
 *     que operan sobre ese símbolo
 *   - Emitir STRATEGY_SIGNAL_GENERATED cuando evaluate() retorna un TradePlan
 *   - Emitir STRATEGY_ZONE_ARMED / STRATEGY_ZONE_DISARMED cuando las estrategias
 *     notifican cambios de zona
 *   - Capturar y loggear excepciones en evaluate() sin romper el loop principal
 *
 * NO hace:
 *   - Ejecutar órdenes (→ ExecutionEngine)
 *   - Calcular tamaño de posición (→ ExposureManager)
 *   - Persistir señales (→ Motor BD)
 *   - Importar estrategias directamente (→ StrategyRegistry)
 *
 * Relación con StrategyRegistry:
 *   El Engine recibe el Registry ya poblado. Nunca importa ni instancia estrategias.
 *   Para añadir una estrategia nueva: crear archivo + registrar en Registry. Cero
 *   cambios en este archivo.
 */

interface ZonePayload extends Record<string, unknown> {
  strategyId: string;
  symbol: string;
}

interface CandleClosedPayload extends Record<string, unknown> {
  symbol: string;
  timeframe: string;
}

interface StrategyEngineDeps {
  messageBroker: MessageBroker;
  strategyRegistry: StrategyRegistry;
  marketStateBuilder: MarketStateBuilder;
  timeProvider: TimeProvider;
  logger?: Logger;
}

class StrategyEngine {
  private _broker: MessageBroker;
  private _registry: StrategyRegistry;
  private _builder: MarketStateBuilder;
  private _timeProvider: TimeProvider;
  private _logger: Logger;
  private _running: boolean;

  constructor({ messageBroker, strategyRegistry, marketStateBuilder, timeProvider, logger }: StrategyEngineDeps) {
    if (!messageBroker)      throw new Error('StrategyEngine: se requiere messageBroker');
    if (!strategyRegistry)   throw new Error('StrategyEngine: se requiere strategyRegistry');
    if (!marketStateBuilder) throw new Error('StrategyEngine: se requiere marketStateBuilder');
    if (!timeProvider)       throw new Error('StrategyEngine: se requiere timeProvider');

    this._broker       = messageBroker;
    this._registry     = strategyRegistry;
    this._builder      = marketStateBuilder;
    this._timeProvider = timeProvider;
    this._logger       = logger ?? {
      info:  (...a: unknown[]) => console.log('[StrategyEngine]', ...a),
      warn:  (...a: unknown[]) => console.warn('[StrategyEngine]', ...a),
      error: (...a: unknown[]) => console.error('[StrategyEngine]', ...a),
    };

    this._running = false;
  }

  /**
   * Inicia el StrategyEngine.
   *
   * Conecta los callbacks de zona de todas las estrategias que los soporten y
   * se suscribe al canal MARKET_CANDLE_CLOSED del MessageBroker.
   */
  start(): void {
    if (this._running) {
      this._logger.warn('StrategyEngine ya está corriendo — ignorando start()');
      return;
    }

    this._running = true;

    // Conectar los callbacks de zona a cada estrategia que los soporte
    // (las que exponen onZoneArmed/onZoneDisarmed como opciones de constructor
    //  ya los tienen; aquí no hacemos nada adicional porque los callbacks se
    //  inyectan en el constructor de la estrategia antes de registrarla).
    // Ver FibonacciVolumeStrategy para el patrón.

    this._broker.subscribe('MARKET_CANDLE_CLOSED', (payload) => {
      // Retornamos la promesa para que los callers que await-an el handler
      // (ej. el broker en modo backtest síncrono o los tests unitarios)
      // puedan esperar a que el procesamiento complete.
      // El .catch() al final garantiza que los errores no capturados no
      // se conviertan en unhandled promise rejections en producción.
      return this._handleCandleClosed(payload as CandleClosedPayload).catch(err => {
        this._logger.error(
          `StrategyEngine: error no capturado en _handleCandleClosed — ${(err as Error).message}`,
          err
        );
      });
    });

    this._logger.info('StrategyEngine iniciado');
  }

  /**
   * Detiene el StrategyEngine (deja de procesar nuevas velas).
   */
  stop(): void {
    if (!this._running) return;
    this._running = false;
    this._logger.info('StrategyEngine detenido');
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Handler principal: procesa un evento MARKET_CANDLE_CLOSED.
   */
  private async _handleCandleClosed(payload: CandleClosedPayload): Promise<void> {
    if (!this._running) return;

    // 1. Actualizar el MarketStateBuilder con la nueva vela
    this._builder.addCandle(payload as Parameters<MarketStateBuilder['addCandle']>[0]);

    const { symbol } = payload;
    const strategies = this._registry.getAll();

    // 2. Evaluar todas las estrategias que requieren este símbolo
    for (const strategy of strategies) {
      await this._evaluateStrategy(strategy, symbol);
    }
  }

  /**
   * Llama evaluate() en una estrategia y maneja su resultado.
   * Las excepciones se capturan y loggean — no rompen el loop.
   */
  private async _evaluateStrategy(strategy: StrategyBase, symbol: string): Promise<void> {
    let state;
    try {
      state = this._builder.build(symbol, strategy.requiredTimeframes);
    } catch (err) {
      this._logger.error(
        `StrategyEngine: no se pudo construir MarketState para ` +
        `'${strategy.id}' / ${symbol} — ${(err as Error).message}`
      );
      return;
    }

    let tradePlan: TradePlan | null | undefined;
    try {
      tradePlan = await strategy.evaluate(state);
    } catch (err) {
      this._logger.error(
        `StrategyEngine: excepción en ${strategy.id}.evaluate() para ${symbol} — ` +
        `${(err as Error).message}`,
        err
      );
      return; // Continúa con la siguiente estrategia
    }

    if (tradePlan !== null && tradePlan !== undefined) {
      await this._emitSignal(tradePlan);
    }
  }

  /**
   * Emite el evento STRATEGY_SIGNAL_GENERATED con el TradePlan.
   */
  private async _emitSignal(tradePlan: TradePlan): Promise<void> {
    try {
      await this._broker.publish('STRATEGY_SIGNAL_GENERATED', { tradePlan: tradePlan as unknown as Record<string, unknown> });
      this._logger.info(
        `Señal generada: ${tradePlan.strategyId} ${tradePlan.symbol} ` +
        `${tradePlan.direction} @ ${tradePlan.entryPrice}`
      );
    } catch (err) {
      this._logger.error(
        `StrategyEngine: error emitiendo STRATEGY_SIGNAL_GENERATED — ${(err as Error).message}`
      );
    }
  }

  /**
   * Emite STRATEGY_ZONE_ARMED.
   * Llamado por el callback onZoneArmed de la estrategia.
   */
  async emitZoneArmed(zonePayload: ZonePayload): Promise<void> {
    try {
      await this._broker.publish('STRATEGY_ZONE_ARMED', zonePayload);
      this._logger.info(
        `Zona armada: ${zonePayload.strategyId} ${zonePayload.symbol}`
      );
    } catch (err) {
      this._logger.error(
        `StrategyEngine: error emitiendo STRATEGY_ZONE_ARMED — ${(err as Error).message}`
      );
    }
  }

  /**
   * Emite STRATEGY_ZONE_DISARMED.
   * Llamado por el callback onZoneDisarmed de la estrategia.
   */
  async emitZoneDisarmed(zonePayload: ZonePayload & { reason?: string }): Promise<void> {
    try {
      await this._broker.publish('STRATEGY_ZONE_DISARMED', zonePayload);
      this._logger.info(
        `Zona desarmada: ${zonePayload.strategyId} ${zonePayload.symbol} — ${zonePayload.reason}`
      );
    } catch (err) {
      this._logger.error(
        `StrategyEngine: error emitiendo STRATEGY_ZONE_DISARMED — ${(err as Error).message}`
      );
    }
  }
}

export default StrategyEngine;
