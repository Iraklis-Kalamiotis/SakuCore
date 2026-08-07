# SakuCore

SakuCore is a small, strongly typed Discord infrastructure framework built on
`@discordjs/ws` and `@discordjs/rest`. It deliberately does not provide an
application object model, command system, database layer, permissions layer, or
business features. Those belong in your application or plugins.

## Architecture

```text
Discord Gateway -> GatewayClient / ShardingManager -> EventRouter -> application and plugins
Discord REST    -> REST (typed helpers + raw request)
CacheManager    -> bounded memory LRU -> optional Redis -> REST refresh
```

`Client` owns lifecycle only: REST, gateway or sharding, cache, the event
router, error pipeline, and plugins. Gateway dispatch has one ingress listener
and uses an O(1) lookup table for routing. Listener promises are observed; an
exception or rejected promise is forwarded to `onError` and the `error` event.

## Install

```sh
npm install git+ssh://git@github.com/Iraklis-Kalamiotis/SakuCore.git
```

Node.js 20 or later is required.

## Use

```ts
import { Client, GatewayIntentBits } from 'sakucore';

const client = new Client({
  token: process.env.DISCORD_TOKEN!,
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  onError: console.error,
});

client.on('messageCreate', async (message) => {
  console.log(message.content);
});

await client.login();
```

Set `cache: false` to allocate no cache infrastructure. Otherwise caches are
bounded by default: 10k guilds, 100k channels/users, 100k members globally and
10k per guild, 50k messages globally and 50 per channel, 10k roles globally
and 1k per guild, plus 100 interactions. Use `client.cache?.getStats()` for
runtime cache counts.

## Raw REST access

Convenience methods cover common operations. For every other Discord endpoint,
use the rate-limit aware raw request API:

```ts
import { RequestMethod } from '@discordjs/rest';

const guild = await client.rest.request(RequestMethod.Get, '/guilds/123');
```

## Plugins

Plugins are infrastructure extensions, not core application features:

```ts
import { plugin } from 'sakucore';

const telemetry = plugin({
  metadata: { name: 'telemetry', version: '1.0.0' },
  onEnable: ({ events }) => events.on('ready', () => console.log('ready')),
});

const client = new Client({ token, intents, plugins: [telemetry] });
```

Plugins support dependency ordering and `onLoad`, `onEnable`, and `onDisable`
lifecycle hooks. Commands, moderation, databases, and similar features remain
application/plugin concerns.

## Sharding

Enable fixed, in-process sharding through the client:

```ts
const client = new Client({ token, intents, sharding: true });
```

SakuCore spawns one shard per identify bucket concurrently, then waits between
batches to respect Discord identify limits. A Discord session cannot change its
shard count while running, so dynamic scale-up is intentionally unsupported.
For multi-process or multi-host deployment, run separate application processes
and use Redis or another shared service for your own cross-process state.

## Validation

```sh
npm test
npm run build
```

`npm run test:live` is opt-in and creates/removes temporary Discord resources:

```sh
DISCORD_TOKEN=... SAKUCORE_TEST_GUILD_ID=... \
SAKUCORE_TEST_CHANNEL_ID=... SAKUCORE_TEST_USER_ID=... npm run test:live
```
