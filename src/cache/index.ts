import { EntityCache } from './EntityCache.js';
import { MemoryStore } from './MemoryStore.js';
import { RedisStore } from './RedisStore.js';
import { UserDeduplicationManager } from './UserDeduplicationManager.js';
import type { RedisStoreOptions } from './RedisStore.js';
import type { REST } from '../rest/index.js';
import type { APIGuild, APIChannel, APIMessage, APIGuildMember, APIUser, APIRole } from '../types/index.js';

export interface CacheLimits {
  guilds: number;
  channels: number;
  users: number;
  messages: number;
  members: number;
  roles: number;
  interactions: number;
}

export interface CacheTTL {
  guilds: number | null;
  channels: number | null;
  members: number | null;
  users: number | null;
  roles: number | null;
  messages: number | null;
  interactions: number | null;
}

export interface CacheSweepOptions {
  interval: number;
  lifetime: number;
}

export interface CacheManagerOptions {
  redis?: RedisStoreOptions | null;
  prefix?: string;
  limits?: Partial<CacheLimits>;
  ttl?: Partial<CacheTTL>;
  sweeper?: Partial<Record<keyof CacheTTL | 'guildMembers', CacheSweepOptions>>;
  onError?: (error: unknown) => void;
}

export interface CachedInteraction {
  id: string;
  token?: string;
  guild_id?: string;
  channel_id?: string;
  user?: APIUser;
  member?: APIGuildMember;
}

type GuildSnapshot = APIGuild & {
  channels?: APIChannel[];
  members?: APIGuildMember[];
};

class ScopedEntityCache<T> {
  private readonly stores = new Map<string, MemoryStore<T>>();

  constructor(
    private readonly rds: RedisStore | null,
    private readonly entity: string,
    private readonly limit: number,
    private readonly ttl: number | null,
    private readonly onPersistenceError?: (error: unknown) => void,
  ) {}

  private store(scopeId: string, create = true): MemoryStore<T> | undefined {
    const existing = this.stores.get(scopeId);
    if (existing || !create) return existing;

    const store = new MemoryStore<T>({ maxSize: this.limit, defaultTTL: this.ttl });
    this.stores.set(scopeId, store);
    return store;
  }

  async fetch(scopeId: string, id: string, force = false): Promise<T | null> {
    if (force) return null;

    const local = this.store(scopeId, false)?.get(id);
    if (local) return local;
    if (!this.rds) return null;

    const remote = await this.rds.get<T>(this.entity, `${scopeId}:${id}`);
    if (remote) this.store(scopeId)!.set(id, remote, this.ttl);
    return remote;
  }

  set(scopeId: string, id: string, data: T): void {
    this.store(scopeId)!.set(id, data, this.ttl);
    if (this.rds) {
      void this.rds.set(this.entity, `${scopeId}:${id}`, data, this.ttl)
        .catch((error: unknown) => this.onPersistenceError?.(error));
    }
  }

  delete(scopeId: string, id: string): void {
    const store = this.store(scopeId, false);
    store?.delete(id);
    if (store?.size === 0) this.stores.delete(scopeId);
    if (this.rds) {
      void this.rds.delete(this.entity, `${scopeId}:${id}`)
        .catch((error: unknown) => this.onPersistenceError?.(error));
    }
  }

  get(scopeId: string, id: string): T | undefined {
    return this.store(scopeId, false)?.get(id);
  }

  values(scopeId: string): T[] {
    return this.store(scopeId, false)?.values() ?? [];
  }

  keys(scopeId: string): string[] {
    return this.store(scopeId, false)?.keys() ?? [];
  }

  get size(): number {
    let size = 0;
    for (const [scopeId, store] of this.stores) {
      size += store.size;
      if (store.size === 0) this.stores.delete(scopeId);
    }
    return size;
  }

  get scopeCount(): number {
    return this.stores.size;
  }

  clear(scopeId: string): void {
    this.stores.get(scopeId)?.destroy();
    this.stores.delete(scopeId);
    if (this.rds) {
      void this.rds.deleteByPrefix(this.entity, `${scopeId}:`)
        .catch((error: unknown) => this.onPersistenceError?.(error));
    }
  }

  sweep(maxAgeSeconds?: number): void {
    for (const [scopeId, store] of this.stores) {
      store.sweep(maxAgeSeconds);
      if (store.size === 0) this.stores.delete(scopeId);
    }
  }

  destroy(): void {
    for (const store of this.stores.values()) store.destroy();
    this.stores.clear();
  }
}

type CachedMessage = APIMessage & { guild_id?: string; member?: APIGuildMember };

class MessageCache extends ScopedEntityCache<CachedMessage> {
  add(data: CachedMessage): void {
    this.set(data.channel_id, data.id, data);
  }

