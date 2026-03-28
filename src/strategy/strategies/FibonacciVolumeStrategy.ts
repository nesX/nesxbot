/**
 * FibonacciVolumeStrategy.ts
 *
 * Estrategia basada en velas de alto volumen y extensiones de Fibonacci.
 *
 * Lógica:
 *   1. Detectar vela con volumen > 5x SMA(20) de volumen (vela "impulso")
 *   2. Calcular extensiones Fibonacci desde high/low de esa vela:
 *        Por encima del high : 1.8, 2.1, 2.618, 3.0
 *        Por debajo del low  : -0.8, -1.1, -1.618, -2.0
 *   3. Armar zona — emite STRATEGY_ZONE_ARMED
 *   4. Si el precio actual toca uno de esos niveles → generar TradePlan y retornarlo
 *   5. Si aparece nueva vela de alto volumen → desarmar zona anterior
 *
 * Estado interno explícito (sin efectos secundarios):
 *   this._armedZone — la zona actualmente armada (o null)
 *
 * Emisión de eventos de zona:
 *   La estrategia NO puede emitir eventos directamente (no conoce el MessageBroker).
 *   Para que el StrategyEngine pueda emitir STRATEGY_ZONE_ARMED / DISARMED, evaluate()
 *   expone los cambios de zona a través de la propiedad `lastZoneChange` del TradePlan
 *   — pero eso crearía acoplamiento al protocolo interno.
 *
 *   Solución adoptada (más limpia): la estrategia expone métodos `onZoneArmed` y
 *   `onZoneDisarmed` como callbacks opcionales inyectados en el constructor.
 *   El StrategyEngine los conecta al MessageBroker en el momento de registrar la estrategia.
 *   De esta forma la estrategia sigue siendo pura (no importa el broker) y el Engine
 *   mantiene el control de la emisión de eventos.
 *
 * Si no se inyectan los callbacks, la estrategia funciona silenciosamente (útil en tests).
 */

import type { MarketState, TradePlan, Candle, FibLevel, TakeProfit } from '../../types.js';
import StrategyBase from '../StrategyBase.js';

/** Multiplicadores Fibonacci por encima del high de la vela impulso */
const FIB_ABOVE = [1.8, 2.1, 2.618, 3.0];

/** Multiplicadores Fibonacci por debajo del low de la vela impulso (negativos) */
const FIB_BELOW = [-0.8, -1.1, -1.618, -2.0];

/** Volumen mínimo relativo a la SMA para considerar vela de impulso */
const VOLUME_THRESHOLD_MULTIPLIER = 5;

/** Períodos para el SMA de volumen */
const VOLUME_SMA_PERIOD = 20;

/** Tolerancia para considerar que el precio "tocó" un nivel (0.1% del precio) */
const LEVEL_TOUCH_TOLERANCE = 0.001;

interface ArmedZone {
  symbol: string;
  triggerCandle: Candle;
  levels: FibLevel[];
}

type ZoneArmedCallback = (zonePayload: Record<string, unknown>) => void;
type ZoneDisarmedCallback = (zonePayload: Record<string, unknown>) => void;

interface FibonacciVolumeStrategyOptions {
  onZoneArmed?: ZoneArmedCallback;
  onZoneDisarmed?: ZoneDisarmedCallback;
}

class FibonacciVolumeStrategy extends StrategyBase {
  private _onZoneArmed: ZoneArmedCallback | null;
  private _onZoneDisarmed: ZoneDisarmedCallback | null;

  /** Zona actualmente armada. */
  private _armedZone: ArmedZone | null;

  constructor(options: FibonacciVolumeStrategyOptions = {}) {
    super();
    this._onZoneArmed    = typeof options.onZoneArmed    === 'function' ? options.onZoneArmed    : null;
    this._onZoneDisarmed = typeof options.onZoneDisarmed === 'function' ? options.onZoneDisarmed : null;
    this._armedZone = null;
  }

  // ---------------------------------------------------------------------------
  // StrategyBase contract
  // ---------------------------------------------------------------------------

  get id(): string {
    return 'fibonacci-volume-v1';
  }

