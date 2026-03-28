/**
 * normalizers.ts
 *
 * Frontera entre el formato crudo de Binance y el formato interno de NesxTrader.
 * Ningún otro módulo debe conocer el formato de Binance — toda conversión ocurre aquí.
 *
 * Formato kline REST de Binance (array):
 * [0]  openTime        ms
 * [1]  open            string
 * [2]  high            string
 * [3]  low             string
 * [4]  close           string
 * [5]  volume          string
 * [6]  closeTime       ms
 * [7]  quoteAssetVolume
 * [8]  numberOfTrades
 * [9]  takerBuyBaseVolume
 * [10] takerBuyQuoteVolume
 * [11] ignore
 *
 * Formato kline WebSocket de Binance (objeto dentro de event.k):
 * { t, o, h, l, c, v, x (isClosed), s (symbol), i (interval), ... }
 */

import type { Candle } from '../types.js';

/**
 * Convierte un array kline de la REST API de Binance al formato interno Candle.
 *
 * @param rawKline  - Array de 12 elementos devuelto por /api/v3/klines
 * @param symbol    - Par de trading (ej. 'BTCUSDT')
 * @param timeframe - Intervalo (ej. '1m', '15m', '4h')
 */
function normalizeRestKline(rawKline: unknown[], symbol: string, timeframe: string): Candle {
  if (!Array.isArray(rawKline) || rawKline.length < 6) {
    throw new Error(
      `normalizeRestKline: formato de kline inválido para ${symbol}/${timeframe}`
    );
  }

  return {
    symbol,
    timeframe,
    openTime: Number(rawKline[0]),
    open:     parseFloat(String(rawKline[1])),
    high:     parseFloat(String(rawKline[2])),
    low:      parseFloat(String(rawKline[3])),
    close:    parseFloat(String(rawKline[4])),
    volume:   parseFloat(String(rawKline[5])),
    isClosed: true, // las velas REST siempre son velas cerradas
  };
}

/**
 * Convierte el objeto `k` dentro de un evento WebSocket de Binance al formato interno Candle.
 *
 * @param wsKline - El objeto `k` del evento kline del WebSocket de Binance
 */
function normalizeWsKline(wsKline: Record<string, unknown>): Candle {
  if (!wsKline || typeof wsKline !== 'object') {
    throw new Error('normalizeWsKline: wsKline debe ser un objeto');
  }

  const requiredFields = ['s', 'i', 't', 'o', 'h', 'l', 'c', 'v', 'x'];
  for (const field of requiredFields) {
    if (wsKline[field] === undefined) {
      throw new Error(`normalizeWsKline: campo requerido '${field}' ausente`);
    }
  }

  return {
    symbol:    String(wsKline['s']),
    timeframe: String(wsKline['i']),
    openTime:  Number(wsKline['t']),
    open:      parseFloat(String(wsKline['o'])),
    high:      parseFloat(String(wsKline['h'])),
    low:       parseFloat(String(wsKline['l'])),
    close:     parseFloat(String(wsKline['c'])),
    volume:    parseFloat(String(wsKline['v'])),
    isClosed:  wsKline['x'] === true,
  };
}

/**
 * Convierte un intervalo en formato interno ('1m', '15m', '4h') al formato de Binance.
 * En Binance son idénticos, pero esta función actúa como documentación explícita del contrato.
 */
function timeframeToBinanceInterval(timeframe: string): string {
  const map: Record<string, string> = {
    '1s':  '1s',
    '1m':  '1m',
    '3m':  '3m',
    '5m':  '5m',
    '15m': '15m',
    '30m': '30m',
    '1h':  '1h',
    '2h':  '2h',
    '4h':  '4h',
    '6h':  '6h',
    '8h':  '8h',
    '12h': '12h',
    '1d':  '1d',
    '3d':  '3d',
    '1w':  '1w',
    '1M':  '1M',
  };

  if (!map[timeframe]) {
    throw new Error(`timeframeToBinanceInterval: timeframe '${timeframe}' no soportado`);
  }

  return map[timeframe];
}

export {
  normalizeRestKline,
  normalizeWsKline,
  timeframeToBinanceInterval,
};
