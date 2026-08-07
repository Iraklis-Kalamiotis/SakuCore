import 'dotenv/config';
import { Client, GatewayIntentBits } from '../src/index.js';
import type { GatewayReadyDispatchData, APIMessage } from '../src/types/index.js';

type GuildMessage = APIMessage & { guild_id?: string };
type CachedGuild = { member_count?: number; channels?: unknown[] };

const client = new Client({
  token: process.env.DISCORD_TOKEN || '',
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  debug: true,
  cache: {
    redis: process.env.REDIS_URL ? { host: 'localhost', port: 6379 } : null,
    limits: {
      messagesPerChannel: 5,
      messagesGlobal: 5,
      membersPerGuild: 200,
      membersGlobal: 200,
    },
    ttl: {
      guilds: null,
      channels: null,
      members: 86400,
      users: 86400,
      roles: null,
      messages: 3600,
    },
    sweeper: {
      messages: { interval: 60, lifetime: 3600 },
      users: { interval: 60, lifetime: 86400 },
    },
  },
});
const cache = client.cache;
if (!cache) throw new Error('The cached bot example requires caching to be enabled');

function reply(msg: GuildMessage, content: string) {
  return client.rest.sendMessage(msg.channel_id, { content });
}

client.once('ready', (data) => {
  const ready = data as GatewayReadyDispatchData;
  console.log(`Logged in as ${ready.user.username} (${ready.user.id})`);
  console.log(`Serving ${ready.guilds.length} guild(s)`);
  console.log(`Cache: enabled`);
});

function getGuildIdFromMessage(msg: GuildMessage): string | null {
  if (msg.guild_id) return msg.guild_id;
  if (msg.channel_id === '1471195115862102205') {
    return '1471195114490560769';
  }
  return null;
}