  get requiredTimeframes(): string[] {
    return ['1m'];
  }

  /**
   * Evalúa el MarketState y decide si hay señal de trading.
   *
   * Flujo:
   *   1. Verificar si hay suficientes velas para calcular SMA(20)
   *   2. Detectar si la última vela tiene alto volumen
   *   3. Si hay zona armada y nueva vela de alto volumen → desarmar zona
   *   4. Si nueva vela de alto volumen → armar nueva zona
   *   5. Si hay zona armada → verificar si el precio toca algún nivel → TradePlan
   */
  async evaluate(state: MarketState): Promise<TradePlan | null> {
    const candles = state.candles['1m'];

    // Sin suficientes velas para calcular SMA(20) + la vela actual
    if (!candles || candles.length < VOLUME_SMA_PERIOD + 1) {
      return null;
    }

    const lastCandle   = candles[candles.length - 1];
    const isHighVolume = this._isHighVolumeCandle(candles);

    // Si hay zona armada y llega nueva vela de alto volumen → desarmar la anterior
    if (isHighVolume && this._armedZone !== null) {
      this._disarmZone(state.symbol, 'nueva vela de alto volumen invalida la zona anterior');
    }

    // Nueva vela de alto volumen → armar nueva zona
    if (isHighVolume) {
      this._armZone(state.symbol, lastCandle);
      return null; // En la vela de activación no generamos señal todavía
    }

    // Sin zona armada → nada que evaluar
    if (this._armedZone === null) {
      return null;
    }

    // Zona armada: verificar si el precio actual toca algún nivel
    const tradePlan = this._checkLevelTouch(state);
    return tradePlan;
  }

  // ---------------------------------------------------------------------------
  // Acceso de solo lectura al estado interno (útil para tests)
  // ---------------------------------------------------------------------------

