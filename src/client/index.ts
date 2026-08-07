import { REST } from '../rest/index.js';
import { GatewayClient } from '../ws/index.js';
import { ShardingManager } from '../sharding/index.js';
import { CacheManager } from '../cache/index.js';
import type { CachedInteraction, CacheManagerOptions } from '../cache/index.js';
import type { ShardingManagerOptions, ShardingStats } from '../sharding/index.js';
import type {
  APIChannel,
  APIGuild,
  APIGuildMember,
  APIMessage,
  APIRole,
  APIUser,
  GatewayGuildCreateDispatchData,
  GatewayGuildMemberAddDispatchData,
  GatewayGuildMembersChunkDispatchData,
  GatewayGuildMemberRemoveDispatchData,
  GatewayGuildRoleCreateDispatchData,
  GatewayGuildRoleDeleteDispatchData,
  GatewayGuildRoleUpdateDispatchData,
  GatewayIntentBits,
  GatewayMessageCreateDispatchData,
  GatewayReadyDispatchData,
} from '../types/index.js';

export type ClientShardingOptions = Omit<ShardingManagerOptions, 'token' | 'intents' | 'rest' | 'debug' | 'onError'>;

export interface ClientOptions {
  token: string;
  intents: GatewayIntentBits[];
  restVersion?: string;
  debug?: boolean;
  cache?: CacheManagerOptions | false;
  /**
   * Enables Discord gateway sharding. `true` uses default settings; an object
   * configures the manager while Client supplies its token, intents, and REST instance.
   */
  sharding?: boolean | ClientShardingOptions;
  onError?: (error: unknown) => void;
}

export interface ClientEvents {
  ready: GatewayReadyDispatchData;
  messageCreate: GatewayMessageCreateDispatchData;
  messageUpdate: Partial<APIMessage> & { id: string; channel_id: string };
  messageDelete: { id: string; channel_id: string };
  guildCreate: GatewayGuildCreateDispatchData;
  guildUpdate: APIGuild;
  guildDelete: { id: string; unavailable?: boolean };
  interactionCreate: CachedInteraction;
  channelCreate: APIChannel;
  channelUpdate: APIChannel;
  channelDelete: APIChannel;
  guildMemberAdd: GatewayGuildMemberAddDispatchData;
  guildMemberUpdate: APIGuildMember & { guild_id: string };
  guildMemberRemove: GatewayGuildMemberRemoveDispatchData;
  guildRoleCreate: GatewayGuildRoleCreateDispatchData;
  guildRoleUpdate: GatewayGuildRoleUpdateDispatchData;
  guildRoleDelete: GatewayGuildRoleDeleteDispatchData;
  error: unknown;
}

type ClientEventName = keyof ClientEvents;
type ClientEventHandler<Event extends ClientEventName> = (data: ClientEvents[Event]) => void;

export class Client {
  readonly rest: REST;
  readonly cache: CacheManager | null;
  /** The active sharding manager, or `null` when using the default single gateway. */
  readonly sharding: ShardingManager | null;
  private readonly gateway: GatewayClient | null;
  private readonly eventHandlers = new Map<ClientEventName, Set<ClientEventHandler<ClientEventName>>>();
  private readonly onError: (error: unknown) => void;
  user: APIUser | null = null;

  constructor(options: ClientOptions) {
    if (!options.token) throw new Error('A Discord token is required');

    this.onError = options.onError ?? ((error) => console.error('[SakuCore]', error));
    this.rest = new REST({ token: options.token, version: options.restVersion, debug: options.debug });
    this.cache = options.cache === false ? null : new CacheManager(options.cache ?? {}, this.rest);
    if (options.sharding) {
      this.gateway = null;
      this.sharding = new ShardingManager({
        ...(typeof options.sharding === 'object' ? options.sharding : {}),
        token: options.token,
        intents: options.intents,
        rest: this.rest,
        debug: options.debug,
        onError: this.onError,
      });
    } else {
      this.sharding = null;
      this.gateway = new GatewayClient({
        token: options.token,
        intents: options.intents,
        rest: this.rest,
        debug: options.debug,
      });
    }
    this.setupGatewayEvents();
  }

  get ping(): number {
    return this.sharding?.getStats().avgLatency ?? this.gateway?.ping ?? -1;
  }

  /** Aggregate shard status, or `null` while the client uses one gateway connection. */
  get shardStatus(): ShardingStats | null {
    return this.sharding?.getStats() ?? null;
  }

