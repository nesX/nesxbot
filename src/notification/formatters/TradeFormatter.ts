/**
 * TradeFormatter.ts
 *
 * Formatea eventos relacionados con el ciclo de vida de trades para
 * su presentacion en canales de notificacion.
 *
 * Funciones exportadas:
 *   formatTradeOpened(payload)   → String
 *   formatTradeClosed(payload)   → String
 *   formatSLMoved(payload)       → String
 *   formatSignalGenerated(payload) → String
 *   formatSignalRejected(payload)  → String
 *
 * Todas las funciones son puras — no tienen efectos secundarios ni estado.
 * Los numeros se formatean con precision fija para legibilidad.
 */

import type { TradePlan, TakeProfit } from '../../types.js';

interface TradeOpenedPayload {
  tradeId: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  size?: number;
  stopLoss?: number;
  takeProfits?: TakeProfit[];
}

interface TradeClosedPayload {
  tradeId: string;
  exitPrice: number;
  exitType: 'SL' | 'TP' | 'MANUAL' | string;
  pnl?: number;
}

interface SLMovedPayload {
  tradeId: string;
  oldSL: number;
  newSL: number;
  reason?: string;
}

interface SignalGeneratedPayload {
  tradePlan?: Pick<TradePlan, 'strategyId' | 'symbol' | 'direction' | 'entryPrice'>;
}

interface SignalRejectedPayload {
  strategyId: string;
  symbol: string;
  reason: string;
}

interface ZoneArmedPayload {
  strategyId: string;
  symbol: string;
  zoneId?: string;
  price?: number;
}

interface ZoneDisarmedPayload {
  strategyId: string;
  symbol: string;
  zoneId?: string;
  reason?: string;
}

/**
 * Formatea el evento EXECUTION_TRADE_OPENED.
 */
function formatTradeOpened(payload: TradeOpenedPayload): string {
  const { tradeId, symbol, direction, entryPrice, size, stopLoss, takeProfits } = payload;

  const dirLabel  = direction === 'LONG' ? 'LONG' : 'SHORT';
  const priceStr  = _formatPrice(entryPrice);
  const sizeStr   = size != null ? ` | Size: ${_formatNumber(size)}` : '';
  const slStr     = stopLoss != null ? `\nSL: $${_formatPrice(stopLoss)}` : '';

  let tpStr = '';
  if (Array.isArray(takeProfits) && takeProfits.length > 0) {
    const tpList = takeProfits
      .map((tp, i) => `TP${i + 1}: $${_formatPrice(tp.price)} (${tp.sizePercent}%)`)
      .join(' | ');
    tpStr = `\n${tpList}`;
  }

  return (
    `Trade abierto: ${dirLabel} ${symbol}\n` +
    `Entrada: $${priceStr}${sizeStr}` +
    slStr +
    tpStr +
    `\nID: ${tradeId}`
  );
}

/**
 * Formatea el evento EXECUTION_TRADE_CLOSED.
 */
function formatTradeClosed(payload: TradeClosedPayload): string {
  const { tradeId, exitPrice, exitType, pnl } = payload;

  const exitLabel = _exitTypeLabel(exitType);
  const priceStr  = _formatPrice(exitPrice);

  let pnlStr = '';
  if (pnl != null) {
    const pnlSign      = pnl >= 0 ? '+' : '';
    const pnlFormatted = `${pnlSign}${_formatNumber(pnl)}`;
    pnlStr = `\nPnL: ${pnlFormatted}`;
  }

  return (
    `Trade cerrado (${exitLabel}): ${tradeId}\n` +
    `Precio salida: $${priceStr}` +
    pnlStr
  );
}

/**
 * Formatea el evento EXECUTION_SL_MOVED.
 */
function formatSLMoved(payload: SLMovedPayload): string {
  const { tradeId, oldSL, newSL, reason } = payload;

  const reasonStr = reason ? ` (${reason})` : '';
  const direction = newSL > oldSL ? 'subio' : 'bajo';

  return (
    `SL movido${reasonStr}: ${tradeId}\n` +
    `$${_formatPrice(oldSL)} -> $${_formatPrice(newSL)} [${direction}]`
  );
}

/**
 * Formatea el evento STRATEGY_SIGNAL_GENERATED.
 */
function formatSignalGenerated(payload: SignalGeneratedPayload): string {
  const tp = payload.tradePlan;
  if (!tp) return 'Nueva senal generada (sin detalle)';

  const { symbol, direction, entryPrice, strategyId } = tp;
  const dirLabel = direction === 'LONG' ? 'LONG' : 'SHORT';

  return (
    `Nueva senal: ${dirLabel} ${symbol}\n` +
    `Entrada: $${_formatPrice(entryPrice)} | Estrategia: ${strategyId}`
  );
}

/**
 * Formatea el evento EXECUTION_SIGNAL_REJECTED.
 */
function formatSignalRejected(payload: SignalRejectedPayload): string {
  const { strategyId, symbol, reason } = payload;
  return (
    `Senal rechazada: ${strategyId} ${symbol}\n` +
    `Razon: ${reason}`
  );
}

/**
 * Formatea el evento STRATEGY_ZONE_ARMED.
 */
function formatZoneArmed(payload: ZoneArmedPayload): string {
  const { strategyId, symbol, zoneId, price } = payload;
  const zoneStr  = zoneId ? ` | Zona: ${zoneId}` : '';
  const priceStr = price != null ? ` | Precio: $${_formatPrice(price)}` : '';
  return `Zona armada: ${strategyId} ${symbol}${zoneStr}${priceStr}`;
}

/**
 * Formatea el evento STRATEGY_ZONE_DISARMED.
 */
function formatZoneDisarmed(payload: ZoneDisarmedPayload): string {
  const { strategyId, symbol, zoneId, reason } = payload;
  const zoneStr   = zoneId  ? ` | Zona: ${zoneId}`  : '';
  const reasonStr = reason  ? ` | Razon: ${reason}` : '';
  return `Zona desarmada: ${strategyId} ${symbol}${zoneStr}${reasonStr}`;
}

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

/**
 * Formatea un precio con 2 decimales, separando miles con coma.
 */
function _formatPrice(price: number): string {
  if (price == null || isNaN(price)) return '?';
  return price.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Formatea un numero generico con hasta 6 decimales significativos.
 */
function _formatNumber(n: number): string {
  if (n == null || isNaN(n)) return '?';
  // Usar notacion fija con hasta 6 decimales, eliminando ceros al final
  return parseFloat(n.toFixed(6)).toString();
}

/**
 * Convierte exitType a etiqueta legible.
 */
function _exitTypeLabel(exitType: string): string {
  switch (exitType) {
    case 'SL':     return 'Stop Loss';
    case 'TP':     return 'Take Profit';
    case 'MANUAL': return 'Manual';
    default:       return exitType || 'desconocido';
  }
}

export {
  formatTradeOpened,
  formatTradeClosed,
  formatSLMoved,
  formatSignalGenerated,
  formatSignalRejected,
  formatZoneArmed,
  formatZoneDisarmed,
};

export default {
  formatTradeOpened,
  formatTradeClosed,
  formatSLMoved,
  formatSignalGenerated,
  formatSignalRejected,
  formatZoneArmed,
  formatZoneDisarmed,
};
