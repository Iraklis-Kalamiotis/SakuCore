import { WebSocketManager, WebSocketShardEvents, WebSocketShardStatus } from '@discordjs/ws';
import type { REST } from '../rest/index.js';
import type { GatewayIntentBits, APIGatewaySessionStartLimit } from '../types/index.js';
import type { GatewayDispatchPayload, GatewayReadyDispatchData } from 'discord-api-types/v10';

export interface ShardInfo {
  id: number;
  status: WebSocketShardStatus;
  latency: number;
  sessionId: string | null;
  sequence: number;
}

export interface ShardingManagerOptions {
  token: string;
  intents: GatewayIntentBits[];
  rest: REST;
  /**
   * The target number of guilds per shard. Discord's recommendation assumes
   * approximately 1,000 guilds per shard.
   */
  guildsPerShard?: number;
  maxConcurrency?: number;
  spawnDelay?: number;
  spawnTimeout?: number;
  /** @deprecated Discord does not support changing a session's shard count. */
  autoScaling?: boolean;
  /** @deprecated Dynamic shard scaling is unsupported. */
  scalingCheckInterval?: number;
  debug?: boolean;
  /** Receives errors thrown by event listeners without interrupting shard management. */
  onError?: (error: unknown) => void;
}

interface SessionInfo {
  sessionId: string;
  sequence: number;
  resumeURL: string;
}

export interface ShardingManagerEvents {
  shardCreate: [shardId: number];
  shardReady: [shardId: number, data: GatewayReadyDispatchData];
  shardDisconnect: [shardId: number, code: number];
  shardError: [shardId: number, error: Error];
  debug: [message: string];
  statsUpdate: [shardId: number, stats: { ackAt: number; heartbeatAt: number; latency: number }];
  /** Raw gateway dispatch with the shard that received it. */
  dispatch: [event: GatewayDispatchPayload, shardId: number];
}

export interface ShardingStats {
  totalShards: number;
  readyShards: number;
  avgLatency: number;
  shards: ShardInfo[];
}

type ShardingManagerEvent = keyof ShardingManagerEvents;
type ShardingManagerEventHandler<Event extends ShardingManagerEvent> = (...args: ShardingManagerEvents[Event]) => void;

export class ShardingManager {
  private readonly token: string;
  private readonly intents: GatewayIntentBits[];
  private readonly rest: REST;
  private readonly guildsPerShard: number;
  private readonly configuredMaxConcurrency: number | null;
  private readonly spawnDelay: number;
  private readonly spawnTimeout: number;
  private readonly debug: (msg: string) => void;

  private totalShards = 0;
  private readonly shards = new Map<number, WebSocketManager>();
  private readonly shardInfo = new Map<number, ShardInfo>();
  private readonly sessions = new Map<number, SessionInfo>();
  private readonly eventHandlers = new Map<ShardingManagerEvent, Set<ShardingManagerEventHandler<ShardingManagerEvent>>>();
  private maxConcurrency = 1;
  private gatewayInfo: { url: string; session_start_limit: APIGatewaySessionStartLimit } | null = null;
  private readonly identifyBuckets = new Map<number, number>();
  private readonly onError: (error: unknown) => void;

