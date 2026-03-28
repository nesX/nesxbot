import type { FillResult, BacktestReport, BacktestConfig, Candle, MessageBroker, Logger } from '../types.js';

interface ReplayProvider {
  replay(symbol: string, timeframe: string, from: number, to: number): Promise<number>;
}

interface StrategyEngine {
  start(): void;
  stop(): void;
}

interface FillSimulator {
  simulateFill(tradePlan: unknown, contextCandle: Candle): Promise<FillResult>;
}

interface MetricsCalculator {
  calculate(fills: FillResult[], initialCapital: number): import('../types.js').Metrics;
}

interface BacktestRepositoryDep {
  saveRun(report: BacktestReport): Promise<string>;
}

interface RunConfig {
  strategyId: string;
  symbol: string;
  timeframe: string;
  from: number;
  to: number;
  initialCapital: number;
  riskPercent?: number;
  warmupCandles?: number;
}

class BacktestRunner {
  private _replay: ReplayProvider;
  private _strategy: StrategyEngine;
  private _fills: FillSimulator;
  private _metrics: MetricsCalculator;
  private _repo: BacktestRepositoryDep;
  private _broker: MessageBroker;
  private _logger: Logger;
  private _lastCandle: Candle | null = null;

  constructor({
    replayProvider,
    strategyEngine,
    fillSimulator,
    metricsCalculator,
    backtestRepository,
    messageBroker,
    logger,
  }: {
    replayProvider: ReplayProvider;
    strategyEngine: StrategyEngine;
    fillSimulator: FillSimulator;
    metricsCalculator: MetricsCalculator;
    backtestRepository: BacktestRepositoryDep;
    messageBroker: MessageBroker;
    logger?: Logger;
  }) {
    if (!replayProvider)     throw new Error('BacktestRunner: se requiere replayProvider');
    if (!strategyEngine)     throw new Error('BacktestRunner: se requiere strategyEngine');
    if (!fillSimulator)      throw new Error('BacktestRunner: se requiere fillSimulator');
    if (!metricsCalculator)  throw new Error('BacktestRunner: se requiere metricsCalculator');
    if (!backtestRepository) throw new Error('BacktestRunner: se requiere backtestRepository');
    if (!messageBroker)      throw new Error('BacktestRunner: se requiere messageBroker');

    this._replay   = replayProvider;
    this._strategy = strategyEngine;
    this._fills    = fillSimulator;
    this._metrics  = metricsCalculator;
    this._repo     = backtestRepository;
    this._broker   = messageBroker;
    this._logger   = logger || {
      info:  (...a: unknown[]) => console.log('[BacktestRunner]', ...a),
      warn:  (...a: unknown[]) => console.warn('[BacktestRunner]', ...a),
      error: (...a: unknown[]) => console.error('[BacktestRunner]', ...a),
    };
  }

