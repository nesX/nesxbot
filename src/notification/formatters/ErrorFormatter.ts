/**
 * ErrorFormatter.ts
 *
 * Formatea eventos de error del sistema para su presentacion en canales
 * de notificacion.
 *
 * Funciones exportadas:
 *   formatCriticalError(payload)      → String
 *   formatSyncDiscrepancy(payload)    → String
 *
 * Todas las funciones son puras — sin efectos secundarios ni estado.
 */

interface CriticalErrorPayload {
  source: string;
  error: string;
  symbol?: string;
  recoverable?: boolean;
}

interface LocalStateInfo {
  symbol?: string;
  direction?: string;
  entryPrice?: number | string;
}

interface SyncDiscrepancyPayload {
  tradeId: string;
  reason: string;
  localState: LocalStateInfo | null;
  brokerState: Record<string, unknown> | null;
}

/**
 * Formatea el evento SYSTEM_CRITICAL_ERROR.
 */
function formatCriticalError(payload: CriticalErrorPayload): string {
  const { source, error, symbol, recoverable } = payload;

  const sourceStr    = source  ? `[${source}]` : '[desconocido]';
  const symbolStr    = symbol  ? ` | ${symbol}` : '';
  const recoverLabel = recoverable === true
    ? ' (recuperable)'
    : recoverable === false
      ? ' (NO recuperable)'
      : '';

  return (
    `ERROR CRITICO${recoverLabel}: ${sourceStr}${symbolStr}\n` +
    `Detalle: ${error || 'sin detalle'}`
  );
}

/**
 * Formatea el evento SYSTEM_SYNC_DISCREPANCY.
 */
function formatSyncDiscrepancy(payload: SyncDiscrepancyPayload): string {
  const { tradeId, reason, localState, brokerState } = payload;

  const stateDesc = _describeDiscrepancyState(localState, brokerState);

  return (
    `Discrepancia detectada: ${tradeId}\n` +
    `Razon: ${reason || 'sin detalle'}\n` +
    stateDesc
  );
}

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

/**
 * Genera una descripcion breve del estado local vs broker.
 */
function _describeDiscrepancyState(
  localState: LocalStateInfo | null,
  brokerState: Record<string, unknown> | null,
): string {
  const hasLocal  = localState  != null;
  const hasBroker = brokerState != null;

  if (hasLocal && !hasBroker) {
    const { symbol, direction, entryPrice } = localState;
    const detail = symbol
      ? ` (${direction || '?'} ${symbol} @ ${entryPrice || '?'})`
      : '';
    return `Estado local: abierto${detail} | Broker: sin registro`;
  }

  if (!hasLocal && hasBroker) {
    return `Estado local: sin registro | Broker: posicion detectada`;
  }

  if (hasLocal && hasBroker) {
    return `Estado local: presente | Broker: presente (valores divergentes)`;
  }

  return 'Estado: sin informacion adicional';
}

export { formatCriticalError, formatSyncDiscrepancy };

export default { formatCriticalError, formatSyncDiscrepancy };
