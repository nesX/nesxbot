import type { Candle } from '../../src/types.js';

export type { Candle };

export interface CandleWindow {
  symbol:    string;
  timeframe: string;
  index:     number;      // posición en la serie completa
  candle:    Candle;      // vela en evaluación
  lookback:  Candle[];    // candle[-L .. -1], más reciente al final
  lookahead: Candle[];    // candle[+1 .. +F], más antiguo primero
}

export interface AnalyzerResult {
  name:     string;
  rows:     Record<string, unknown>[];  // filas de la tabla de resultados
  summary?: Record<string, unknown>;   // métricas agregadas opcionales
}

export interface Analyzer {
  readonly name:        string;
  readonly description: string;
  readonly lookback:    number;   // cuántas velas previas necesita
  readonly lookahead:   number;   // cuántas velas futuras necesita

  /** Llamado por el motor para cada ventana válida. */
  process(window: CandleWindow): void;

  /** Retorna el resultado acumulado. No modifica estado interno. */
  result(): AnalyzerResult;

  /** Reinicia el estado interno (para reutilizar el analyzer en otro rango). */
  reset(): void;
}
