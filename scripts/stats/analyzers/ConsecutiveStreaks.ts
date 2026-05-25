import type { Analyzer, AnalyzerResult, CandleWindow } from '../types.js';

export interface ConsecutiveStreaksOptions {
  /** Longitud máxima a reportar individualmente (el resto se agrupa como "N+"). Default: 10 */
  maxStreak?: number;
  /** Qué tipo de racha analizar. Default: 'both' */
  direction?: 'both' | 'bullish' | 'bearish';
}

/**
 * ConsecutiveStreaks
 *
 * Pregunta: ¿con qué frecuencia ocurren rachas de N velas alcistas/bajistas
 * consecutivas?
 *
 * Criterio de vela alcista: close > open. Bajista: close < open.
 * lookback = 0, lookahead = 0 — no necesita contexto externo.
 *
 * Algoritmo: mantiene el contador de racha actual. Cuando cambia de
 * dirección o hay una vela doji (close == open), registra la racha anterior.
 */
export class ConsecutiveStreaks implements Analyzer {
  readonly name        = 'consecutive-streaks';
  readonly description = 'Analiza la frecuencia de rachas de velas alcistas y bajistas consecutivas';
  readonly lookback    = 0;
  readonly lookahead   = 0;

  private readonly _maxStreak: number;
  private readonly _direction: 'both' | 'bullish' | 'bearish';

  // Contadores de rachas: longitud → número de ocurrencias
  private _bullishCounts = new Map<number, number>();
  private _bearishCounts = new Map<number, number>();

  // Estado de la racha actual
  private _currentStreakLen  = 0;
  private _currentStreakType: 'bullish' | 'bearish' | null = null;

  // Para el resumen: longitud máxima y timestamp
  private _maxBullishLen     = 0;
  private _maxBullishTime    = 0;
  private _maxBearishLen     = 0;
  private _maxBearishTime    = 0;
  private _totalCandles      = 0;

  // Suma de longitudes para promedios
  private _bullishLenSum     = 0;
  private _bullishStreakCount = 0;
  private _bearishLenSum     = 0;
  private _bearishStreakCount = 0;

  constructor(options: ConsecutiveStreaksOptions = {}) {
    this._maxStreak = options.maxStreak ?? 10;
    this._direction = options.direction ?? 'both';
  }

  process(window: CandleWindow): void {
    const { candle } = window;
    this._totalCandles++;

    let candleType: 'bullish' | 'bearish' | 'doji';
    if (candle.close > candle.open) {
      candleType = 'bullish';
    } else if (candle.close < candle.open) {
      candleType = 'bearish';
    } else {
      candleType = 'doji';
    }

    if (candleType === 'doji') {
      // La racha se rompe en un doji
      this._registerCurrentStreak(candle.openTime);
      this._currentStreakLen  = 0;
      this._currentStreakType = null;
      return;
    }

    if (this._currentStreakType === null || this._currentStreakType !== candleType) {
      // Registrar la racha anterior si había una
      if (this._currentStreakLen > 0) {
        this._registerCurrentStreak(candle.openTime);
      }
      // Iniciar nueva racha
      this._currentStreakType = candleType;
      this._currentStreakLen  = 1;
    } else {
      // Continúa la racha
      this._currentStreakLen++;
    }

    // Actualizar máximos en tiempo real para capturar la racha en curso
    if (candleType === 'bullish' && this._currentStreakLen > this._maxBullishLen) {
      this._maxBullishLen  = this._currentStreakLen;
      this._maxBullishTime = candle.openTime; // inicio de esta vela
    }
    if (candleType === 'bearish' && this._currentStreakLen > this._maxBearishLen) {
      this._maxBearishLen  = this._currentStreakLen;
      this._maxBearishTime = candle.openTime;
    }
  }

