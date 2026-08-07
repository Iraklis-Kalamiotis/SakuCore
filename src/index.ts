export { Client } from './client/index.js';
export type { ClientEvents, ClientOptions, ClientServices, ClientShardingOptions } from './client/index.js';
export { ErrorManager } from './core/ErrorManager.js';
export type { ErrorReporter } from './core/ErrorManager.js';
export { EventRouter } from './events/EventRouter.js';
export type { EventHandler, GatewayDispatchHandler } from './events/EventRouter.js';
import { plugin } from './plugins/index.js';

export { plugin, PluginManager } from './plugins/index.js';
export type { Plugin, PluginContext, PluginMetadata } from './plugins/index.js';
export { REST } from './rest/index.js';
export type { RESTOptions } from './rest/index.js';
export { GatewayClient } from './gateway/index.js';
export { WebSocketShardEvents, WebSocketShardStatus } from './gateway/index.js';
export { ShardingManager } from './sharding/index.js';
export type { ShardingManagerEvents, ShardingManagerOptions, ShardingStats, ShardInfo } from './sharding/index.js';
export { CacheManager } from './cache/index.js';
export type { CachedInteraction, CacheManagerOptions, CacheLimits, CacheTTL } from './cache/index.js';
export * from './types/index.js';

/** Minimal namespace-style plugin entry point. */
export const SakuCore = { plugin };
