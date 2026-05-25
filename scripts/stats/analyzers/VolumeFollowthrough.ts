import { smaArray, emaArray } from '../../../src/indicators/index.js';
import type { Analyzer, AnalyzerResult, CandleWindow } from '../types.js';

export interface VolumeFollowthroughOptions {
  /** Volumen mínimo absoluto para activar el trigger */
  volThreshold?: number;
  /** Tipo de media móvil para volumen relativo */
  volMa?: 'sma' | 'ema';
  /** Período de la media móvil */
  volMaPeriod?: number;
  /** Multiplicador sobre la media (vol > MA * mult) */
  volMaMult?: number;
  /** Número de velas futuras a analizar (default: 5) */
  lookaheadN?: number;
}

interface FollowthroughSlot {
  aboveHigh: number;
  belowLow:  number;
  inRange:   number;
  deltaSum:  number;
  total:     number;
}

/**
 * VolumeFollowthrough
 *
 * Pregunta: después de una vela con volumen destacado, ¿qué hace el precio
 * en las siguientes N velas?
 *
 * Para cada vela que cumple la condición de volumen, registra el high y low
 * de esa vela, luego para cada vela +N del lookahead compara el close.
 */
export class VolumeFollowthrough implements Analyzer {
  readonly name        = 'volume-followthrough';
  readonly description = 'Analiza el comportamiento del precio tras velas de alto volumen';
  readonly lookback:   number;
  readonly lookahead:  number;

  private readonly _options: Required<VolumeFollowthroughOptions>;
  private readonly _slots:   FollowthroughSlot[];
  private _triggerCount = 0;

  constructor(options: VolumeFollowthroughOptions) {
    // Validar que se pasó algún criterio de volumen
    if (options.volThreshold === undefined && options.volMa === undefined) {
      throw new Error(
        'VolumeFollowthrough: se requiere --vol-threshold O (--vol-ma + --vol-ma-period + --vol-ma-mult)',
      );
    }
    if (options.volMa !== undefined) {
      if (options.volMaPeriod === undefined) {
        throw new Error('VolumeFollowthrough: --vol-ma-period es requerido cuando se usa --vol-ma');
      }
      if (options.volMaMult === undefined) {
        throw new Error('VolumeFollowthrough: --vol-ma-mult es requerido cuando se usa --vol-ma');
      }
    }

    const lookaheadN = options.lookaheadN ?? 5;

    this._options = {
      volThreshold: options.volThreshold ?? 0,
      volMa:        options.volMa ?? 'sma',
      volMaPeriod:  options.volMaPeriod ?? 20,
      volMaMult:    options.volMaMult ?? 2,
      lookaheadN,
    };

    // lookback necesario para calcular la MA de volumen
    this.lookback  = options.volMa !== undefined ? (options.volMaPeriod ?? 20) : 0;
    this.lookahead = lookaheadN;

    // Inicializar slots para cada posición +1 .. +N
    this._slots = Array.from({ length: lookaheadN }, () => ({
      aboveHigh: 0,
      belowLow:  0,
      inRange:   0,
      deltaSum:  0,
      total:     0,
    }));
  }

  process(window: CandleWindow): void {
    const { candle, lookback, lookahead } = window;

    // Determinar si la vela cumple el criterio de volumen
    if (!this._isTrigger(candle.volume, lookback.map(c => c.volume))) return;

    this._triggerCount++;
    const triggerHigh = candle.high;
    const triggerLow  = candle.low;
    const triggerClose = candle.close;

    for (let n = 0; n < this._options.lookaheadN; n++) {
      const futureCandle = lookahead[n];
      if (!futureCandle) continue;

      const slot = this._slots[n]!;
      slot.total++;

      const futureClose = futureCandle.close;
      if (futureClose > triggerHigh) {
        slot.aboveHigh++;
      } else if (futureClose < triggerLow) {
        slot.belowLow++;
      } else {
        slot.inRange++;
      }

      // Delta % desde el close de la vela trigger
      slot.deltaSum += (futureClose - triggerClose) / triggerClose * 100;
    }
  }

  result(): AnalyzerResult {
    const rows: Record<string, unknown>[] = this._slots.map((slot, i) => {
      const total = slot.total || 1; // evitar división por cero
      return {
        'Vela +N':              `+${i + 1}`,
        'Cierra >High trigger': `${((slot.aboveHigh / total) * 100).toFixed(1)}%`,
        'Cierra <Low trigger':  `${((slot.belowLow  / total) * 100).toFixed(1)}%`,
        'Cierra dentro rango':  `${((slot.inRange   / total) * 100).toFixed(1)}%`,
        'Delta % promedio':     `${(slot.deltaSum / total).toFixed(2)}%`,
      };
    });

    const { volMa, volMaPeriod, volMaMult, volThreshold } = this._options;
    const condDesc = this._options.volMa !== undefined
      ? `volumen >= ${volMa!.toUpperCase()}(${volMaPeriod}) x ${volMaMult}`
      : `volumen >= ${volThreshold}`;

    return {
      name: this.name,
      rows,
      summary: {
        condicion:      condDesc,
        velasTrigger:   this._triggerCount,
        velasFuturasN:  this._options.lookaheadN,
      },
    };
  }

  reset(): void {
    this._triggerCount = 0;
    for (const slot of this._slots) {
      slot.aboveHigh = 0;
      slot.belowLow  = 0;
      slot.inRange   = 0;
      slot.deltaSum  = 0;
      slot.total     = 0;
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private _isTrigger(volume: number, lookbackVolumes: number[]): boolean {
    if (this._options.volThreshold > 0) {
      return volume >= this._options.volThreshold;
    }

    // Modo MA: calcular la MA sobre el lookback + vela actual
    const series = [...lookbackVolumes, volume];
    const { volMa, volMaPeriod, volMaMult } = this._options;

    let maValues: (number | null)[];
    if (volMa === 'ema') {
      maValues = emaArray(series, volMaPeriod);
    } else {
      maValues = smaArray(series, volMaPeriod);
    }

    // La MA de referencia es la del punto ANTERIOR a la vela actual
    // (para no usar la vela actual en el cálculo de la MA)
    const maRef = maValues[maValues.length - 2];
    if (maRef === null || maRef === undefined) return false;

    return volume >= maRef * volMaMult;
  }
}
