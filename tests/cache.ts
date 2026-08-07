import assert from 'node:assert/strict';
import { CacheManager } from '../src/cache/index.js';
import { EntityCache } from '../src/cache/EntityCache.js';
import { PersistenceQueue } from '../src/cache/PersistenceQueue.js';
import { MemoryStore } from '../src/cache/MemoryStore.js';
import type { APIChannel, APIGuild, APIGuildMember, APIMessage, APIRole, APIUser } from '../src/types/index.js';

const user = (id: string, username = `user-${id}`): APIUser => ({ id, username } as APIUser);
const channel = (id: string, guildId: string): APIChannel => ({ id, guild_id: guildId } as APIChannel);
const member = (id: string): APIGuildMember => ({ user: user(id), roles: [] } as unknown as APIGuildMember);
const role = (id: string): APIRole => ({ id, name: `role-${id}` } as APIRole);
const message = (id: string, channelId: string, author: APIUser): APIMessage =>
  ({ id, channel_id: channelId, author, timestamp: new Date().toISOString(), content: '' } as APIMessage);

async function run(): Promise<void> {
  const lru = new MemoryStore<string>({ maxSize: 2 });
  lru.set('a', 'a');
  lru.set('b', 'b');
  assert.equal(lru.get('a'), 'a');
  lru.set('c', 'c');
  assert.deepEqual(lru.keys(), ['a', 'c']);
  assert.equal(lru.get('b'), undefined);

  let fetches = 0;
  const refreshable = new EntityCache<{ id: string; value: number }>(null, {
    entity: 'refreshable',
    fetcher: async (id) => ({ id, value: ++fetches }),
  });
  assert.equal((await refreshable.fetch('fresh'))?.value, 1);
  assert.equal((await refreshable.fetch('fresh'))?.value, 1);
  assert.equal((await refreshable.fetch('fresh', true))?.value, 2);

  const queue = new PersistenceQueue();
  const writes: string[] = [];
  const first = queue.enqueue('entity:1', async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    writes.push('first');
  });
  const second = queue.enqueue('entity:1', async () => writes.push('second'));
  await Promise.all([first, second]);
  assert.deepEqual(writes, ['first', 'second']);

  const expiring = new MemoryStore<string>({ defaultTTL: 0.02 });
  expiring.set('short-lived', 'value');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(expiring.get('short-lived'), undefined);

  const cache = new CacheManager({
    limits: {
      messagesPerChannel: 2,
      messagesGlobal: 2,
      membersPerGuild: 2,
      membersGlobal: 2,
      interactions: 2,
    },
    ttl: { users: 0.02, interactions: null },
  });
  const originalUser = cache.cacheUser(user('u1', 'before'));
  const canonicalUser = cache.cacheUser(user('u1', 'after'));
  assert.strictEqual(originalUser, canonicalUser);
  assert.equal(originalUser.username, 'after');

  cache.cacheMember('g1', member('u1'));
  assert.strictEqual(cache.members.get('g1', 'u1')?.user, cache.users.get('u1'));
  cache.cacheMemberChunk('g1', [member('u2'), member('u3')]);
  assert.equal(cache.members.get('g1', 'u1'), undefined);
  assert.equal(cache.members.get('g1', 'u2')?.user.id, 'u2');
  assert.equal(cache.getStats().members, 2);

  const globallyBounded = new CacheManager({
    limits: { membersPerGuild: 10, membersGlobal: 1 },
  });
  globallyBounded.cacheMember('g-a', member('a'));
  globallyBounded.cacheMember('g-b', member('b'));
  assert.equal(globallyBounded.members.scopeCount, 1);
  assert.equal(globallyBounded.members.get('g-a', 'a'), undefined);
  await globallyBounded.destroy();

  cache.cacheMessage(message('m1', 'c1', canonicalUser));
  cache.cacheMessage(message('m2', 'c1', canonicalUser));
  assert.equal(cache.messages.get('c1', 'm1')?.id, 'm1');
  cache.cacheMessage(message('m3', 'c1', canonicalUser));
  assert.equal(cache.messages.get('c1', 'm2'), undefined);

  cache.cacheInteraction({ id: 'i1', user: canonicalUser, guild_id: 'g1' });
  assert.strictEqual(cache.interactions.get('i1')?.user, cache.users.get('u1'));

  cache.cacheGuild({
    id: 'g1',
    roles: [role('r1')],
    channels: [channel('c1', 'g1')],
    members: [member('u1')],
  } as unknown as APIGuild & { channels: APIChannel[]; members: APIGuildMember[] });
  cache.deleteGuild('g1');
  assert.equal(cache.guilds.get('g1'), undefined);
  assert.equal(cache.members.get('g1', 'u1'), undefined);
  assert.equal(cache.roles.get('g1', 'r1'), undefined);
  assert.equal(cache.channels.get('c1'), undefined);
  assert.equal(cache.messages.get('c1', 'm3'), undefined);

  cache.cacheUser(user('ttl'));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(cache.users.get('ttl'), undefined);
  await cache.destroy();
}

run().then(
  () => console.log('Cache checks passed'),
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  },
);
