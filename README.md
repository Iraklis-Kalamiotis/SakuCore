# SakuCore

SakuCore is a TypeScript Discord API client built on `@discordjs/rest` and
`@discordjs/ws`. It provides typed gateway events, direct REST helpers,
optional entity caching, and an in-process sharding manager.

## Requirements

Node.js 20 or later is required.

## Installation

```sh
npm install sakucore
```

## Basic use

```ts
import { Client, GatewayIntentBits } from 'sakucore';

const client = new Client({
  token: process.env.DISCORD_TOKEN!,
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  cache: false,
});

client.on('interactionCreate', async (interaction) => {
  await client.rest.respondToInteraction(interaction.id, interaction.token!, {
    type: 4,
    data: { content: 'Hello!' },
  });
});

await client.login();
```

`cache: false` disables all cache allocation. When caching is enabled,
`client.cache` is a `CacheManager`; otherwise it is `null`.

Cache defaults are deliberately bounded for production use: 10,000 guilds,
100,000 channels and users, 10,000 members and 1,000 roles per guild, 50
messages per channel, and 100 interactions. Override individual limits only
after measuring your memory budget:

```ts
cache: {
  limits: { members: 2_000, messages: 100 },
}
```

Use the client sharding option for a fixed, in-process Discord shard set.
Changing a shard count while a session is running is intentionally unsupported
by Discord and SakuCore.

## Scripts

```sh
npm test
npm run build
```

## Live integration test

The opt-in integration test creates and removes temporary messages, an
application command, and a role. Provide a bot token and disposable test
resources; these values are never committed:

```sh
DISCORD_TOKEN=... \
SAKUCORE_TEST_GUILD_ID=... \
SAKUCORE_TEST_CHANNEL_ID=... \
SAKUCORE_TEST_USER_ID=... \
npm run test:live
```
