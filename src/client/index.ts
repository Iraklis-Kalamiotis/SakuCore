import { CacheManager } from '../cache/index.js';
import { ErrorManager } from '../core/ErrorManager.js';
import { EventRouter, type EventHandler } from '../events/EventRouter.js';
import { PluginManager, type Plugin } from '../plugins/index.js';
import { REST } from '../rest/index.js';
import { ShardingManager } from '../sharding/index.js';
import { GatewayClient } from '../gateway/index.js';
import type { CachedInteraction, CacheManagerOptions } from '../cache/index.js';
import type { ShardingManagerOptions, ShardingStats } from '../sharding/index.js';
import type {
  APIChannel, APIGuild, APIGuildMember, APIMessage, APIUser,
  GatewayGuildCreateDispatchData, GatewayGuildMemberAddDispatchData,
  GatewayGuildMembersChunkDispatchData, GatewayGuildMemberRemoveDispatchData,
  GatewayGuildRoleCreateDispatchData, GatewayGuildRoleDeleteDispatchData,
  GatewayGuildRoleUpdateDispatchData, GatewayIntentBits,
  GatewayMessageCreateDispatchData, GatewayReadyDispatchData,
} from '../types/index.js';

export type ClientShardingOptions = Omit<ShardingManagerOptions, 'token' | 'intents' | 'rest' | 'debug' | 'onError'>;

export interface ClientOptions {
  token: string;
  intents: GatewayIntentBits[];
  restVersion?: string;
  debug?: boolean;
  cache?: CacheManagerOptions | false;
  sharding?: boolean | ClientShardingOptions;
  plugins?: Plugin<ClientServices, ClientEvents>[];
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
  guildMembersChunk: GatewayGuildMembersChunkDispatchData;
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

export interface ClientServices {
  client: Client;
  rest: REST;
  cache: CacheManager | null;
}

type GatewayDispatch = { t: string | null; d: unknown };
type Lifecycle = 'idle' | 'starting' | 'started' | 'stopping' | 'destroyed';

export class Client {
  readonly rest: REST;
  readonly cache: CacheManager | null;
  readonly sharding: ShardingManager | null;
  readonly plugins: PluginManager<ClientServices, ClientEvents>;
  readonly events: EventRouter<ClientEvents>;
  /** Gateway dispatch router, exposed for extension infrastructure. */
  readonly router: EventRouter<ClientEvents>;
  private readonly gateway: GatewayClient | null;
  private readonly errors: ErrorManager;
  private lifecycle: Lifecycle = 'idle';
  private loginPromise: Promise<void> | null = null;
  private destroyPromise: Promise<void> | null = null;
  user: APIUser | null = null;

  constructor(options: ClientOptions) {
    if (!options.token) throw new Error('A Discord token is required');
    this.rest = new REST({ token: options.token, version: options.restVersion, debug: options.debug });
    this.cache = options.cache === false ? null : new CacheManager(options.cache ?? {}, this.rest);

    let events!: EventRouter<ClientEvents>;
    this.errors = new ErrorManager(
      options.onError ?? ((error) => console.error('[SakuCore]', error)),
      (error) => events.emit('error', error),
    );
    events = new EventRouter<ClientEvents>(this.errors, 'error');
    this.events = events;
    this.router = events;

    if (options.sharding) {
      this.gateway = null;
      this.sharding = new ShardingManager({
        ...(typeof options.sharding === 'object' ? options.sharding : {}),
        token: options.token, intents: options.intents, rest: this.rest,
        debug: options.debug, onError: (error) => this.errors.report(error),
      });
    } else {
      this.sharding = null;
      this.gateway = new GatewayClient({ token: options.token, intents: options.intents, rest: this.rest, debug: options.debug });
    }

    this.plugins = new PluginManager({ services: { client: this, rest: this.rest, cache: this.cache }, events: this.events });
    if (options.plugins) this.plugins.register(...options.plugins);
    this.bindGateway();
    this.registerGatewayRoutes();
  }

