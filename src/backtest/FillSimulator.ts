import { randomUUID } from 'crypto';
import type { TradePlan, Candle, FillResult, TakeProfit, TimeProvider, Logger, GranularDataInfo } from '../types.js';

// Slippage por defecto en modo PESSIMISTIC cuando no hay datos granulares.
// Expresado como fracción del precio de entrada (0.0005 = 0.05%).
const DEFAULT_SLIPPAGE_FRACTION = 0.0005;

type ResolutionMode = 'PRECISE_1S' | 'PRECISE_1M' | 'PESSIMISTIC';

interface CandleRepository {
  hasGranularData(symbol: string, from: number, to: number): Promise<GranularDataInfo>;
  getCandles(symbol: string, timeframe: string, from: number, to: number): Promise<Candle[]>;
}

interface ExitResult {
  exitPrice: number;
  exitTimestamp: number;
  exitType: string;
  tpLevel: number | null;
  hadAmbiguity: boolean;
}

interface LevelResult {
  type: string;
  price: number;
  tpLevel: number | null;
  hadAmbiguity: boolean;
}

class FillSimulator {
  private _repo: CandleRepository;
  private _timeProvider: TimeProvider;
  private _logger: Logger;

  constructor({ candleRepository, timeProvider, logger }: {
    candleRepository: CandleRepository;
    timeProvider: TimeProvider;
    logger?: Logger;
  }) {
    if (!candleRepository || typeof (candleRepository as CandleRepository).hasGranularData !== 'function') {
      throw new Error('FillSimulator: se requiere candleRepository con método hasGranularData()');
    }
    if (!timeProvider || typeof (timeProvider as TimeProvider).now !== 'function') {
      throw new Error('FillSimulator: se requiere timeProvider con método now()');
    }

    this._repo         = candleRepository;
    this._timeProvider = timeProvider;
    this._logger       = logger || {
      info:  (...a: unknown[]) => console.log('[FillSimulator]', ...a),
      warn:  (...a: unknown[]) => console.warn('[FillSimulator]', ...a),
      error: (...a: unknown[]) => console.error('[FillSimulator]', ...a),
    };
  }

  /**
   * Simula el fill completo de un trade (entrada + salida) sobre datos históricos.
   */
  async simulateFill(tradePlan: TradePlan, contextCandle: Candle): Promise<FillResult> {
    this._validateTradePlan(tradePlan);
    this._validateContextCandle(contextCandle);

    const tradeId = randomUUID();

    const from = contextCandle.openTime;
    const to   = contextCandle.openTime + 24 * 60 * 60 * 1000; // +24h

    const granularity = await this._repo.hasGranularData(tradePlan.symbol, from, to);

    let fillResult: FillResult;

    if (granularity.has1s) {
      fillResult = await this._simulatePrecise(
        tradeId, tradePlan, contextCandle, from, to, '1s', 'PRECISE_1S'
      );
    } else if (granularity.has1m) {
      fillResult = await this._simulatePrecise(
        tradeId, tradePlan, contextCandle, from, to, '1m', 'PRECISE_1M'
      );
    } else {
      fillResult = this._simulatePessimistic(tradeId, tradePlan, contextCandle);
    }

    this._logger.info(
      `FillSimulator [${fillResult.resolution_mode}] trade=${tradeId} ` +
      `${tradePlan.symbol} ${tradePlan.direction} ` +
      `pnl=${fillResult.pnl.toFixed(2)} ` +
      `exit=${fillResult.exitFill.type}` +
      (fillResult.had_ambiguity ? ' [AMBIGUOUS]' : '')
    );

    return fillResult;
  }

  // ---------------------------------------------------------------------------
  // Modos de resolución
  // ---------------------------------------------------------------------------

