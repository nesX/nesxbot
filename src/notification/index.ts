/**
 * src/notification/index.ts
 *
 * Exporta los componentes publicos del modulo Notification Engine.
 *
 * Uso tipico (Live / Dry Run):
 *
 *   import { NotificationEngine, ConsoleChannel, TelegramChannel } from './notification/index.js';
 *
 *   const engine = new NotificationEngine({ messageBroker, timeProvider });
 *   engine.addChannel(new ConsoleChannel({ timeProvider }));
 *
 *   if (config.telegram.enabled) {
 *     engine.addChannel(new TelegramChannel({
 *       botToken: config.telegram.botToken,
 *       chatId:   config.telegram.chatId,
 *     }));
 *   }
 *
 *   engine.start();
 *
 * Nota: el modulo NO debe instanciarse en modo Backtest.
 */

import NotificationEngine from './NotificationEngine.js';
import ConsoleChannel     from './channels/ConsoleChannel.js';
import TelegramChannel    from './channels/TelegramChannel.js';
import TradeFormatter     from './formatters/TradeFormatter.js';
import ErrorFormatter     from './formatters/ErrorFormatter.js';

export { NotificationEngine, ConsoleChannel, TelegramChannel, TradeFormatter, ErrorFormatter };