  update(data: Partial<APIMessage> & { id: string; channel_id: string }): void {
    const existing = this.get(data.channel_id, data.id);
    if (existing) this.set(data.channel_id, data.id, { ...existing, ...data } as CachedMessage);
  }

  channel(channelId: string, limit?: number): CachedMessage[] {
    const messages = this.values(channelId);
    return limit === undefined ? messages : messages.slice(-limit);
  }
}

export class CacheManager {
  readonly guilds: EntityCache<APIGuild>;
  readonly channels: EntityCache<APIChannel>;
  readonly users: EntityCache<APIUser>;
  readonly members: ScopedEntityCache<APIGuildMember>;
  readonly roles: ScopedEntityCache<APIRole>;
  readonly messages: MessageCache;
  readonly interactions: EntityCache<CachedInteraction>;
  private readonly rds: RedisStore | null;
  private readonly userDeduplicator = new UserDeduplicationManager();
  private readonly guildChannels = new Map<string, Set<string>>();
  private readonly sweepTimers: ReturnType<typeof setInterval>[] = [];

  constructor(options: CacheManagerOptions = {}, rest: REST | null = null) {
    const redisOptions = options.redis
      ? { ...options.redis, prefix: options.prefix ?? options.redis.prefix }
      : null;
    this.rds = redisOptions ? new RedisStore(redisOptions) : null;
    const reportError = options.onError ?? ((error: unknown) => console.error('[SakuCore cache]', error));
    const ttl: CacheTTL = {
      guilds: options.ttl?.guilds ?? null,
      channels: options.ttl?.channels ?? null,
      members: options.ttl?.members ?? 86400,
      users: options.ttl?.users ?? 86400,
      roles: options.ttl?.roles ?? null,
      messages: options.ttl?.messages ?? 3600,
      interactions: options.ttl?.interactions ?? 900,
    };
    const limits: CacheLimits = {
      guilds: options.limits?.guilds ?? 10_000,
      channels: options.limits?.channels ?? 100_000,
      users: options.limits?.users ?? 100_000,
      messages: options.limits?.messages ?? 50,
      members: options.limits?.members ?? 10_000,
      roles: options.limits?.roles ?? 1_000,
      interactions: options.limits?.interactions ?? 100,
    };

    this.guilds = new EntityCache(this.rds, {
      entity: 'guild', limit: limits.guilds, ttl: ttl.guilds, fetcher: rest ? (id) => rest.getGuild(id) : undefined, onPersistenceError: reportError,
    });
    this.channels = new EntityCache(this.rds, {
      entity: 'channel', limit: limits.channels, ttl: ttl.channels, fetcher: rest ? (id) => rest.getChannel(id) : undefined, onPersistenceError: reportError,
    });
    this.users = new EntityCache(this.rds, {
      entity: 'user',
      limit: limits.users,
      ttl: ttl.users,
      fetcher: rest ? (id) => rest.getUser(id) : undefined,
      onPersistenceError: reportError,
      onEvict: (id) => this.userDeduplicator.delete(id),
    });
    this.members = new ScopedEntityCache<APIGuildMember>(this.rds, 'member', limits.members, ttl.members, reportError);
    this.roles = new ScopedEntityCache<APIRole>(this.rds, 'role', limits.roles, ttl.roles, reportError);
    this.messages = new MessageCache(this.rds, 'message', limits.messages, ttl.messages, reportError);
    this.interactions = new EntityCache(this.rds, {
      entity: 'interaction', limit: limits.interactions, ttl: ttl.interactions, onPersistenceError: reportError,
    });

    this.scheduleSweep('guilds', this.guilds, ttl.guilds, options.sweeper?.guilds);
    this.scheduleSweep('channels', this.channels, ttl.channels, options.sweeper?.channels);
    this.scheduleSweep('users', this.users, ttl.users, options.sweeper?.users);
    this.scheduleSweep('guildMembers', this.members, ttl.members, options.sweeper?.guildMembers);
    this.scheduleSweep('roles', this.roles, ttl.roles, options.sweeper?.roles);
    this.scheduleSweep('messages', this.messages, ttl.messages, options.sweeper?.messages);
    this.scheduleSweep('interactions', this.interactions, ttl.interactions, options.sweeper?.interactions);
  }

  cacheGuild(guild: GuildSnapshot): void {
    this.guilds.set(guild);
    for (const channel of guild.channels ?? []) this.cacheChannel(channel);
    for (const member of guild.members ?? []) this.cacheMember(guild.id, member);
    for (const role of guild.roles) this.cacheRole(guild.id, role);
  }