  constructor(options: ShardingManagerOptions) {
    if (!options || typeof options !== 'object') {
      throw new TypeError('ShardingManager options must be an object');
    }
    if (typeof options.token !== 'string' || options.token.length === 0) {
      throw new TypeError('ShardingManager token must be a non-empty string');
    }
    if (!Array.isArray(options.intents) || !options.intents.every((intent) => Number.isInteger(intent) && intent >= 0)) {
      throw new TypeError('ShardingManager intents must be an array of non-negative integer intent flags');
    }
    if (!options.rest || typeof options.rest !== 'object'
      || typeof options.rest.getGatewayBot !== 'function' || !options.rest.client) {
      throw new TypeError('ShardingManager rest must provide getGatewayBot() and a REST client');
    }
    this.validateOptionalInteger(options.guildsPerShard, 'guildsPerShard', 1);
    this.validateOptionalInteger(options.maxConcurrency, 'maxConcurrency', 1);
    this.validateOptionalNumber(options.spawnDelay, 'spawnDelay', 0);
    this.validateOptionalNumber(options.spawnTimeout, 'spawnTimeout', Number.EPSILON);
    this.validateOptionalNumber(options.scalingCheckInterval, 'scalingCheckInterval', Number.EPSILON);
    if (options.autoScaling !== undefined && typeof options.autoScaling !== 'boolean') {
      throw new TypeError('autoScaling must be a boolean');
    }
    if (options.debug !== undefined && typeof options.debug !== 'boolean') {
      throw new TypeError('debug must be a boolean');
    }
    if (options.onError !== undefined && typeof options.onError !== 'function') {
      throw new TypeError('onError must be a function');
    }

    this.token = options.token;
    this.intents = options.intents;
    this.rest = options.rest;
    this.guildsPerShard = options.guildsPerShard ?? 1000;
    this.configuredMaxConcurrency = options.maxConcurrency ?? null;
    this.spawnDelay = options.spawnDelay ?? 5500;
    this.spawnTimeout = options.spawnTimeout ?? 30_000;
    this.debug = options.debug ? (msg) => {
      console.log(`[Sharding] ${msg}`);
      this.emit('debug', msg);
    } : () => {};
    this.onError = options.onError ?? ((error) => console.error('[SakuCore]', error));

    if (options.autoScaling) {
      this.debug('autoScaling is disabled: Discord sessions cannot change shard count after spawning');
    }
  }

  get shardCount(): number {
    return this.totalShards;
  }

  get shardIds(): number[] {
    return [...this.shards.keys()].sort((a, b) => a - b);
  }

  on<Event extends ShardingManagerEvent>(event: Event, handler: ShardingManagerEventHandler<Event>): this {
    const existing = this.eventHandlers.get(event) ?? new Set<ShardingManagerEventHandler<ShardingManagerEvent>>();
    existing.add(handler as ShardingManagerEventHandler<ShardingManagerEvent>);
    this.eventHandlers.set(event, existing);
    return this;
  }

  off<Event extends ShardingManagerEvent>(event: Event, handler: ShardingManagerEventHandler<Event>): this {
    this.eventHandlers.get(event)?.delete(handler as ShardingManagerEventHandler<ShardingManagerEvent>);
    return this;
  }

  private emit<Event extends ShardingManagerEvent>(event: Event, ...args: ShardingManagerEvents[Event]): void {
    const existing = this.eventHandlers.get(event);
    if (existing) {
      for (const handler of [...existing]) {
        try {
          handler(...args);
        } catch (error) {
          this.reportListenerError(error);
        }
      }
    }
  }

  private reportListenerError(error: unknown): void {
    try {
      this.onError(error);
    } catch (reportingError) {
      console.error('[SakuCore] Error handler failed while reporting a sharding listener error', reportingError);
    }
  }