  private async _simulatePrecise(
    tradeId: string,
    tradePlan: TradePlan,
    contextCandle: Candle,
    from: number,
    to: number,
    timeframe: string,
    mode: ResolutionMode
  ): Promise<FillResult> {
    const candles = await this._repo.getCandles(tradePlan.symbol, timeframe, from, to);

    if (candles.length === 0) {
      this._logger.warn(
        `FillSimulator: ${mode} solicitado pero getCandles devolvió 0 velas. ` +
        `Fallback a PESSIMISTIC.`
      );
      return this._simulatePessimistic(tradeId, tradePlan, contextCandle);
    }

    const slippage = this._estimateSlippage(tradePlan.entryPrice, candles[0]);

    const entryPrice = tradePlan.direction === 'LONG'
      ? tradePlan.entryPrice + slippage
      : tradePlan.entryPrice - slippage;

    const entryTimestamp = candles[0].openTime;

    const exitResult = this._findExitInCandles(tradePlan, entryPrice, candles);

    const pnl = this._calculatePnl(tradePlan, entryPrice, exitResult.exitPrice);

    return {
      tradeId,
      entryFill: {
        price:     entryPrice,
        timestamp: entryTimestamp,
        slippage,
      },
      exitFill: {
        price:     exitResult.exitPrice,
        timestamp: exitResult.exitTimestamp,
        type:      exitResult.exitType,
        tpLevel:   exitResult.tpLevel,
      },
      pnl,
      pnlPercent:      this._pnlPercent(tradePlan, entryPrice, exitResult.exitPrice),
      resolution_mode: mode,
      had_ambiguity:   exitResult.hadAmbiguity,
    };
  }

  private _simulatePessimistic(tradeId: string, tradePlan: TradePlan, contextCandle: Candle): FillResult {
    const slippage   = tradePlan.entryPrice * DEFAULT_SLIPPAGE_FRACTION;
    const entryPrice = tradePlan.direction === 'LONG'
      ? tradePlan.entryPrice + slippage
      : tradePlan.entryPrice - slippage;

    const entryTimestamp = contextCandle.openTime;

    const candleResult = this._evaluateCandleAgainstLevels(
      tradePlan, entryPrice, contextCandle, /* pessimistic= */ true
    );

    let exitPrice: number;
    let exitTimestamp: number;
    let exitType: string;
    let tpLevel: number | null;
    let hadAmbiguity = false;

    if (candleResult) {
      exitPrice     = candleResult.price;
      exitTimestamp = contextCandle.openTime;
      exitType      = candleResult.type;
      tpLevel       = candleResult.tpLevel;
      hadAmbiguity  = candleResult.hadAmbiguity || false;
    } else {
      exitPrice     = tradePlan.stopLoss;
      exitTimestamp = contextCandle.openTime;
      exitType      = 'SL';
      tpLevel       = null;
    }

    const pnl = this._calculatePnl(tradePlan, entryPrice, exitPrice);

    return {
      tradeId,
      entryFill: {
        price:     entryPrice,
        timestamp: entryTimestamp,
        slippage,
      },
      exitFill: {
        price:     exitPrice,
        timestamp: exitTimestamp,
        type:      exitType,
        tpLevel,
      },
      pnl,
      pnlPercent:      this._pnlPercent(tradePlan, entryPrice, exitPrice),
      resolution_mode: 'PESSIMISTIC',
      had_ambiguity:   hadAmbiguity,
    };
  }

  // ---------------------------------------------------------------------------
  // Lógica de resolución de niveles
  // ---------------------------------------------------------------------------

  private _findExitInCandles(tradePlan: TradePlan, entryPrice: number, candles: Candle[]): ExitResult {
    for (const candle of candles) {
      const result = this._evaluateCandleAgainstLevels(
        tradePlan, entryPrice, candle, /* pessimistic= */ false
      );

      if (result) {
        return {
          exitPrice:     result.price,
          exitTimestamp: candle.openTime,
          exitType:      result.type,
          tpLevel:       result.tpLevel,
          hadAmbiguity:  result.hadAmbiguity || false,
        };
      }
    }

    const lastCandle = candles[candles.length - 1];
    return {
      exitPrice:     lastCandle.close,
      exitTimestamp: lastCandle.openTime,
      exitType:      'MANUAL',
      tpLevel:       null,
      hadAmbiguity:  false,
    };
  }

