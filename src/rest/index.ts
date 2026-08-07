import { REST as DiscordREST, RESTEvents, type RESTOptions as DiscordRESTOptions } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';
import type {
  APIUser,
  APIGuild,
  APIChannel,
  APIMessage,
  APIGuildMember,
  APIGatewaySessionStartLimit,
  RESTPostAPIChannelMessageJSONBody,
  RESTGetAPIChannelMessagesQuery,
  RESTGetAPIGuildMembersQuery,
  RESTPostAPICurrentUserCreateDMChannelResult,
  APIRole,
  APIApplicationCommand,
  RESTGetAPIApplicationCommandsResult,
  RESTPostAPIApplicationCommandsJSONBody,
  RESTPatchAPIApplicationCommandJSONBody,
  RESTPostAPIInteractionCallbackJSONBody,
  RESTPostAPIGuildRoleJSONBody,
  RESTPatchAPIGuildRoleJSONBody,
} from '../types/index.js';

export interface RESTOptions {
  token: string;
  version?: string;
  debug?: boolean;
  globalRequestsPerSecond?: number;
}

export class REST {
  readonly client: DiscordREST;

  constructor(options: RESTOptions) {
    this.client = new DiscordREST({
      version: options.version ?? '10',
      globalRequestsPerSecond: options.globalRequestsPerSecond ?? 50,
    }).setToken(options.token);

    if (options.debug) {
      this.client.on(RESTEvents.Debug, (info) => console.log(`[REST] ${info}`));
    }
  }

  async getChannel(channelId: string): Promise<APIChannel> {
    return this.client.get(Routes.channel(channelId)) as Promise<APIChannel>;
  }

  async getMessages(channelId: string, query?: RESTGetAPIChannelMessagesQuery): Promise<APIMessage[]> {
    const params = new URLSearchParams();
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) params.set(key, String(value));
      }
    }
    return this.client.get(Routes.channelMessages(channelId), { query: params }) as Promise<APIMessage[]>;
  }

  async sendMessage(channelId: string, body: RESTPostAPIChannelMessageJSONBody): Promise<APIMessage> {
    return this.client.post(Routes.channelMessages(channelId), { body }) as Promise<APIMessage>;
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    await this.client.delete(Routes.channelMessage(channelId, messageId));
  }

  async editMessage(channelId: string, messageId: string, body: Partial<RESTPostAPIChannelMessageJSONBody>): Promise<APIMessage> {
    return this.client.patch(Routes.channelMessage(channelId, messageId), { body }) as Promise<APIMessage>;
  }

  async getGuild(guildId: string): Promise<APIGuild> {
    return this.client.get(Routes.guild(guildId)) as Promise<APIGuild>;
  }

  async getGuildChannels(guildId: string): Promise<APIChannel[]> {
    return this.client.get(Routes.guildChannels(guildId)) as Promise<APIChannel[]>;
  }

  async getGuildMembers(guildId: string, query?: RESTGetAPIGuildMembersQuery): Promise<APIGuildMember[]> {
    const params = new URLSearchParams();
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) params.set(key, String(value));
      }
    }
    return this.client.get(Routes.guildMembers(guildId), { query: params }) as Promise<APIGuildMember[]>;
  }

  async getUser(userId: string): Promise<APIUser> {
    return this.client.get(Routes.user(userId)) as Promise<APIUser>;
  }

  async getCurrentUser(): Promise<APIUser> {
    return this.client.get(Routes.user()) as Promise<APIUser>;
  }

  async getGatewayBot(): Promise<{ url: string; shards: number; session_start_limit: APIGatewaySessionStartLimit }> {
    return this.client.get(Routes.gatewayBot()) as Promise<{ url: string; shards: number; session_start_limit: APIGatewaySessionStartLimit }>;
  }

  async createDM(userId: string): Promise<RESTPostAPICurrentUserCreateDMChannelResult> {
    return this.client.post(Routes.userChannels(), { body: { recipient_id: userId } }) as Promise<RESTPostAPICurrentUserCreateDMChannelResult>;
  }

  async createRole(guildId: string, body: RESTPostAPIGuildRoleJSONBody): Promise<APIRole> {
    return this.client.post(Routes.guildRoles(guildId), { body }) as Promise<APIRole>;
  }

  async editRole(guildId: string, roleId: string, body: RESTPatchAPIGuildRoleJSONBody): Promise<APIRole> {
    return this.client.patch(Routes.guildRole(guildId, roleId), { body }) as Promise<APIRole>;
  }

  async deleteRole(guildId: string, roleId: string): Promise<void> {
    await this.client.delete(Routes.guildRole(guildId, roleId));
  }

  async getApplicationCommands(applicationId: string): Promise<RESTGetAPIApplicationCommandsResult> {
    return this.client.get(Routes.applicationCommands(applicationId)) as Promise<RESTGetAPIApplicationCommandsResult>;
  }

  async createApplicationCommand(
    applicationId: string,
    body: RESTPostAPIApplicationCommandsJSONBody,
  ): Promise<APIApplicationCommand> {
    return this.client.post(Routes.applicationCommands(applicationId), { body }) as Promise<APIApplicationCommand>;
  }

  async editApplicationCommand(
    applicationId: string,
    commandId: string,
    body: RESTPatchAPIApplicationCommandJSONBody,
  ): Promise<APIApplicationCommand> {
    return this.client.patch(Routes.applicationCommand(applicationId, commandId), { body }) as Promise<APIApplicationCommand>;
  }

  async deleteApplicationCommand(applicationId: string, commandId: string): Promise<void> {
    await this.client.delete(Routes.applicationCommand(applicationId, commandId));
  }

  async respondToInteraction(
    interactionId: string,
    interactionToken: string,
    body: RESTPostAPIInteractionCallbackJSONBody,
  ): Promise<void> {
    await this.client.post(Routes.interactionCallback(interactionId, interactionToken), { body });
  }

  async fetchEntity(entity: 'guild', id: string): Promise<APIGuild>;
  async fetchEntity(entity: 'channel', id: string): Promise<APIChannel>;
  async fetchEntity(entity: 'user', id: string): Promise<APIUser>;
  async fetchEntity(entity: 'guild' | 'channel' | 'user', id: string): Promise<APIGuild | APIChannel | APIUser> {
    switch (entity) {
      case 'guild': return this.getGuild(id);
      case 'channel': return this.getChannel(id);
      case 'user': return this.getUser(id);
    }
  }

  destroy(): void {}
}

export { DiscordREST, Routes };
export type { DiscordRESTOptions };
