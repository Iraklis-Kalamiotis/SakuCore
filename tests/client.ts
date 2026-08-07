import assert from 'node:assert/strict';
import { Client, GatewayIntentBits } from '../src/index.js';

const uncached = new Client({
  token: 'test-token',
  intents: [GatewayIntentBits.Guilds],
  cache: false,
});
assert.equal(uncached.cache, null);
await uncached.destroy();

const cached = new Client({
  token: 'test-token',
  intents: [GatewayIntentBits.Guilds],
});
assert.ok(cached.cache);
cached.cache!.guilds.set({ id: 'guild-1' } as never);
(cached as unknown as {
  router: { dispatch(event: string, data: unknown): void };
}).router.dispatch('GUILD_DELETE', { id: 'guild-1', unavailable: true });
assert.ok(cached.cache!.guilds.get('guild-1'));
(cached as unknown as {
  router: { dispatch(event: string, data: unknown): void };
}).router.dispatch('GUILD_DELETE', { id: 'guild-1' });
assert.equal(cached.cache!.guilds.get('guild-1'), undefined);
await cached.destroy();

const sharded = new Client({
  token: 'test-token',
  intents: [GatewayIntentBits.Guilds],
  cache: false,
  sharding: { guildsPerShard: 2_000 },
});
assert.ok(sharded.sharding);
assert.equal(sharded.shardStatus?.totalShards, 0);
assert.equal(sharded.ping, -1);

let spawned = 0;
let destroyed = 0;
const manager = sharded.sharding!;
manager.spawnAll = async () => { spawned++; };
manager.destroyAll = async () => { destroyed++; };

let ready = false;
sharded.once('ready', () => { ready = true; });
(manager as unknown as {
  emit(event: 'dispatch', payload: { t: string; d: unknown }, shardId: number): void;
}).emit('dispatch', {
  t: 'READY',
  d: { user: { id: '1', username: 'Saku', discriminator: '0001', avatar: null } },
}, 0);
assert.equal(ready, true);
assert.equal(sharded.user?.id, '1');

await Promise.all([sharded.login(), sharded.login()]);
await Promise.all([sharded.destroy(), sharded.destroy()]);
assert.equal(spawned, 1);
assert.equal(destroyed, 1);

const errors: unknown[] = [];
const routed = new Client({
  token: 'test-token',
  intents: [GatewayIntentBits.Guilds],
  cache: false,
  onError: (error) => errors.push(error),
});
let onceCalls = 0;
routed.once('ready', async () => {
  onceCalls++;
  throw new Error('async listener failure');
});
(routed as unknown as {
  router: { dispatch(event: string, data: unknown): void };
}).router.dispatch('READY', {
  user: { id: '2', username: 'Saku', discriminator: '0001', avatar: null },
});
await new Promise((resolve) => setImmediate(resolve));
assert.equal(onceCalls, 1);
assert.equal(errors.length, 1);
await routed.destroy();

assert.throws(
  () => new Client({ token: '', intents: [GatewayIntentBits.Guilds] }),
  /token is required/,
);

console.log('Client checks passed');
