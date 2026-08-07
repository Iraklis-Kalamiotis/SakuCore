import 'dotenv/config';
import assert from 'node:assert/strict';
import { Client, GatewayIntentBits } from '../src/index.js';

const guildId = process.env.SAKUCORE_TEST_GUILD_ID;
const channelId = process.env.SAKUCORE_TEST_CHANNEL_ID;
const userId = process.env.SAKUCORE_TEST_USER_ID;
const token = process.env.DISCORD_TOKEN;

if (!token) throw new Error('DISCORD_TOKEN is required for the live integration test');
if (!guildId || !channelId || !userId) {
  throw new Error('SAKUCORE_TEST_GUILD_ID, SAKUCORE_TEST_CHANNEL_ID, and SAKUCORE_TEST_USER_ID are required');
}

async function waitFor<T>(action: () => T | undefined, description: string, timeout = 15_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = action();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

const client = new Client({
  token,
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  cache: {
    limits: {
      messagesPerChannel: 10,
      messagesGlobal: 10,
      membersPerGuild: 100,
      membersGlobal: 100,
      interactions: 10,
    },
  },
});

let messageId: string | undefined;
let directMessageId: string | undefined;
let directMessageChannelId: string | undefined;
let commandId: string | undefined;
let roleId: string | undefined;
let applicationId: string | undefined;
let directMessageGatewaySeen = false;

try {
  await client.login();
  const cache = client.cache;
  assert.ok(cache);
  client.on('messageCreate', (message) => {
    if (message.id === directMessageId) directMessageGatewaySeen = true;
  });

  const [gateway, currentUser, targetUser, guild, channel] = await Promise.all([
    client.rest.getGatewayBot(),
    client.rest.getCurrentUser(),
    client.rest.getUser(userId),
    client.rest.getGuild(guildId),
    client.rest.getChannel(channelId),
  ]);
  assert.ok(gateway.shards >= 1);
  assert.equal(guild.id, guildId);
  assert.equal(channel.id, channelId);
  assert.equal(targetUser.id, userId);
  applicationId = currentUser.id;
  assert.equal((await client.rest.fetchEntity('guild', guildId)).id, guildId);
  assert.equal((await client.rest.fetchEntity('channel', channelId)).id, channelId);
  assert.equal((await client.rest.fetchEntity('user', userId)).id, userId);
  assert.ok((await client.rest.getGuildChannels(guildId)).some((guildChannel) => guildChannel.id === channelId));
  assert.ok((await client.rest.getGuildMembers(guildId, { limit: 100 })).length > 0);

  await waitFor(() => cache.guilds.get(guildId), 'guild cache population');
  await waitFor(() => cache.channels.get(channelId), 'channel cache population');

  const commands = await client.rest.getApplicationCommands(currentUser.id);
  assert.ok(Array.isArray(commands));
  const commandName = `sc-test-${Date.now().toString(36)}`;
  const command = await client.rest.createApplicationCommand(currentUser.id, {
    name: commandName,
    description: 'Temporary SakuCore live integration command',
    type: 1,
  });
  commandId = command.id;
  assert.equal(command.name, commandName);
  const updatedCommand = await client.rest.editApplicationCommand(currentUser.id, command.id, {
    description: 'Temporary SakuCore command updated during live integration',
  });
  assert.equal(updatedCommand.id, command.id);
  await client.rest.deleteApplicationCommand(currentUser.id, command.id);
  commandId = undefined;

  let roleCreated = false;
  let roleUpdated = false;
  let roleDeleted = false;
  client.on('guildRoleCreate', (event) => { if (event.guild_id === guildId) roleCreated = true; });
  client.on('guildRoleUpdate', (event) => { if (event.guild_id === guildId) roleUpdated = true; });
  client.on('guildRoleDelete', (event) => { if (event.guild_id === guildId) roleDeleted = true; });
  const role = await client.rest.createRole(guildId, { name: `SakuCore test ${Date.now()}` });
  roleId = role.id;
  await waitFor(() => cache.roles.get(guildId, role.id), 'GUILD_ROLE_CREATE cache propagation');
  await waitFor(() => roleCreated ? true : undefined, 'GUILD_ROLE_CREATE event');
  const updatedRole = await client.rest.editRole(guildId, role.id, { name: `${role.name} updated` });
  await waitFor(
    () => cache.roles.get(guildId, role.id)?.name === updatedRole.name ? true : undefined,
    'GUILD_ROLE_UPDATE cache propagation',
  );
  await waitFor(() => roleUpdated ? true : undefined, 'GUILD_ROLE_UPDATE event');
  await client.rest.deleteRole(guildId, role.id);
  roleId = undefined;
  await waitFor(() => cache.roles.get(guildId, role.id) === undefined ? true : undefined, 'GUILD_ROLE_DELETE cache eviction');
  await waitFor(() => roleDeleted ? true : undefined, 'GUILD_ROLE_DELETE event');

  const marker = `SakuCore live integration ${Date.now()}`;
  const created = await client.rest.sendMessage(channelId, { content: marker });
  messageId = created.id;
  const cached = await waitFor(
    () => cache.messages.get(channelId, created.id),
    'MESSAGE_CREATE cache propagation',
  );
  assert.equal(cached.content, marker);

  const editedContent = `${marker} edited`;
  await client.rest.editMessage(channelId, created.id, { content: editedContent });
  const edited = await waitFor(
    () => {
      const message = cache.messages.get(channelId, created.id);
      return message?.content === editedContent ? message : undefined;
    },
    'MESSAGE_UPDATE cache propagation',
  );
  assert.equal(edited.content, editedContent);

  await client.rest.deleteMessage(channelId, created.id);
  messageId = undefined;
  await waitFor(
    () => cache.messages.get(channelId, created.id) === undefined ? true : undefined,
    'MESSAGE_DELETE cache eviction',
  );

  const dm = await client.rest.createDM(userId);
  directMessageChannelId = dm.id;
  const directMessage = await client.rest.sendMessage(dm.id, { content: `SakuCore DM integration ${Date.now()}` });
  directMessageId = directMessage.id;
  assert.ok((await client.rest.getMessages(dm.id, { limit: 10 })).some((message) => message.id === directMessage.id));
  const editedDM = await client.rest.editMessage(dm.id, directMessage.id, { content: `${directMessage.content} edited` });
  assert.ok((await client.rest.getMessages(dm.id, { limit: 10 }))
    .some((message) => message.id === editedDM.id && message.content === editedDM.content));
  await client.rest.deleteMessage(dm.id, directMessage.id);
  directMessageId = undefined;
  assert.ok(!(await client.rest.getMessages(dm.id, { limit: 10 })).some((message) => message.id === directMessage.id));

  console.log(
    `Live REST, gateway, cache, command, role, channel, guild, member, and DM checks passed `
    + `(bot-authored DM gateway event received: ${directMessageGatewaySeen})`,
  );
} finally {
  const cleanup: Promise<void>[] = [];
  if (messageId) cleanup.push(client.rest.deleteMessage(channelId, messageId));
  if (directMessageId && directMessageChannelId) {
    cleanup.push(client.rest.deleteMessage(directMessageChannelId, directMessageId));
  }
  if (commandId && applicationId) cleanup.push(client.rest.deleteApplicationCommand(applicationId, commandId));
  if (roleId) cleanup.push(client.rest.deleteRole(guildId, roleId));

  const cleanupResults = await Promise.allSettled(cleanup);
  await client.destroy();
  const cleanupErrors = cleanupResults
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason);
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Live test cleanup failed');
}