  private setupGatewayEvents(): void {
    const on = (event: string, handler: (data: unknown) => void): void => {
      if (this.gateway) {
        this.gateway.on(event, handler);
      } else {
        this.sharding?.on('dispatch', (dispatch) => {
          if (dispatch.t === event) handler(dispatch.d);
        });
      }
    };

    on('READY', (data) => {
      const ready = data as GatewayReadyDispatchData;
      this.user = ready.user;
      this.cache?.cacheUser(ready.user);
      this.emit('ready', ready);
    });

    on('MESSAGE_CREATE', (data) => {
      const message = data as GatewayMessageCreateDispatchData;
      this.cache?.cacheMessage(message as APIMessage & { guild_id?: string; member?: APIGuildMember });
      this.emit('messageCreate', message);
    });
    on('MESSAGE_UPDATE', (data) => {
      const message = data as ClientEvents['messageUpdate'];
      this.cache?.updateMessage(message);
      this.emit('messageUpdate', message);
    });
    on('MESSAGE_DELETE', (data) => {
      const message = data as ClientEvents['messageDelete'];
      this.cache?.deleteMessage(message.channel_id, message.id);
      this.emit('messageDelete', message);
    });

    on('GUILD_CREATE', (data) => {
      const guild = data as GatewayGuildCreateDispatchData;
      this.cache?.cacheGuild(guild as APIGuild & { channels: APIChannel[]; members: APIGuildMember[] });
      this.emit('guildCreate', guild);
    });
    on('GUILD_UPDATE', (data) => {
      const guild = data as APIGuild;
      this.cache?.cacheGuild(guild);
      this.emit('guildUpdate', guild);
    });
    on('GUILD_DELETE', (data) => {
      const guild = data as ClientEvents['guildDelete'];
      this.cache?.deleteGuild(guild.id);
      this.emit('guildDelete', guild);
    });

    on('CHANNEL_CREATE', (data) => this.handleChannel('channelCreate', data as APIChannel));
    on('CHANNEL_UPDATE', (data) => this.handleChannel('channelUpdate', data as APIChannel));
    on('CHANNEL_DELETE', (data) => {
      const channel = data as APIChannel;
      this.cache?.deleteChannel(channel.id);
      this.emit('channelDelete', channel);
    });

    on('GUILD_MEMBER_ADD', (data) => {
      const member = data as GatewayGuildMemberAddDispatchData;
      this.cache?.cacheMember(member.guild_id, member as APIGuildMember);
      this.emit('guildMemberAdd', member);
    });
    on('GUILD_MEMBER_UPDATE', (data) => {
      const member = data as ClientEvents['guildMemberUpdate'];
      this.cache?.cacheMember(member.guild_id, member);
      this.emit('guildMemberUpdate', member);
    });
    on('GUILD_MEMBER_REMOVE', (data) => {
      const member = data as GatewayGuildMemberRemoveDispatchData;
      this.cache?.deleteMember(member.guild_id, member.user.id);
      this.emit('guildMemberRemove', member);
    });
    on('GUILD_MEMBERS_CHUNK', (data) => {
      const chunk = data as GatewayGuildMembersChunkDispatchData;
      this.cache?.cacheMemberChunk(chunk.guild_id, chunk.members);
    });

    on('GUILD_ROLE_CREATE', (data) => {
      const role = data as GatewayGuildRoleCreateDispatchData;
      this.cache?.cacheRole(role.guild_id, role.role);
      this.emit('guildRoleCreate', role);
    });
    on('GUILD_ROLE_UPDATE', (data) => {
      const role = data as GatewayGuildRoleUpdateDispatchData;
      this.cache?.cacheRole(role.guild_id, role.role);
      this.emit('guildRoleUpdate', role);
    });
    on('GUILD_ROLE_DELETE', (data) => {
      const role = data as GatewayGuildRoleDeleteDispatchData;
      this.cache?.deleteRole(role.guild_id, role.role_id);
      this.emit('guildRoleDelete', role);
    });

    on('INTERACTION_CREATE', (data) => {
      const interaction = data as CachedInteraction;
      this.cache?.cacheInteraction(interaction);
      this.emit('interactionCreate', interaction);
    });
    if (this.gateway) {
      this.gateway.on('error', (error) => this.emit('error', error));
    } else {
      this.sharding?.on('shardError', (_shardId, error) => this.emit('error', error));
    }
  }

  on<Event extends ClientEventName>(event: Event, handler: ClientEventHandler<Event>): this {
    const handlers = this.eventHandlers.get(event) ?? new Set<ClientEventHandler<ClientEventName>>();
    handlers.add(handler as ClientEventHandler<ClientEventName>);
    this.eventHandlers.set(event, handlers);
    return this;
  }

  once<Event extends ClientEventName>(event: Event, handler: ClientEventHandler<Event>): this {
    const wrapper: ClientEventHandler<Event> = (data) => {
      this.off(event, wrapper);
      handler(data);
    };
    return this.on(event, wrapper);
  }

  off<Event extends ClientEventName>(event: Event, handler: ClientEventHandler<Event>): this {
    this.eventHandlers.get(event)?.delete(handler as ClientEventHandler<ClientEventName>);
    return this;
  }

  async login(): Promise<void> {
    await this.cache?.connect();
    if (this.sharding) {
      await this.sharding.spawnAll();
    } else {
      await this.gateway?.connect();
    }
  }

  async destroy(): Promise<void> {
    if (this.sharding) {
      await this.sharding.destroyAll();
    } else {
      await this.gateway?.destroy();
    }
    await this.cache?.destroy();
    this.rest.destroy();
  }

  private handleChannel(event: 'channelCreate' | 'channelUpdate', channel: APIChannel): void {
    this.cache?.cacheChannel(channel);
    this.emit(event, channel);
  }

  private emit<Event extends ClientEventName>(event: Event, data: ClientEvents[Event]): void {
    for (const handler of this.eventHandlers.get(event) ?? []) {
      try {
        handler(data);
      } catch (error) {
        if (event === 'error') {
          this.onError(error);
        } else {
          this.reportListenerError(error);
        }
      }
    }
  }

  private reportListenerError(error: unknown): void {
    this.onError(error);
    for (const handler of this.eventHandlers.get('error') ?? []) {
      try {
        handler(error);
      } catch (listenerError) {
        this.onError(listenerError);
      }
    }
  }
}