  get ping(): number {
    return this.sharding?.getStats().avgLatency ?? this.gateway?.ping ?? -1;
  }

  get shardStatus(): ShardingStats | null {
    return this.sharding?.getStats() ?? null;
  }

  on<Event extends keyof ClientEvents>(event: Event, handler: EventHandler<ClientEvents, Event>): this {
    this.events.on(event, handler);
    return this;
  }

  once<Event extends keyof ClientEvents>(event: Event, handler: EventHandler<ClientEvents, Event>): this {
    this.events.once(event, handler);
    return this;
  }

  off<Event extends keyof ClientEvents>(event: Event, handler: EventHandler<ClientEvents, Event>): this {
    this.events.off(event, handler);
    return this;
  }

  use(...plugins: Plugin<ClientServices, ClientEvents>[]): this {
    this.plugins.register(...plugins);
    return this;
  }

  async login(): Promise<void> {
    if (this.lifecycle === 'started') return;
    if (this.lifecycle === 'starting') return this.loginPromise!;
    if (this.lifecycle === 'stopping' || this.lifecycle === 'destroyed') throw new Error('Cannot login after shutdown has started');
    this.lifecycle = 'starting';
    this.loginPromise = this.start();
    try {
      await this.loginPromise;
      if (this.lifecycle === 'starting') this.lifecycle = 'started';
    } catch (error) {
      if (this.lifecycle === 'starting') this.lifecycle = 'idle';
      throw error;
    } finally {
      this.loginPromise = null;
    }
  }

  async destroy(): Promise<void> {
    if (this.lifecycle === 'destroyed') return;
    if (this.lifecycle === 'stopping') return this.destroyPromise!;
    this.lifecycle = 'stopping';
    this.destroyPromise = this.stop();
    try {
      await this.destroyPromise;
      this.lifecycle = 'destroyed';
    } finally {
      this.destroyPromise = null;
    }
  }

  private async start(): Promise<void> {
    await this.cache?.connect();
    await this.plugins.load();
    if (this.sharding) await this.sharding.spawnAll();
    else await this.gateway!.connect();
    await this.plugins.enable();
  }

  private async stop(): Promise<void> {
    if (this.loginPromise) await this.loginPromise.catch(() => {});
    const results = await Promise.allSettled([
      this.plugins.disable(),
      this.sharding ? this.sharding.destroyAll() : this.gateway!.destroy(),
      this.cache?.destroy() ?? Promise.resolve(),
    ]);
    this.rest.destroy();
    this.events.clear();
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason);
    if (errors.length > 0) throw new AggregateError(errors, 'SakuCore shutdown failed');
  }

  private bindGateway(): void {
    if (this.gateway) {
      this.gateway.on('dispatch', (dispatch) => {
        const payload = dispatch as GatewayDispatch;
        this.events.dispatch(payload.t, payload.d);
      });
      this.gateway.on('error', (error) => this.errors.report(error));
      return;
    }
    this.sharding!.on('dispatch', (dispatch) => this.events.dispatch(dispatch.t, dispatch.d));
    this.sharding!.on('shardError', (_shardId, error) => this.errors.report(error));
  }