  /** Retorna la zona actualmente armada, o null. */
  get armedZone(): ArmedZone | null {
    return this._armedZone;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Determina si la última vela del array tiene volumen > N × SMA(20) de volumen.
   *
   * @param candles - Array de velas ordenadas ASC (la última es la más reciente)
   */
  private _isHighVolumeCandle(candles: Candle[]): boolean {
    const lastCandle = candles[candles.length - 1];

    // Usar las 20 velas anteriores a la última para calcular SMA
    const prevCandles = candles.slice(-VOLUME_SMA_PERIOD - 1, -1);
    if (prevCandles.length < VOLUME_SMA_PERIOD) {
      return false;
    }

    const smaVolume = prevCandles.reduce((sum, c) => sum + c.volume, 0) / VOLUME_SMA_PERIOD;
    return lastCandle.volume > VOLUME_THRESHOLD_MULTIPLIER * smaVolume;
  }

  /**
   * Calcula los niveles Fibonacci para una vela de impulso.
   *
   * Fórmula: precio = low + (high - low) * multiplicador
   *   - Para multiplicadores > 1 : niveles por encima del high
   *   - Para multiplicadores < 0 : niveles por debajo del low
   */
  private _calculateFibLevels(triggerCandle: Candle): FibLevel[] {
    const { high, low } = triggerCandle;
    const range = high - low;

    const levels: FibLevel[] = [];

    for (const mult of FIB_ABOVE) {
      levels.push({
        multiplier: mult,
        price:      low + range * mult,
        direction:  'LONG',
      });
    }

    for (const mult of FIB_BELOW) {
      levels.push({
        multiplier: mult,
        price:      low + range * mult,
        direction:  'SHORT',
      });
    }

    return levels;
  }

  /**
   * Arma la zona con los niveles calculados para la vela de impulso.
   */
  private _armZone(symbol: string, triggerCandle: Candle): void {
    const levels = this._calculateFibLevels(triggerCandle);

    this._armedZone = { symbol, triggerCandle, levels };

    if (this._onZoneArmed) {
      this._onZoneArmed({
        strategyId:    this.id,
        symbol,
        levels,
        triggerCandle,
      });
    }
  }

  /**
   * Desarma la zona activa.
   */
  private _disarmZone(symbol: string, reason: string): void {
    this._armedZone = null;

    if (this._onZoneDisarmed) {
      this._onZoneDisarmed({
        strategyId: this.id,
        symbol,
        reason,
      });
    }
  }

  /**
   * Verifica si el precio actual toca alguno de los niveles armados.
   * Si toca, construye y retorna un TradePlan. Sino, retorna null.
   */
  private _checkLevelTouch(state: MarketState): TradePlan | null {
    const { currentPrice, symbol } = state;
    const { triggerCandle, levels } = this._armedZone!;

    for (const level of levels) {
      if (this._priceTouch(currentPrice, level.price)) {
        const tradePlan = this._buildTradePlan(symbol, level, triggerCandle, state);
        if (tradePlan !== null) {
          // Desarmar la zona solo cuando se genera efectivamente la señal
          this._disarmZone(symbol, 'nivel tocado — señal generada');
        }
        return tradePlan;
      }
    }

    return null;
  }

  /**
   * Determina si el precio actual está dentro de la tolerancia de un nivel.
   */
  private _priceTouch(currentPrice: number, levelPrice: number): boolean {
    const tolerance = levelPrice * LEVEL_TOUCH_TOLERANCE;
    return Math.abs(currentPrice - levelPrice) <= tolerance;
  }

  /**
   * Construye el TradePlan cuando se toca un nivel Fibonacci.
   *
   * Stop loss:
   *   LONG  → low de la vela disparadora
   *   SHORT → high de la vela disparadora
   *
   * Take profits: los 3 niveles Fibonacci siguientes en la misma dirección
   * (distribuidos 30% / 40% / 30%). Si no hay suficientes niveles, el 100% va al primero.
   */
  private _buildTradePlan(
    symbol: string,
    level: FibLevel,
    triggerCandle: Candle,
    state: MarketState
  ): TradePlan | null {
    const direction  = level.direction;
    const entryPrice = level.price;

    // Stop Loss
    const stopLoss = direction === 'LONG' ? triggerCandle.low : triggerCandle.high;

    // Take Profits: niveles siguientes en la misma dirección
    const sameDirectionLevels = this._armedZone!.levels
      .filter(l => l.direction === direction && l.price !== level.price)
      .sort((a, b) =>
        direction === 'LONG'
          ? b.price - a.price   // LONG: niveles más altos primero
          : a.price - b.price   // SHORT: niveles más bajos primero
      );

    const takeProfits = this._buildTakeProfits(sameDirectionLevels);

    if (takeProfits === null) {
      return null;
    }

    return {
      strategyId: this.id,
      symbol,
      direction,
      entryPrice,
      stopLoss,
      takeProfits,
      riskPercent: 1, // porcentaje de riesgo por defecto; ExposureManager lo ajustará
      metadata: {
        triggerCandle,
        fibLevels: {
          touched:   level,
          allLevels: this._armedZone!.levels,
        },
      },
    };
  }

  /**
   * Construye el array de take profits con distribución de tamaño.
   *
   * Si hay 3+ niveles disponibles: 30% / 40% / 30%
   * Si hay 2 niveles disponibles:  50% / 50%
   * Si hay 1 nivel disponible:    100%
   * Si hay 0 niveles:              retorna null (abortar TradePlan)
   *
   * @param levels - Niveles candidatos para TP ordenados por prioridad
   */
  private _buildTakeProfits(levels: FibLevel[]): TakeProfit[] | null {
    if (levels.length === 0) {
      return null; // el llamador debe abortar el TradePlan
    }

    if (levels.length === 1) {
      return [{ price: levels[0].price, sizePercent: 100 }];
    }

    if (levels.length === 2) {
      return [
        { price: levels[0].price, sizePercent: 50 },
        { price: levels[1].price, sizePercent: 50 },
      ];
    }

    // 3 o más: usar primeros 3 con distribución 30/40/30
    return [
      { price: levels[0].price, sizePercent: 30 },
      { price: levels[1].price, sizePercent: 40 },
      { price: levels[2].price, sizePercent: 30 },
    ];
  }
}

export default FibonacciVolumeStrategy;