  private _evaluateCandleAgainstLevels(
    tradePlan: TradePlan,
    entryPrice: number,
    candle: Candle,
    pessimistic: boolean
  ): LevelResult | null {
    const { high, low } = candle;
    const sl = tradePlan.stopLoss;
    const sortedTps = this._sortedTakeProfits(tradePlan);
    const firstTp = sortedTps[0];

    if (!firstTp) return null;

    const direction = tradePlan.direction;

    const slHit = direction === 'LONG'
      ? low  <= sl
      : high >= sl;

    const tpHit = direction === 'LONG'
      ? high >= firstTp.price
      : low  <= firstTp.price;

    if (!slHit && !tpHit) return null;

    if (slHit && tpHit) {
      if (pessimistic) {
        return {
          type:         'SL',
          price:        sl,
          tpLevel:      null,
          hadAmbiguity: true,
        };
      }

      const distToSl = Math.abs(candle.open - sl);
      const distToTp = Math.abs(candle.open - firstTp.price);

      if (distToSl <= distToTp) {
        return {
          type:         'SL',
          price:        sl,
          tpLevel:      null,
          hadAmbiguity: true,
        };
      }

      return {
        type:         this._tpTypeName(firstTp, sortedTps),
        price:        firstTp.price,
        tpLevel:      this._tpIndex(firstTp, sortedTps),
        hadAmbiguity: true,
      };
    }

    if (slHit) {
      return {
        type:         'SL',
        price:        sl,
        tpLevel:      null,
        hadAmbiguity: false,
      };
    }

    // tpHit
    return {
      type:         this._tpTypeName(firstTp, sortedTps),
      price:        firstTp.price,
      tpLevel:      this._tpIndex(firstTp, sortedTps),
      hadAmbiguity: false,
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private _sortedTakeProfits(tradePlan: TradePlan): TakeProfit[] {
    const tps = Array.isArray(tradePlan.takeProfits) ? [...tradePlan.takeProfits] : [];
    if (tradePlan.direction === 'LONG') {
      return tps.sort((a, b) => a.price - b.price);
    }
    return tps.sort((a, b) => b.price - a.price);
  }

  private _tpIndex(tp: TakeProfit, sortedTps: TakeProfit[]): number | null {
    const idx = sortedTps.indexOf(tp);
    return idx >= 0 ? idx + 1 : null;
  }

  private _tpTypeName(tp: TakeProfit, sortedTps: TakeProfit[]): string {
    const idx = this._tpIndex(tp, sortedTps);
    if (idx === null) return 'TP';
    if (idx <= 3) return `TP${idx}`;
    return 'TP';
  }

  private _estimateSlippage(entryPrice: number, firstCandle: Candle | null): number {
    if (!firstCandle) return entryPrice * DEFAULT_SLIPPAGE_FRACTION;
    const spread    = firstCandle.high - firstCandle.low;
    const estimated = spread * 0.10;
    const minimum   = entryPrice * 0.0001;
    return Math.max(estimated, minimum);
  }

  private _calculatePnl(tradePlan: TradePlan, entryPrice: number, exitPrice: number): number {
    const riskPercent = tradePlan.riskPercent || 1;
    const direction   = tradePlan.direction;

    const slDistance = Math.abs(entryPrice - tradePlan.stopLoss);
    if (slDistance === 0) return 0;

    const priceDelta = direction === 'LONG'
      ? exitPrice - entryPrice
      : entryPrice - exitPrice;

    const rMultiple = priceDelta / slDistance;
    return rMultiple * riskPercent;
  }

  private _pnlPercent(tradePlan: TradePlan, entryPrice: number, exitPrice: number): number {
    const delta = tradePlan.direction === 'LONG'
      ? exitPrice - entryPrice
      : entryPrice - exitPrice;
    return (delta / entryPrice) * 100;
  }

  // ---------------------------------------------------------------------------
  // Validaciones
  // ---------------------------------------------------------------------------

  private _validateTradePlan(tradePlan: unknown): asserts tradePlan is TradePlan {
    if (!tradePlan) {
      throw new Error('FillSimulator: tradePlan es requerido');
    }
    const plan = tradePlan as Record<string, unknown>;
    const required = ['strategyId', 'symbol', 'direction', 'entryPrice', 'stopLoss', 'takeProfits'];
    for (const field of required) {
      if (plan[field] === undefined || plan[field] === null) {
        throw new Error(`FillSimulator: tradePlan.${field} es requerido`);
      }
    }
    if (!['LONG', 'SHORT'].includes(plan['direction'] as string)) {
      throw new Error(`FillSimulator: tradePlan.direction debe ser 'LONG' o 'SHORT'`);
    }
    if (!Array.isArray(plan['takeProfits']) || (plan['takeProfits'] as unknown[]).length === 0) {
      throw new Error('FillSimulator: tradePlan.takeProfits debe ser un array no vacío');
    }
  }

  private _validateContextCandle(candle: unknown): asserts candle is Candle {
    if (!candle) {
      throw new Error('FillSimulator: contextCandle es requerido');
    }
    const c = candle as Record<string, unknown>;
    const required = ['open', 'high', 'low', 'close', 'openTime'];
    for (const field of required) {
      if (c[field] === undefined || c[field] === null) {
        throw new Error(
          `FillSimulator: contextCandle.${field} es requerido (OHLC completo obligatorio)`
        );
      }
    }
  }
}

export default FillSimulator;
