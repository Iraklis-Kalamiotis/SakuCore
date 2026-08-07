import 'dotenv/config';
import { Client, GatewayIntentBits } from '../src/index.js';
import type { GatewayReadyDispatchData, APIMessage } from '../src/types/index.js';

const client = new Client({
  token: process.env.DISCORD_TOKEN || '',
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  debug: true,
});

client.once('ready', (data) => {
  const ready = data as GatewayReadyDispatchData;
  console.log(`Logged in as ${ready.user.username} (${ready.user.id})`);
  console.log(`Serving ${ready.guilds.length} guild(s)`);
});

client.on('messageCreate', async (data) => {
  const msg = data as APIMessage;

  if (msg.author.bot) return;

  if (msg.content === '!ping') {
    await client.rest.sendMessage(msg.channel_id, {
      content: `Pong! Latency: ${client.ping}ms`,
    });
  }

  if (msg.content === '!info') {
    const channel = await client.rest.getChannel(msg.channel_id);
    await client.rest.sendMessage(msg.channel_id, {
      content: `Channel: ${channel.name}\nType: ${channel.type}`,
    });
  }
});

client.on('error', (err) => {
  console.error('Client error:', err);
});

client.login().catch((err) => {
  console.error('Failed to login:', err);
  process.exit(1);
});