  /**
   * Ejecuta una corrida completa de backtest.
   */
  async run(config: RunConfig): Promise<BacktestReport> {
    this._validateConfig(config);

    const {
      strategyId,
      symbol,
      timeframe,
      from,
      to,
      initialCapital,
      riskPercent = 1,
      warmupCandles = 0,
    } = config;

    // Las velas de warm-up se piden antes de `from` para llenar el buffer
    // de la estrategia. Un minuto por vela asumiendo timeframe 1m.
    const ONE_MINUTE_MS = 60_000;
    const replayFrom = warmupCandles > 0
      ? from - warmupCandles * ONE_MINUTE_MS
      : from;

    this._logger.info(
      `Iniciando backtest: strategy=${strategyId} symbol=${symbol} ` +
      `timeframe=${timeframe} ` +
      `${new Date(from).toISOString()} → ${new Date(to).toISOString()}` +
      (warmupCandles > 0 ? ` (warm-up: ${warmupCandles} velas)` : '')
    );

    const fillResults: FillResult[] = [];

    // Las señales emitidas antes de `from` (período de warm-up) se ignoran
    const unsubscribe = this._subscribeToSignals(fillResults, symbol, config, from);

    this._strategy.start();

    let totalCandles = 0;
    try {
      totalCandles = await this._replay.replay(symbol, timeframe, replayFrom, to);
    } finally {
      this._strategy.stop();
      unsubscribe();
    }

    this._logger.info(
      `Replay completado: ${totalCandles} velas procesadas, ` +
      `${fillResults.length} trades simulados`
    );

    const metrics = this._metrics.calculate(fillResults, initialCapital);

    const backtestConfig: BacktestConfig = {
      strategyId,
      symbol,
      timeframe,
      from,
      to,
      initialCapital,
      riskPercent,
    };

    const report: BacktestReport = {
      config:  backtestConfig,
      metrics,
      trades:  fillResults,
    };

    try {
      const runId = await this._repo.saveRun(report);
      report.id   = runId;
      this._logger.info(`Corrida persistida con id=${runId}`);
    } catch (err) {
      this._logger.error(`Error persistiendo corrida: ${(err as Error).message}`);
    }

    return report;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private _subscribeToSignals(
    fillResults: FillResult[],
    symbol: string,
    config: RunConfig,
    signalFrom: number
  ): () => void {
    const handler = async (payload: unknown) => {
      const { tradePlan } = payload as { tradePlan: Record<string, unknown> };

      if (tradePlan['symbol'] !== symbol) return;

      // Ignorar señales generadas durante el período de warm-up
      if (this._lastCandle && this._lastCandle.openTime < signalFrom) return;

      const contextCandle = this._lastCandle;
      if (!contextCandle) {
        this._logger.warn(
          `BacktestRunner: señal recibida sin vela de contexto — ignorando trade`
        );
        return;
      }

      let fillResult: FillResult;
      try {
        fillResult = await this._fills.simulateFill(tradePlan, contextCandle);
      } catch (err) {
        this._logger.error(
          `BacktestRunner: error simulando fill para ${tradePlan['symbol']} — ${(err as Error).message}`
        );
        return;
      }

      await this._broker.publish('EXECUTION_TRADE_OPENED', {
        tradeId:    fillResult.tradeId,
        strategyId: tradePlan['strategyId'] as string,
        symbol:     tradePlan['symbol'] as string,
        direction:  tradePlan['direction'] as string,
        entryPrice: fillResult.entryFill.price,
        timestamp:  fillResult.entryFill.timestamp,
        tradePlan:  tradePlan as Record<string, unknown>,
      });

      await this._broker.publish('EXECUTION_TRADE_CLOSED', {
        tradeId:    fillResult.tradeId,
        strategyId: tradePlan['strategyId'] as string,
        symbol:     tradePlan['symbol'] as string,
        direction:  tradePlan['direction'] as string,
        exitPrice:  fillResult.exitFill.price,
        exitType:   fillResult.exitFill.type,
        timestamp:  fillResult.exitFill.timestamp,
        pnl:        fillResult.pnl,
        pnlPercent: fillResult.pnlPercent,
        fillResult: fillResult as unknown as Record<string, unknown>,
      });

      if (fillResult.exitFill.type && fillResult.exitFill.type.startsWith('TP')) {
        await this._broker.publish('EXECUTION_PARTIAL_FILLED', {
          tradeId:       fillResult.tradeId,
          tpLevel:       fillResult.exitFill.tpLevel ?? null,
          fillPrice:     fillResult.exitFill.price,
          remainingSize: null,
          timestamp:     fillResult.exitFill.timestamp,
        });
      }

      fillResults.push(fillResult);
    };

    const candleHandler = (payload: unknown) => {
      const { candle } = payload as { candle: Candle };
      this._lastCandle = candle;
    };

    this._broker.subscribe('STRATEGY_SIGNAL_GENERATED', handler);
    this._broker.subscribe('MARKET_CANDLE_CLOSED', candleHandler);

    return () => {
      this._lastCandle = null;
      this._broker.unsubscribe?.('STRATEGY_SIGNAL_GENERATED', handler);
      this._broker.unsubscribe?.('MARKET_CANDLE_CLOSED', candleHandler);
    };
  }

  private _validateConfig(config: RunConfig | null | undefined): asserts config is RunConfig {
    if (!config) {
      throw new Error('BacktestRunner.run: se requiere un objeto config');
    }

    const required: (keyof RunConfig)[] = ['strategyId', 'symbol', 'timeframe', 'from', 'to', 'initialCapital'];
    for (const field of required) {
      if (config[field] === undefined || config[field] === null) {
        throw new Error(`BacktestRunner.run: config.${field} es requerido`);
      }
    }

    if (typeof config.from !== 'number' || typeof config.to !== 'number') {
      throw new Error('BacktestRunner.run: config.from y config.to deben ser timestamps en ms');
    }

    if (config.from >= config.to) {
      throw new Error(
        `BacktestRunner.run: config.from (${config.from}) debe ser anterior a config.to (${config.to})`
      );
    }

    if (typeof config.initialCapital !== 'number' || config.initialCapital <= 0) {
      throw new Error('BacktestRunner.run: config.initialCapital debe ser un número positivo');
    }

    if (typeof config.strategyId !== 'string' || config.strategyId.trim() === '') {
      throw new Error('BacktestRunner.run: config.strategyId debe ser un string no vacío');
    }
  }
}

export default BacktestRunner;
