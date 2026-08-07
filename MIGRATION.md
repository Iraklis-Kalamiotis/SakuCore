# Migrating from v2 to v3

## Plugins

`plugin()` remains available as a deprecated alias. Prefer `definePlugin()`:

```ts
import { definePlugin } from 'sakucore';

export default definePlugin({
  metadata: { name: 'example', version: '1.0.0' },
  setup(context) {
    context.events.on('ready', () => console.log('ready'));
    context.cleanup(() => console.log('disposed'));
  },
});
```

**Why:** v3 gives each plugin an abort signal, scoped event API, cleanup
registry, transactional lifecycle, and reverse-order rollback.

Lifecycle hooks are now `setup`, `onLoad`, `onEnable`, `onDisable`, and
`onUnload`. Plugins are enabled before gateway connection, so a startup plugin
cannot miss `ready`.

## Cache limits

v2's `members`, `messages`, and `roles` limits are replaced by explicit
per-scope and global limits:

```ts
// v2
limits: { members: 2_000, messages: 100 }

// v3
limits: {
  membersPerGuild: 2_000,
  membersGlobal: 50_000,
  messagesPerChannel: 100,
  messagesGlobal: 10_000,
}
```

**Why:** per-scope limits alone cannot bound process memory.

## Gateway module

The internal `ws` module moved to `gateway`. Continue importing
`GatewayClient` from the package root; root imports remain stable.

## Redis

Redis remains optional by default. Set `cache.redis.required: true` when an
application must fail startup instead of operating with memory-only caching.
v3 serializes persistence operations per entity key to prevent stale
out-of-order writes.

## Sharding

Shard startup remains fixed-count and in-process. v3 validates Discord's
available identify budget before startup, starts one shard per identify bucket
concurrently, and tears down already-started shards when any batch fails.