client.on('messageCreate', async (data) => {
  const msg = data as GuildMessage;
  if (msg.author.bot) return;

  const [cmd, ...args] = msg.content.split(' ');
  const guildId = getGuildIdFromMessage(msg);

  // ── General ──────────────────────────────────────────────

  if (cmd === '!ping') {
    return reply(msg, `Pong! Latency: ${client.ping}ms`);
  }

  // ── Guild cache ──────────────────────────────────────────

  if (cmd === '!guilds') {
    const ids = cache.guilds.keys();
    const list = ids.slice(0, 10).map((id) => {
      const g = cache.guilds.get(id);
      return g ? `${g.name} (${id})` : id;
    }).join('\n');
    return reply(msg, `**Cached guilds (${ids.length}):**\n${list || 'none'}`);
  }

  if (cmd === '!guild' && guildId) {
    const g = cache.guilds.get(guildId);
    if (!g) return reply(msg, 'Guild not in cache.');
    return reply(msg, [
      `**${g.name}** (${g.id})`,
      `Owner: ${g.owner_id}`,
      `Members: ${(g as CachedGuild).member_count ?? 'N/A'}`,
      `Channels: ${(g as CachedGuild).channels?.length ?? 'N/A'}`,
      `Roles: ${g.roles.length}`,
    ].join('\n'));
  }

  if (cmd === '!guildfetch' && guildId) {
    const g = await cache.guilds.fetch(guildId, true);
    if (!g) return reply(msg, 'Failed to fetch guild from API.');
    return reply(msg, `Fetched **${g.name}** — ${(g as CachedGuild).member_count ?? 'N/A'} members`);
  }

  // ── Channel cache ────────────────────────────────────────

  if (cmd === '!channels' && guildId) {
    const ids = cache.channels.keys();
    return reply(msg, `**Cached channels (${ids.length}):**\n${ids.slice(0, 15).join('\n') || 'none'}`);
  }

  if (cmd === '!channel') {
    const targetId = args[0] || msg.channel_id;
    const ch = cache.channels.get(targetId);
    if (!ch) return reply(msg, 'Channel not in cache.');
    return reply(msg, [
      `**${ch.name ?? 'DM'}** (${ch.id})`,
      `Type: ${ch.type}`,
      `Guild: ${'guild_id' in ch ? ch.guild_id ?? 'N/A' : 'N/A'}`,
    ].join('\n'));
  }

  if (cmd === '!channelfetch') {
    const targetId = args[0] || msg.channel_id;
    const ch = await cache.channels.fetch(targetId, true);
    if (!ch) return reply(msg, 'Failed to fetch channel from API.');
    return reply(msg, `Fetched **${ch.name ?? 'DM'}** (${ch.id})`);
  }

  // ── User cache ───────────────────────────────────────────

  if (cmd === '!users') {
    const ids = cache.users.keys();
    return reply(msg, `**Cached users (${ids.length}):**\n${ids.slice(0, 15).join('\n') || 'none'}`);
  }

  if (cmd === '!user') {
    const targetId = args[0] || msg.author.id;
    const u = cache.users.get(targetId);
    if (!u) return reply(msg, 'User not in cache.');
    return reply(msg, [
      `**${u.username}** (${u.id})`,
      `Bot: ${u.bot ? 'yes' : 'no'}`,
      `System: ${u.system ? 'yes' : 'no'}`,
    ].join('\n'));
  }

  if (cmd === '!userfetch') {
    const targetId = args[0] || msg.author.id;
    const u = await cache.users.fetch(targetId, true);
    if (!u) return reply(msg, 'Failed to fetch user from API.');
    return reply(msg, `Fetched **${u.username}** (${u.id})`);
  }

  // ── Member cache ─────────────────────────────────────────

  if (cmd === '!members' && guildId) {
    const ids = cache.members.keys(guildId);
    const members = cache.members.values(guildId);
    const list = members.slice(0, 10).map((m) => `• ${m.user.username} (${m.user.id})`).join('\n');
    return reply(msg, `**Members cached for this guild (${ids.length}):**\n${list || 'none'}`);
  }

  if (cmd === '!member' && guildId) {
    const targetId = args[0] || msg.author.id;
    const m = cache.members.get(guildId, targetId);
    if (!m) return reply(msg, 'Member not in cache.');
    return reply(msg, [
      `**${m.user.username}** (${m.user.id})`,
      `Nickname: ${m.nick ?? 'none'}`,
      `Joined: ${m.joined_at}`,
      `Roles: ${m.roles.length}`,
    ].join('\n'));
  }

  if (cmd === '!memberfetch' && guildId) {
    const targetId = args[0] || msg.author.id;
    const m = await cache.members.fetch(guildId, targetId, true);
    if (!m) return reply(msg, 'Failed to fetch member from API.');
    return reply(msg, `Fetched **${m.user.username}** (${m.user.id})`);
  }

  // ── Role cache ───────────────────────────────────────────

  if (cmd === '!roles' && guildId) {
    const ids = cache.roles.keys(guildId);
    const roles = cache.roles.values(guildId);
    const list = roles.slice(0, 10).map((r) => `• ${r.name} (${r.id})`).join('\n');
    return reply(msg, `**Roles cached (${ids.length}):**\n${list || 'none'}`);
  }

  if (cmd === '!role' && guildId) {
    const targetId = args[0];
    if (!targetId) return reply(msg, 'Usage: `!role <roleId>`');
    const r = cache.roles.get(guildId, targetId);
    if (!r) return reply(msg, 'Role not in cache.');
    return reply(msg, [
      `**${r.name}** (${r.id})`,
      `Color: ${r.color}`,
      `Position: ${r.position}`,
      `Mentionable: ${r.mentionable ? 'yes' : 'no'}`,
    ].join('\n'));
  }

  // ── Message cache ────────────────────────────────────────

  if (cmd === '!msgs') {
    const msgs = cache.messages.channel(msg.channel_id);
    const list = msgs.slice(-5).map((m) => `• [${m.id}] ${m.content.slice(0, 50)}`).join('\n');
    return reply(msg, `**Messages cached in channel (${msgs.length}):**\n${list || 'none'}`);
  }

  if (cmd === '!msg' && args[0]) {
    const m = cache.messages.get(msg.channel_id, args[0]);
    if (!m) return reply(msg, 'Message not in cache.');
    return reply(msg, [
      `**[${m.id}]**`,
      `Author: ${m.author.username}`,
      `Content: ${m.content.slice(0, 100)}`,
      `Timestamp: ${m.timestamp}`,
    ].join('\n'));
  }

  if (cmd === '!msgkeys') {
    const keys = cache.messages.keys(msg.channel_id);
    return reply(msg, `**Message IDs cached (${keys.length}):**\n${keys.slice(-10).join('\n') || 'none'}`);
  }

  if (cmd === '!msgclear') {
    cache.messages.clear(msg.channel_id);
    return reply(msg, 'Channel message cache cleared.');
  }

  // ── Bulk info ────────────────────────────────────────────

  if (cmd === '!cachestats') {
    const guildCount = cache.guilds.keys().length;
    const channelCount = cache.channels.keys().length;
    const userCount = cache.users.keys().length;
    const memberCount = guildId ? cache.members.keys(guildId).length : 0;
    const roleCount = guildId ? cache.roles.keys(guildId).length : 0;

    const lines = [
      '**Cache Stats**',
      `Guilds: ${guildCount}`,
      `Channels: ${channelCount}`,
      `Users: ${userCount}`,
      guildId ? `Members (this guild): ${memberCount}` : null,
      guildId ? `Roles (this guild): ${roleCount}` : null,
      `Ping: ${client.ping}ms`,
    ].filter(Boolean);

    return reply(msg, lines.join('\n'));
  }

  // ── Help ─────────────────────────────────────────────────

  if (cmd === '!cachehelp') {
    return reply(msg, [
      '**Cache Test Commands**',
      '',
      '`!ping` — latency',
      '`!cachestats` — overview of all cached entities',
      '',
      '`!guilds` — list cached guilds',
      '`!guild` — show this guild from cache',
      '`!guildfetch` — force re-fetch guild from API',
      '',
      '`!channels` — list cached channels',
      '`!channel [id]` — show channel from cache',
      '`!channelfetch [id]` — force re-fetch channel from API',
      '',
      '`!users` — list cached users',
      '`!user [id]` — show user from cache',
      '`!userfetch [id]` — force re-fetch user from API',
      '',
      '`!members` — list cached members in guild',
      '`!member [id]` — show member from cache',
      '`!memberfetch [id]` — force re-fetch member from API',
      '',
      '`!roles` — list cached roles',
      '`!role <id>` — show role from cache',
      '',
      '`!msgs` — recent cached messages in channel',
      '`!msg <id>` — show specific cached message',
      '`!msgkeys` — list cached message IDs',
      '`!msgclear` — clear message cache for channel',
    ].join('\n'));
  }
});

client.on('error', (err) => {
  console.error('Client error:', err);
});

client.login().catch((err) => {
  console.error('Failed to login:', err);
  process.exit(1);
});
