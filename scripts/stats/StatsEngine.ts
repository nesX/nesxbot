import type { Candle } from '../../src/types.js';
import CandleRepository from '../../src/data/CandleRepository.js';
import { aggregateCandles } from '../../src/strategy/CandleAggregator.js';
import type { Analyzer, AnalyzerResult, CandleWindow } from './types.js';

export interface StatsEngineConfig {
  symbol:    string;
  timeframe: string;   // '1m', '5m', '15m', '1h', etc.
  from:      number;   // timestamp ms (inicio del rango a analizar)
  to:        number;   // timestamp ms (fin del rango a analizar)
}

/**
 * Convierte un string de timeframe a milisegundos.
 * Soporta: '1m', '5m', '15m', '30m', '1h', '4h', etc.
 */
function timeframeToMs(tf: string): number {
  const m = tf.match(/^(\d+)(m|h)$/);
  if (!m) throw new Error(`StatsEngine: timeframe no reconocido: '${tf}'`);
  const value = parseInt(m[1]!, 10);
  const unit  = m[2]!;
  if (unit === 'm') return value * 60 * 1000;
  if (unit === 'h') return value * 60 * 60 * 1000;
  throw new Error(`StatsEngine: unidad de timeframe no reconocida: '${unit}'`);
}

/**
 * Devuelve el timeframe nativo para cargar desde la BD.
 * Si el timeframe es '1h' → '1h'. Si no, cargar '1m' y agregar.
 */
function nativeTimeframe(tf: string): '1m' | '1h' {
  if (tf === '1h') return '1h';
  return '1m';
}

/**
 * Motor genérico de estadísticas de mercado.
 *
 * Carga velas una sola vez, las entrega a todos los analyzers en un único
 * pass O(N), y retorna los resultados de cada analyzer.
 */
export class StatsEngine {
  constructor(private readonly candleRepo: CandleRepository) {}

  async run(
    config: StatsEngineConfig,
    analyzers: Analyzer[],
  ): Promise<AnalyzerResult[]> {
    if (analyzers.length === 0) return [];

    const tfMs         = timeframeToMs(config.timeframe);
    const maxLookback  = Math.max(...analyzers.map(a => a.lookback));
    const maxLookahead = Math.max(...analyzers.map(a => a.lookahead));

    // Rango extendido para tener contexto de warmup y lookahead
    const loadFrom = config.from - maxLookback  * tfMs;
    const loadTo   = config.to   + maxLookahead * tfMs;

    // Una sola query a la BD
    const native  = nativeTimeframe(config.timeframe);
    const rawCandles = await this.candleRepo.getCandles(
      config.symbol,
      native,
      loadFrom,
      loadTo,
    );

    // Agregar si el timeframe no es nativo
    let candles: Candle[];
    if (config.timeframe === native) {
      candles = rawCandles;
    } else {
      const tfMinutes = timeframeToMs(config.timeframe) / (60 * 1000);
      candles = aggregateCandles(rawCandles, tfMinutes);
    }

    if (candles.length === 0) return analyzers.map(a => a.result());

    // Determinar índices de inicio y fin del rango real (sin warmup)
    // Una vela pertenece al rango si su openTime está dentro de [from, to]
    const startIdx = this._findStartIndex(candles, config.from);
    const endIdx   = this._findEndIndex(candles, config.to);

    // Pass único sobre las velas del rango
    for (let i = startIdx; i <= endIdx; i++) {
      // Verificar que hay suficiente lookback y lookahead en el array
      if (i < maxLookback)                    continue;
      if (i + maxLookahead >= candles.length) continue;

      const candle    = candles[i]!;
      const lookback  = candles.slice(i - maxLookback, i);
      const lookahead = candles.slice(i + 1, i + 1 + maxLookahead);

      const window: CandleWindow = {
        symbol:    config.symbol,
        timeframe: config.timeframe,
        index:     i,
        candle,
        lookback,
        lookahead,
      };

      for (const analyzer of analyzers) {
        // Cada analyzer recibe solo el lookback/lookahead que necesita
        // (subarray del window global — sin copias innecesarias)
        const analyzerWindow: CandleWindow = {
          ...window,
          lookback:  lookback.slice(maxLookback - analyzer.lookback),
          lookahead: lookahead.slice(0, analyzer.lookahead),
        };
        analyzer.process(analyzerWindow);
      }
    }

    return analyzers.map(a => a.result());
  }

  /**
   * Encuentra el primer índice cuya openTime >= from.
   */
  private _findStartIndex(candles: Candle[], from: number): number {
    for (let i = 0; i < candles.length; i++) {
      if (candles[i]!.openTime >= from) return i;
    }
    return candles.length; // sin velas en el rango
  }

  /**
   * Encuentra el último índice cuya openTime <= to.
   */
  private _findEndIndex(candles: Candle[], to: number): number {
    for (let i = candles.length - 1; i >= 0; i--) {
      if (candles[i]!.openTime <= to) return i;
    }
    return -1; // sin velas en el rango
  }
}