  deleteGuild(guildId: string): void {
    this.guilds.delete(guildId);
    this.members.clear(guildId);
    this.roles.clear(guildId);

    const channelIds = this.guildChannels.get(guildId) ?? new Set(
      this.channels.values().filter((channel) => 'guild_id' in channel && channel.guild_id === guildId).map((channel) => channel.id),
    );
    for (const channelId of channelIds) this.deleteChannel(channelId);
    this.guildChannels.delete(guildId);
  }

  cacheChannel(channel: APIChannel): void {
    this.channels.set(channel);
    if ('guild_id' in channel && channel.guild_id) {
      const ids = this.guildChannels.get(channel.guild_id) ?? new Set<string>();
      ids.add(channel.id);
      this.guildChannels.set(channel.guild_id, ids);
    }
  }

  deleteChannel(channelId: string): void {
    const channel = this.channels.get(channelId);
    this.channels.delete(channelId);
    this.messages.clear(channelId);
    if (channel && 'guild_id' in channel && channel.guild_id) {
      const ids = this.guildChannels.get(channel.guild_id);
      ids?.delete(channelId);
      if (ids?.size === 0) this.guildChannels.delete(channel.guild_id);
    }
  }

  cacheUser(user: APIUser): APIUser {
    const canonical = this.userDeduplicator.upsert(user);
    this.users.set(canonical);
    return canonical;
  }

  cacheMember(guildId: string, member: APIGuildMember): void {
    this.members.set(guildId, member.user.id, { ...member, user: this.cacheUser(member.user) });
  }

  cacheMemberChunk(guildId: string, members: APIGuildMember[]): void {
    for (const member of members) this.cacheMember(guildId, member);
  }

  deleteMember(guildId: string, userId: string): void {
    this.members.delete(guildId, userId);
  }

  cacheRole(guildId: string, role: APIRole): void {
    this.roles.set(guildId, role.id, role);
  }

  deleteRole(guildId: string, roleId: string): void {
    this.roles.delete(guildId, roleId);
  }

  cacheMessage(message: CachedMessage): void {
    const author = this.cacheUser(message.author);
    const member = message.member
      ? { ...message.member, user: author }
      : undefined;
    this.messages.add({ ...message, author, ...(member ? { member } : {}) });
    if (message.guild_id && member) this.cacheMember(message.guild_id, member);
  }

  updateMessage(message: Partial<APIMessage> & { id: string; channel_id: string }): void {
    this.messages.update(message);
  }

  deleteMessage(channelId: string, messageId: string): void {
    this.messages.delete(channelId, messageId);
  }

  cacheInteraction(interaction: CachedInteraction): void {
    const user = interaction.user ?? interaction.member?.user;
    const canonicalUser = user ? this.cacheUser(user) : undefined;
    const member = interaction.member && canonicalUser
      ? { ...interaction.member, user: canonicalUser }
      : interaction.member;
    this.interactions.set({ ...interaction, ...(canonicalUser ? { user: canonicalUser } : {}), ...(member ? { member } : {}) });
    if (interaction.guild_id && member) this.cacheMember(interaction.guild_id, member);
  }

  async connect(): Promise<void> {
    if (this.rds) await this.rds.connect();
  }

  getStats(): {
    guilds: number;
    channels: number;
    users: number;
    members: number;
    memberGuilds: number;
    roles: number;
    roleGuilds: number;
    messages: number;
    messageChannels: number;
    interactions: number;
  } {
    return {
      guilds: this.guilds.keys().length,
      channels: this.channels.keys().length,
      users: this.users.keys().length,
      members: this.members.size,
      memberGuilds: this.members.scopeCount,
      roles: this.roles.size,
      roleGuilds: this.roles.scopeCount,
      messages: this.messages.size,
      messageChannels: this.messages.scopeCount,
      interactions: this.interactions.keys().length,
    };
  }

  async destroy(): Promise<void> {
    for (const timer of this.sweepTimers) clearInterval(timer);
    this.sweepTimers.length = 0;
    this.guilds.destroy();
    this.channels.destroy();
    this.users.destroy();
    this.members.destroy();
    this.roles.destroy();
    this.messages.destroy();
    this.interactions.destroy();
    this.guildChannels.clear();
    this.userDeduplicator.clear();
    if (this.rds) await this.rds.disconnect();
  }

  private scheduleSweep(
    name: string,
    cache: { sweep: (maxAgeSeconds?: number) => void },
    ttl: number | null,
    configured?: CacheSweepOptions,
  ): void {
    const lifetime = configured?.lifetime ?? ttl;
    if (lifetime === null || lifetime === undefined || lifetime <= 0) return;
    const interval = configured?.interval ?? Math.min(lifetime, 60);
    if (interval <= 0) throw new RangeError(`The ${name} sweep interval must be greater than zero`);

    const timer = setInterval(() => cache.sweep(configured?.lifetime), interval * 1000);
    timer.unref();
    this.sweepTimers.push(timer);
  }
}

export { EntityCache };
