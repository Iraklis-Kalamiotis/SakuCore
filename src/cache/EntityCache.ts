import { MemoryStore } from './MemoryStore.js';
import { RedisStore } from './RedisStore.js';
export interface EntityCacheOptions<T> {
  entity: string;
  limit?: number;
  ttl?: number | null;
  fetcher?: (id: string) => Promise<T>;
  onPersistenceError?: (error: unknown) => void;
  onEvict?: (id: string, value: T) => void;
}

export class EntityCache<T extends { id: string }> {
  private readonly mem: MemoryStore<T>;
  private readonly rds: RedisStore | null;
  private readonly ttl: number | null;
  private readonly entity: string;
  private readonly fetcher?: (id: string) => Promise<T>;
  private readonly onPersistenceError?: (error: unknown) => void;

  constructor(rds: RedisStore | null, options: EntityCacheOptions<T>) {
    this.rds = rds;
    this.entity = options.entity;
    this.ttl = options.ttl ?? null;
    this.fetcher = options.fetcher;
    this.onPersistenceError = options.onPersistenceError;
    this.mem = new MemoryStore<T>({
      maxSize: options.limit ?? Infinity,
      defaultTTL: this.ttl,
      onEvict: options.onEvict,
    });
  }

  async fetch(id: string, force = false): Promise<T | null> {
    if (!force) {
      const l1 = this.mem.get(id);
      if (l1) return l1;
      if (this.rds) {
        try {
          const l2 = await this.rds.get<T>(this.entity, id);
          if (l2) {
            this.mem.set(id, l2, this.ttl);
            return l2;
          }
        } catch (error) {
          this.onPersistenceError?.(error);
        }
      }
    }
    if (!this.fetcher) return null;
    try {
      const l3 = await this.fetcher(id);
      this.mem.set(id, l3, this.ttl);
      if (this.rds) await this.rds.set(this.entity, id, l3, this.ttl);
      return l3;
    } catch (error) {
      this.onPersistenceError?.(error);
      return null;
    }
  }

  set(data: T): void {
    const current = this.mem.get(data.id);
    if (current && JSON.stringify(current) === JSON.stringify(data)) return;
    this.mem.set(data.id, data, this.ttl);
    if (this.rds) void this.rds.set(this.entity, data.id, data, this.ttl).catch((error: unknown) => this.onPersistenceError?.(error));
  }

  delete(id: string): void {
    this.mem.delete(id);
    if (this.rds) void this.rds.delete(this.entity, id).catch((error: unknown) => this.onPersistenceError?.(error));
  }

  get(id: string): T | undefined { return this.mem.get(id); }
  keys(): string[] { return this.mem.keys(); }
  values(): T[] { return this.mem.values(); }
  clear(): void { this.mem.clear(); }
  sweep(maxAgeSeconds?: number): void { this.mem.sweep(maxAgeSeconds); }
  destroy(): void { this.mem.destroy(); }
}