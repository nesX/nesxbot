import type { MessageBroker } from '../types.js';

export function createMessageBroker(): MessageBroker {
  const handlers: Record<string, ((payload: unknown) => void | Promise<void>)[]> = {};

  return {
    subscribe(channel: string, handler: (payload: unknown) => void | Promise<void>): void {
      if (!handlers[channel]) handlers[channel] = [];
      handlers[channel].push(handler);
    },

    async publish(channel: string, payload: unknown): Promise<void> {
      for (const handler of handlers[channel] ?? []) {
        await handler(payload);
      }
    },

    unsubscribe(channel: string, handler: (payload: unknown) => void | Promise<void>): void {
      if (!handlers[channel]) return;
      handlers[channel] = handlers[channel].filter(h => h !== handler);
    },
  };
}