  result(): AnalyzerResult {
    // Registrar la racha en curso al cerrar (sin modificar estado persistente)
    const tempBullish = new Map(this._bullishCounts);
    const tempBearish = new Map(this._bearishCounts);
    let tempBullishLenSum      = this._bullishLenSum;
    let tempBullishStreakCount = this._bullishStreakCount;
    let tempBearishLenSum      = this._bearishLenSum;
    let tempBearishStreakCount = this._bearishStreakCount;

    if (this._currentStreakLen > 0 && this._currentStreakType !== null) {
      const len  = this._currentStreakLen;
      const type = this._currentStreakType;
      const bucket = Math.min(len, this._maxStreak + 1); // +1 = "N+"
      if (type === 'bullish') {
        tempBullish.set(bucket, (tempBullish.get(bucket) ?? 0) + 1);
        tempBullishLenSum += len;
        tempBullishStreakCount++;
      } else {
        tempBearish.set(bucket, (tempBearish.get(bucket) ?? 0) + 1);
        tempBearishLenSum += len;
        tempBearishStreakCount++;
      }
    }

    const total  = this._totalCandles || 1;
    const rows: Record<string, unknown>[] = [];

    for (let len = 1; len <= this._maxStreak; len++) {
      const bullishN = tempBullish.get(len) ?? 0;
      const bearishN = tempBearish.get(len) ?? 0;
      const row: Record<string, unknown> = {
        'Longitud': len,
      };
      if (this._direction === 'both' || this._direction === 'bullish') {
        row['Alcistas (n)']  = bullishN;
        row['% del total (B)'] = `${((bullishN / total) * 100).toFixed(2)}%`;
      }
      if (this._direction === 'both' || this._direction === 'bearish') {
        row['Bajistas (n)']  = bearishN;
        row['% del total (Ba)'] = `${((bearishN / total) * 100).toFixed(2)}%`;
      }
      rows.push(row);
    }

    // Fila "N+"
    const overflowBucket = this._maxStreak + 1;
    const bullishOver = tempBullish.get(overflowBucket) ?? 0;
    const bearishOver = tempBearish.get(overflowBucket) ?? 0;
    const overRow: Record<string, unknown> = {
      'Longitud': `${this._maxStreak}+`,
    };
    if (this._direction === 'both' || this._direction === 'bullish') {
      overRow['Alcistas (n)']   = bullishOver;
      overRow['% del total (B)'] = `${((bullishOver / total) * 100).toFixed(2)}%`;
    }
    if (this._direction === 'both' || this._direction === 'bearish') {
      overRow['Bajistas (n)']    = bearishOver;
      overRow['% del total (Ba)'] = `${((bearishOver / total) * 100).toFixed(2)}%`;
    }
    rows.push(overRow);

    // Resumen
    const avgBullish = tempBullishStreakCount > 0
      ? (tempBullishLenSum / tempBullishStreakCount).toFixed(1)
      : '0';
    const avgBearish = tempBearishStreakCount > 0
      ? (tempBearishLenSum / tempBearishStreakCount).toFixed(1)
      : '0';

    const summary: Record<string, unknown> = {
      totalVelas: this._totalCandles,
    };
    if (this._direction === 'both' || this._direction === 'bullish') {
      summary['rachaBullishtPromedio']    = `${avgBullish} velas`;
      summary['maxRachaBullish']          = this._maxBullishLen;
      summary['maxRachaBullishTimestamp'] = this._maxBullishTime;
    }
    if (this._direction === 'both' || this._direction === 'bearish') {
      summary['rachaBearishPromedio']    = `${avgBearish} velas`;
      summary['maxRachaBearish']         = this._maxBearishLen;
      summary['maxRachaBearishTimestamp'] = this._maxBearishTime;
    }

    return { name: this.name, rows, summary };
  }

  reset(): void {
    this._bullishCounts.clear();
    this._bearishCounts.clear();
    this._currentStreakLen  = 0;
    this._currentStreakType = null;
    this._maxBullishLen     = 0;
    this._maxBullishTime    = 0;
    this._maxBearishLen     = 0;
    this._maxBearishTime    = 0;
    this._totalCandles      = 0;
    this._bullishLenSum     = 0;
    this._bullishStreakCount = 0;
    this._bearishLenSum     = 0;
    this._bearishStreakCount = 0;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private _registerCurrentStreak(currentOpenTime: number): void {
    if (this._currentStreakLen === 0 || this._currentStreakType === null) return;

    const len    = this._currentStreakLen;
    const type   = this._currentStreakType;
    const bucket = Math.min(len, this._maxStreak + 1);

    if (type === 'bullish') {
      this._bullishCounts.set(bucket, (this._bullishCounts.get(bucket) ?? 0) + 1);
      this._bullishLenSum += len;
      this._bullishStreakCount++;
      if (len > this._maxBullishLen) {
        this._maxBullishLen  = len;
        this._maxBullishTime = currentOpenTime;
      }
    } else {
      this._bearishCounts.set(bucket, (this._bearishCounts.get(bucket) ?? 0) + 1);
      this._bearishLenSum += len;
      this._bearishStreakCount++;
      if (len > this._maxBearishLen) {
        this._maxBearishLen  = len;
        this._maxBearishTime = currentOpenTime;
      }
    }
  }
}
