import Redis from 'ioredis';

export interface RedisStoreOptions {
  host?: string;
  port?: number;
  password?: string;
  db?: number;
  prefix?: string;
  defaultTTL?: number | null;
  keySeparator?: string;
  client?: Redis;
}

export class RedisStore {
  private readonly redis: Redis;
  private readonly prefix: string;
  private readonly separator: string;
  private readonly defaultTTL: number | null;
  private readonly ownClient: boolean;

  constructor(options: RedisStoreOptions = {}) {
    this.prefix = options.prefix ?? 'sc:';
    this.separator = options.keySeparator ?? ':';
    this.defaultTTL = options.defaultTTL ?? null;

    if (options.client) {
      this.redis = options.client;
      this.ownClient = false;
    } else {
      this.redis = new Redis({
        host: options.host ?? 'localhost',
        port: options.port ?? 6379,
        password: options.password,
        db: options.db ?? 0,
        lazyConnect: true,
        maxRetriesPerRequest: 3,
      });
      this.ownClient = true;
    }
  }

  private formatKey(...parts: string[]): string {
    return this.prefix + parts.join(this.separator);
  }

  async connect(): Promise<void> {
    if (this.ownClient) {
      await this.redis.connect();
    }
  }

  async get<T>(entity: string, id: string): Promise<T | null> {
    const key = this.formatKey(entity, id);
    const data = await this.redis.get(key);
    if (!data) return null;
    return JSON.parse(data) as T;
  }

  async set(entity: string, id: string, value: unknown, ttl?: number | null): Promise<void> {
    const key = this.formatKey(entity, id);
    const json = JSON.stringify(value);
    const effectiveTTL = ttl !== undefined ? ttl : this.defaultTTL;

    if (effectiveTTL !== null && effectiveTTL > 0) {
      await this.redis.setex(key, effectiveTTL, json);
    } else {
      await this.redis.set(key, json);
    }
  }

  async delete(entity: string, id: string): Promise<void> {
    const key = this.formatKey(entity, id);
    await this.redis.del(key);
  }

  async has(entity: string, id: string): Promise<boolean> {
    const key = this.formatKey(entity, id);
    return (await this.redis.exists(key)) === 1;
  }

  async getMany<T>(entity: string, ids: string[]): Promise<Map<string, T>> {
    if (ids.length === 0) return new Map();

    const keys = ids.map((id) => this.formatKey(entity, id));
    const values = await this.redis.mget(keys);

    const result = new Map<string, T>();
    for (let i = 0; i < ids.length; i++) {
      if (values[i]) {
        result.set(ids[i], JSON.parse(values[i]!) as T);
      }
    }
    return result;
  }

  async setMany(entity: string, entries: Array<{ id: string; value: unknown; ttl?: number | null }>): Promise<void> {
    if (entries.length === 0) return;

    const pipeline = this.redis.pipeline();
    for (const entry of entries) {
      const key = this.formatKey(entity, entry.id);
      const json = JSON.stringify(entry.value);
      const effectiveTTL = entry.ttl !== undefined ? entry.ttl : this.defaultTTL;

      if (effectiveTTL !== null && effectiveTTL > 0) {
        pipeline.setex(key, effectiveTTL, json);
      } else {
        pipeline.set(key, json);
      }
    }
    await pipeline.exec();
  }

  async keys(entity: string): Promise<string[]> {
    const pattern = this.formatKey(entity, '*');
    const keys = await this.scan(pattern);
    const prefixLen = this.prefix.length + entity.length + this.separator.length;
    return keys.map((k) => k.slice(prefixLen));
  }

  async deleteMany(entity: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const keys = ids.map((id) => this.formatKey(entity, id));
    await this.redis.del(...keys);
  }

  async flush(entity?: string): Promise<void> {
    if (entity) {
      await this.deleteMatching(this.formatKey(entity, '*'));
    } else {
      await this.deleteMatching(this.prefix + '*');
    }
  }

  async disconnect(): Promise<void> {
    if (this.ownClient) {
      await this.redis.quit();
    }
  }

  async deleteByPrefix(entity: string, idPrefix: string): Promise<void> {
    await this.deleteMatching(this.formatKey(entity, `${idPrefix}*`));
  }

  private async scan(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, batch] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== '0');
    return keys;
  }

  private async deleteMatching(pattern: string): Promise<void> {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) await this.redis.del(...keys);
    } while (cursor !== '0');
  }
}