  private validateOptionalInteger(value: unknown, name: string, minimum: number): void {
    if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)) {
      throw new RangeError(`${name} must be an integer greater than or equal to ${minimum}`);
    }
  }

  private validateOptionalNumber(value: unknown, name: string, minimum: number): void {
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < minimum)) {
      throw new RangeError(`${name} must be a finite number greater than or equal to ${minimum}`);
    }
  }

  // --- Gateway info ---

  async fetchGatewayInfo(): Promise<{ url: string; session_start_limit: APIGatewaySessionStartLimit; shards: number }> {
    const info = await this.rest.getGatewayBot();
    if (!Number.isSafeInteger(info.shards) || info.shards < 1) {
      throw new Error('Gateway returned an invalid shard count');
    }
    if (!Number.isSafeInteger(info.session_start_limit.max_concurrency) || info.session_start_limit.max_concurrency < 1) {
      throw new Error('Gateway returned an invalid max concurrency');
    }
    this.gatewayInfo = info;
    this.maxConcurrency = this.configuredMaxConcurrency === null
      ? info.session_start_limit.max_concurrency
      : Math.min(this.configuredMaxConcurrency, info.session_start_limit.max_concurrency);
    this.debug(`Gateway info: url=${info.url}, shards=${info.shards}, remaining=${info.session_start_limit.remaining}`);
    return { ...info, shards: info.shards };
  }

  // --- Shard count calculation ---

  async calculateShardCount(): Promise<number> {
    const info = await this.fetchGatewayInfo();
    const shardCount = Math.ceil((info.shards * 1000) / this.guildsPerShard);
    if (!Number.isSafeInteger(shardCount) || shardCount < 1) {
      throw new Error('Calculated shard count is invalid');
    }
    return shardCount;
  }

  // --- Identify throttling ---

  private async waitForIdentify(shardId: number): Promise<void> {
    const bucket = shardId % this.maxConcurrency;
    const lastIdentify = this.identifyBuckets.get(bucket) ?? 0;
    const now = Date.now();
    const waitTime = Math.max(0, 5000 - (now - lastIdentify));

    if (waitTime > 0) {
      this.debug(`Shard ${shardId} waiting ${waitTime}ms for identify throttle (bucket ${bucket})`);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    this.identifyBuckets.set(bucket, Date.now());
  }

  // --- Session persistence ---

  private storeSession(shardId: number, sessionId: string, sequence: number, resumeURL: string): void {
    this.sessions.set(shardId, { sessionId, sequence, resumeURL });
  }

  private getSession(shardId: number): SessionInfo | null {
    return this.sessions.get(shardId) ?? null;
  }

  // --- Shard management ---

  async spawnShard(shardId: number): Promise<void> {
    if (!Number.isSafeInteger(shardId) || shardId < 0 || shardId >= this.totalShards) {
      throw new RangeError(`shardId must be an integer between 0 and ${this.totalShards - 1}`);
    }
    if (this.shards.has(shardId)) {
      this.debug(`Shard ${shardId} already exists`);
      return;
    }

    if (!this.gatewayInfo) await this.fetchGatewayInfo();
    await this.waitForIdentify(shardId);

    const manager = new WebSocketManager({
      token: this.token,
      intents: this.intents.reduce((acc, intent) => (acc | intent) as GatewayIntentBits, 0 as GatewayIntentBits),
      rest: this.rest.client,
      shardCount: this.totalShards,
      shardIds: [shardId],
      retrieveSessionInfo: () => {
        const session = this.getSession(shardId);
        return session ? {
          sessionId: session.sessionId,
          sequence: session.sequence,
          shardId,
          shardCount: this.totalShards,
          resumeURL: session.resumeURL,
        } : null;
      },
      updateSessionInfo: (_id, sessionInfo) => {
        if (sessionInfo) {
          this.storeSession(shardId, sessionInfo.sessionId, sessionInfo.sequence, sessionInfo.resumeURL);
        }
      },
    });

    manager.on(WebSocketShardEvents.Ready, (data) => {
      this.debug(`Shard ${shardId} ready`);
      this.updateShardInfo(shardId, {
        id: shardId,
        status: WebSocketShardStatus.Ready,
        latency: 0,
        sessionId: data.session_id,
        sequence: 0,
      });
      this.emit('shardReady', shardId, data);
    });

    manager.on(WebSocketShardEvents.Closed, (code) => {
      this.debug(`Shard ${shardId} closed: code=${code}`);
      this.updateShardInfo(shardId, {
        id: shardId,
        status: WebSocketShardStatus.Idle,
        latency: -1,
        sessionId: null,
        sequence: 0,
      });
      this.emit('shardDisconnect', shardId, code);
    });

    manager.on(WebSocketShardEvents.Error, (error) => {
      this.debug(`Shard ${shardId} error: ${error}`);
      this.emit('shardError', shardId, error);
    });

    manager.on(WebSocketShardEvents.HeartbeatComplete, (stats) => {
      const current = this.shardInfo.get(shardId);
      this.updateShardInfo(shardId, {
        ...(current ?? {
          id: shardId,
          status: WebSocketShardStatus.Connecting,
          latency: -1,
          sessionId: null,
          sequence: 0,
        }),
        latency: stats.latency,
      });
      this.emit('statsUpdate', shardId, stats);
    });

    manager.on(WebSocketShardEvents.Dispatch, (event) => {
      // Forward all dispatch events with shard context
      this.emit('dispatch', event, shardId);
    });

    this.shards.set(shardId, manager);
    this.updateShardInfo(shardId, {
      id: shardId,
      status: WebSocketShardStatus.Connecting,
      latency: -1,
      sessionId: null,
      sequence: 0,
    });

    this.emit('shardCreate', shardId);

    try {
      await this.connectWithTimeout(manager, shardId);
    } catch (error) {
      this.debug(`Shard ${shardId} failed to connect: ${error}`);
      this.shards.delete(shardId);
      this.shardInfo.delete(shardId);
      try {
        await manager.destroy();
      } catch (destroyError) {
        throw new AggregateError(
          [error, destroyError],
          `Shard ${shardId} failed to connect and could not be destroyed cleanly`,
        );
      }
      throw error;
    }
  }

  async spawnAll(totalShards?: number): Promise<void> {
    if (this.shards.size > 0) {
      throw new Error('Cannot spawn a new shard set while shards are running; destroy all shards first');
    }
    if (totalShards !== undefined) {
      if (!Number.isSafeInteger(totalShards) || totalShards < 1) {
        throw new RangeError('totalShards must be a positive integer');
      }
      this.totalShards = totalShards;
    } else {
      this.totalShards = await this.calculateShardCount();
    }

    this.debug(`Spawning ${this.totalShards} shards`);

    for (let start = 0; start < this.totalShards; start += this.maxConcurrency) {
      const shardIds = Array.from(
        { length: Math.min(this.maxConcurrency, this.totalShards - start) },
        (_, offset) => start + offset,
      );
      await Promise.all(shardIds.map((shardId) => this.spawnShard(shardId)));

      if (start + this.maxConcurrency < this.totalShards) {
        this.debug(`Waiting ${this.spawnDelay}ms before the next identify bucket batch`);
        await new Promise((resolve) => setTimeout(resolve, this.spawnDelay));
      }
    }
  }

  private async connectWithTimeout(manager: WebSocketManager, shardId: number): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const connection = manager.connect();
    const timedConnection = new Promise<void>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(`Shard ${shardId} did not connect within ${this.spawnTimeout}ms`));
      }, this.spawnTimeout);
    });

    try {
      await Promise.race([connection, timedConnection]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private updateShardInfo(shardId: number, info: ShardInfo): void {
    this.shardInfo.set(shardId, info);
  }

  // --- Stats ---

  getStats(): ShardingStats {
    const shards = [...this.shardInfo.values()].map((shard) => ({ ...shard }));
    const readyShards = shards.filter((s) => s.status === WebSocketShardStatus.Ready).length;
    const latencies = shards.filter((s) => s.latency > 0).map((s) => s.latency);
    const avgLatency = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : -1;

    return {
      totalShards: this.totalShards,
      readyShards,
      avgLatency,
      shards,
    };
  }

  // --- Lifecycle ---

  async destroyAll(): Promise<void> {
    const destroyPromises = [...this.shards.entries()].map(async ([id, manager]) => {
      this.debug(`Destroying shard ${id}`);
      await manager.destroy();
    });

    const results = await Promise.allSettled(destroyPromises);
    this.shards.clear();
    this.shardInfo.clear();
    this.sessions.clear();
    this.identifyBuckets.clear();
    this.totalShards = 0;
    this.debug('All shards destroyed');

    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'One or more shards could not be destroyed cleanly');
  }

  async respawnAll(): Promise<void> {
    this.debug('Respawning all shards');
    await this.destroyAll();
    await this.spawnAll();
  }
}