  private registerGatewayRoutes(): void {
    this.events.onGateway('READY', (data) => {
      const ready = data as GatewayReadyDispatchData;
      this.user = ready.user;
      this.cache?.cacheUser(ready.user);
      this.events.emit('ready', ready);
    });
    this.events.onGateway('MESSAGE_CREATE', (data) => {
      const message = data as GatewayMessageCreateDispatchData;
      this.cache?.cacheMessage(message as APIMessage & { guild_id?: string; member?: APIGuildMember });
      this.events.emit('messageCreate', message);
    });
    this.events.onGateway('MESSAGE_UPDATE', (data) => {
      const message = data as ClientEvents['messageUpdate'];
      this.cache?.updateMessage(message);
      this.events.emit('messageUpdate', message);
    });
    this.events.onGateway('MESSAGE_DELETE', (data) => {
      const message = data as ClientEvents['messageDelete'];
      this.cache?.deleteMessage(message.channel_id, message.id);
      this.events.emit('messageDelete', message);
    });
    this.events.onGateway('GUILD_CREATE', (data) => {
      const guild = data as GatewayGuildCreateDispatchData;
      this.cache?.cacheGuild(guild as APIGuild & { channels: APIChannel[]; members: APIGuildMember[] });
      this.events.emit('guildCreate', guild);
    });
    this.events.onGateway('GUILD_UPDATE', (data) => {
      const guild = data as APIGuild;
      this.cache?.cacheGuild(guild);
      this.events.emit('guildUpdate', guild);
    });
    this.events.onGateway('GUILD_DELETE', (data) => {
      const guild = data as ClientEvents['guildDelete'];
      if (!guild.unavailable) this.cache?.deleteGuild(guild.id);
      this.events.emit('guildDelete', guild);
    });
    this.channelRoute('CHANNEL_CREATE', 'channelCreate');
    this.channelRoute('CHANNEL_UPDATE', 'channelUpdate');
    this.events.onGateway('CHANNEL_DELETE', (data) => {
      const channel = data as APIChannel;
      this.cache?.deleteChannel(channel.id);
      this.events.emit('channelDelete', channel);
    });
    this.events.onGateway('GUILD_MEMBER_ADD', (data) => {
      const member = data as GatewayGuildMemberAddDispatchData;
      this.cache?.cacheMember(member.guild_id, member as APIGuildMember);
      this.events.emit('guildMemberAdd', member);
    });
    this.events.onGateway('GUILD_MEMBER_UPDATE', (data) => {
      const member = data as ClientEvents['guildMemberUpdate'];
      this.cache?.cacheMember(member.guild_id, member);
      this.events.emit('guildMemberUpdate', member);
    });
    this.events.onGateway('GUILD_MEMBER_REMOVE', (data) => {
      const member = data as GatewayGuildMemberRemoveDispatchData;
      this.cache?.deleteMember(member.guild_id, member.user.id);
      this.events.emit('guildMemberRemove', member);
    });
    this.events.onGateway('GUILD_MEMBERS_CHUNK', (data) => {
      const chunk = data as GatewayGuildMembersChunkDispatchData;
      this.cache?.cacheMemberChunk(chunk.guild_id, chunk.members);
      this.events.emit('guildMembersChunk', chunk);
    });
    this.roleRoute('GUILD_ROLE_CREATE', 'guildRoleCreate');
    this.roleRoute('GUILD_ROLE_UPDATE', 'guildRoleUpdate');
    this.events.onGateway('GUILD_ROLE_DELETE', (data) => {
      const role = data as GatewayGuildRoleDeleteDispatchData;
      this.cache?.deleteRole(role.guild_id, role.role_id);
      this.events.emit('guildRoleDelete', role);
    });
    this.events.onGateway('INTERACTION_CREATE', (data) => {
      const interaction = data as CachedInteraction;
      this.cache?.cacheInteraction(interaction);
      this.events.emit('interactionCreate', interaction);
    });
  }

  private channelRoute(dispatch: string, event: 'channelCreate' | 'channelUpdate'): void {
    this.events.onGateway(dispatch, (data) => {
      const channel = data as APIChannel;
      this.cache?.cacheChannel(channel);
      this.events.emit(event, channel);
    });
  }

  private roleRoute(dispatch: string, event: 'guildRoleCreate' | 'guildRoleUpdate'): void {
    this.events.onGateway(dispatch, (data) => {
      const role = data as GatewayGuildRoleCreateDispatchData | GatewayGuildRoleUpdateDispatchData;
      this.cache?.cacheRole(role.guild_id, role.role);
      this.events.emit(event, role);
    });
  }
}
