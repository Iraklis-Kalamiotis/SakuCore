import { WebSocketManager, WebSocketShardEvents } from '@discordjs/ws';
import type { GatewayIntentBits, GatewayReadyDispatchData } from '../types/index.js';
import type { REST } from '../rest/index.js';

export { WebSocketShardEvents, WebSocketShardStatus } from '@discordjs/ws';

interface GatewayOptions {
  token: string;
  intents: GatewayIntentBits[];
  rest: REST;
  debug?: boolean;
}

type GatewayEventHandler = (data: unknown) => void;

export class GatewayClient {
  readonly manager: WebSocketManager;
  private readonly handlers = new Map<string, GatewayEventHandler[]>();
  private _ping = -1;

  constructor(options: GatewayOptions) {
    const intentsValue: GatewayIntentBits | 0 =
      options.intents.length > 0
        ? options.intents.reduce<GatewayIntentBits>((acc, intent) => (acc | intent) as GatewayIntentBits, 0 as GatewayIntentBits)
        : 0;

    this.manager = new WebSocketManager({
      token: options.token,
      intents: intentsValue,
      rest: options.rest.client,
    });

    if (options.debug) {
      this.manager.on(WebSocketShardEvents.Debug, (message, shardId) => {
        console.log(`[WS] [Shard ${shardId}] ${message}`);
      });
    }

    this.manager.on(WebSocketShardEvents.HeartbeatComplete, (stats) => {
      this._ping = stats.latency;
    });

    this.manager.on(WebSocketShardEvents.Dispatch, (event) => {
      this.emit(event.t, event.d);
    });

    this.manager.on(WebSocketShardEvents.Error, (error) => {
      this.emit('error', error);
    });
  }

  get ping(): number {
    return this._ping;
  }

  on(event: string, handler: GatewayEventHandler): void {
    const existing = this.handlers.get(event) ?? [];
    existing.push(handler);
    this.handlers.set(event, existing);
  }

  off(event: string, handler: GatewayEventHandler): void {
    const existing = this.handlers.get(event);
    if (existing) {
      const index = existing.indexOf(handler);
      if (index !== -1) existing.splice(index, 1);
    }
  }

  private emit(event: string, data: unknown): void {
    const existing = this.handlers.get(event);
    if (existing) {
      for (const handler of [...existing]) {
        handler(data);
      }
    }
  }

  async connect(): Promise<void> {
    await this.manager.connect();
  }

  async destroy(): Promise<void> {
    await this.manager.destroy();
  }
}
