import 'dotenv/config';
import { REST, ShardingManager, GatewayIntentBits } from '../src/index.js';
import type { GatewayReadyDispatchData, APIMessage } from '../src/types/index.js';

const rest = new REST({
  token: process.env.DISCORD_TOKEN || '',
  debug: true,
});

const manager = new ShardingManager({
  token: process.env.DISCORD_TOKEN || '',
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  rest,
  autoScaling: true,
  scalingCheckInterval: 60_000,
  debug: true,
});

manager.on('shardReady', (shardId, data) => {
  const ready = data as GatewayReadyDispatchData;
  console.log(`Shard ${shardId} ready: ${ready.user.username} (${ready.user.id})`);
  console.log(`Serving ${ready.guilds.length} guild(s) on shard ${shardId}`);

  const stats = manager.getStats();
  console.log(`Stats: ${stats.readyShards}/${stats.totalShards} shards ready, avg latency: ${stats.avgLatency}ms`);
});

manager.on('shardDisconnect', (shardId, code) => {
  console.warn(`Shard ${shardId} disconnected with code ${code}`);
});

manager.on('shardError', (shardId, error) => {
  console.error(`Shard ${shardId} error:`, error);
});

manager.on('debug', (message) => {
  console.log(`[Debug] ${message}`);
});

// Handle SIGINT for graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  await manager.destroyAll();
  process.exit(0);
});

manager.spawnAll().catch((err) => {
  console.error('Failed to spawn shards:', err);
  process.exit(1);
});
