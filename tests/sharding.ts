import assert from 'node:assert/strict';
import { ShardingManager } from '../src/sharding/index.js';
import type { REST } from '../src/rest/index.js';
import { GatewayIntentBits } from '../src/types/index.js';

const rest = {
  client: {},
  async getGatewayBot() {
    return {
      url: 'wss://gateway.discord.gg',
      shards: 4,
      session_start_limit: { total: 1000, remaining: 1000, reset_after: 0, max_concurrency: 2 },
    };
  },
} as unknown as REST;

const manager = new ShardingManager({
  token: 'test-token',
  intents: [GatewayIntentBits.Guilds],
  rest,
  guildsPerShard: 2000,
  maxConcurrency: 1,
});
assert.equal(await manager.calculateShardCount(), 2);
await assert.rejects(() => manager.spawnShard(0), /between 0 and -1/);

let receivedDispatch = false;
let listenerFailures = 0;
const eventManager = new ShardingManager({
  token: 'test-token',
  intents: [GatewayIntentBits.Guilds],
  rest,
  onError: () => { listenerFailures++; },
});
eventManager.on('dispatch', (event, shardId) => {
  receivedDispatch = event.t === 'READY' && shardId === 0;
});
eventManager.on('dispatch', () => { throw new Error('listener failure'); });
(eventManager as unknown as {
  emit(event: 'dispatch', payload: { t: string; d: unknown }, shardId: number): void;
}).emit('dispatch', { t: 'READY', d: {} }, 0);
assert.equal(receivedDispatch, true);
assert.equal(listenerFailures, 1);

assert.throws(
  () => new ShardingManager({ token: '', intents: [], rest }),
  /non-empty string/,
);
assert.throws(
  () => new ShardingManager({ token: 'test-token', intents: [], rest, spawnTimeout: 0 }),
  /spawnTimeout/,
);

console.log('Sharding checks passed');
