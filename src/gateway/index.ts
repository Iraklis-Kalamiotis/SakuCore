import { WebSocketManager, WebSocketShardEvents } from '@discordjs/ws';
import type { GatewayIntentBits } from '../types/index.js';
import type { REST } from '../rest/index.js';

export { WebSocketShardEvents, WebSocketShardStatus } from '@discordjs/ws';

export interface GatewayClientOptions {
  token: string;
  intents: GatewayIntentBits[];
  rest: REST;
  debug?: boolean;
}

export type GatewayEventHandler = (data: unknown) => void;

/**
 * Thin gateway transport wrapper. It forwards raw dispatches and exposes
 * latency while leaving Discord connection and resume behavior to
 * `@discordjs/ws`.
 */
export class GatewayClient {
  readonly manager: WebSocketManager;
  private readonly handlers = new Map<string, Set<GatewayEventHandler>>();
  private latency = -1;

  constructor(options: GatewayClientOptions) {
    const intents = options.intents.reduce((value, intent) => (value | intent) as GatewayIntentBits, 0 as GatewayIntentBits);
    this.manager = new WebSocketManager({ token: options.token, intents, rest: options.rest.client });
    if (options.debug) {
      this.manager.on(WebSocketShardEvents.Debug, (message, shardId) => console.log(`[WS] [Shard ${shardId}] ${message}`));
    }
    this.manager.on(WebSocketShardEvents.HeartbeatComplete, (stats) => { this.latency = stats.latency; });
    this.manager.on(WebSocketShardEvents.Dispatch, (event) => {
      this.emit('dispatch', event);
      this.emit(event.t, event.d);
    });
    this.manager.on(WebSocketShardEvents.Error, (error) => this.emit('error', error));
  }

  get ping(): number {
    return this.latency;
  }

  on(event: string, handler: GatewayEventHandler): this {
    const handlers = this.handlers.get(event) ?? new Set<GatewayEventHandler>();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return this;
  }

  off(event: string, handler: GatewayEventHandler): this {
    this.handlers.get(event)?.delete(handler);
    return this;
  }

  async connect(): Promise<void> {
    await this.manager.connect();
  }

  async destroy(): Promise<void> {
    await this.manager.destroy();
    this.handlers.clear();
  }

  private emit(event: string | null, data: unknown): void {
    if (!event) return;
    for (const handler of this.handlers.get(event) ?? []) handler(data);
  }
}
