/**
 * Central domain type definitions for NesxTrader.
 */

export interface Candle {
  symbol: string;
  timeframe: string;
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isClosed: boolean;
}

export interface TakeProfit {
  price: number;
  sizePercent: number;
}

export interface TradePlan {
  strategyId: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  stopLoss: number;
  takeProfits: TakeProfit[];
  riskPercent: number;
  /** Si true, el FillSimulator mueve el SL a breakeven al tocar el primer TP parcial */
  moveSlToBreakeven?: boolean;
  metadata?: Record<string, unknown>;
}

export interface EntryFill {
  price: number;
  timestamp: number;
  slippage: number;
}

export interface ExitFill {
  price: number;
  timestamp: number;
  type: 'TP' | 'SL' | 'MANUAL' | string;
  tpLevel?: number | null;
}

export interface FillResult {
  tradeId: string;
  entryFill: EntryFill;
  /** Fills intermedios (TP1, TP2, ...) antes del cierre final */
  partialFills: ExitFill[];
  /** Último cierre (TP final, SL, o MANUAL) */
  exitFill: ExitFill;
  pnl: number;
  pnlPercent: number;
  resolution_mode: 'PRECISE_1S' | 'PRECISE_1M' | 'PESSIMISTIC';
  had_ambiguity: boolean;
}

export interface Position {
  tradeId: string;
  strategyId: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  entryTime: number;
  stopLoss: number;
  takeProfits: TakeProfit[];
  size: number;
  status: 'OPEN' | 'PARTIAL' | 'CLOSED';
  exitPrice?: number | null;
  exitTime?: number | null;
  exitType?: 'TP' | 'SL' | 'MANUAL' | null;
  pnl?: number | null;
}

export interface MarketState {
  symbol: string;
  timestamp: number;
  candles: Record<string, Candle[]>;
  currentPrice: number;
}

export interface OrderResult {
  orderId: string;
  status: 'FILLED' | 'PENDING' | 'CANCELLED';
  fillPrice?: number;
}

export interface Balance {
  available: number;
  total: number;
}

export interface TradeSize {
  units: number;
  notional: number;
  riskAmount: number;
}

export interface ExposureCheck {
  allowed: boolean;
  reason?: string;
}

export interface BacktestConfig {
  strategyId: string;
  symbol: string;
  timeframe: string;
  from: number;
  to: number;
  initialCapital: number;
  riskPercent?: number;
  /**
   * Cantidad de velas a cargar antes de `from` para llenar el buffer de la estrategia.
   * Las señales generadas durante el warm-up se ignoran — no cuentan como trades.
   * Ejemplo: estrategia que agrega a 131m necesita warmupCandles >= 131.
   */
  warmupCandles?: number;
}

export interface GranularDataInfo {
  has1s: boolean;
  has1m: boolean;
}

export interface TimeProvider {
  now(): number;
  setTime?(ms: number): void;
}

export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface MessageBroker {
  subscribe(channel: string, handler: (payload: unknown) => void | Promise<void>): void;
  publish(channel: string, payload: unknown): Promise<void>;
  unsubscribe?(channel: string, handler: (payload: unknown) => void | Promise<void>): void;
}

export interface TPBreakdownLevel {
  hits: number;
  winRate: number;
}

export interface ResolutionConfidence {
  PRECISE_1S: number;
  PRECISE_1M: number;
  PESSIMISTIC: number;
}

export interface Metrics {
  finalCapital: number;
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  maxDrawdown: number;
  sharpeRatio: number;
  sortinoRatio: number;
  expectancy: number;
  tpBreakdown: {
    tp1: TPBreakdownLevel;
    tp2: TPBreakdownLevel;
    tp3: TPBreakdownLevel;
  };
  resolution_confidence: ResolutionConfidence;
  pessimistic_penalties: number;
}

export interface BacktestReport {
  id?: string;
  config: BacktestConfig;
  metrics: Metrics;
  trades: FillResult[];
  createdAt?: Date;
}

export interface Order {
  orderId: string;
  symbol: string;
  side: string;
  type: string;
  quantity: number;
  price?: number | null;
  stopPrice?: number | null;
  status: string;
  createdAt: number;
  filledAt: number | null;
  fillPrice: number | null;
  clientOrderId?: string;
}

export interface TradeGroup {
  tradeId: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  units: number;
  status: 'WAITING_ENTRY' | 'OPEN' | 'CLOSED';
  entryOrderId: string | null;
  slOrderId: string | null;
  tpOrderIds: string[];
  tpDefinitions: TakeProfit[];
  filledTPs: unknown[];
  currentSL: number;
  entryPrice: number | null;
  originalSL: number;
  remainingUnits: number;
  openedAt: number | null;
}

export interface FibLevel {
  multiplier: number;
  price: number;
  direction: 'LONG' | 'SHORT';
}

export interface NotificationMessage {
  text: string;
  level: 'info' | 'warn' | 'error';
}
