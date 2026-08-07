interface CacheEntry<T> {
  value: T;
  createdAt: number;
  expiresAt: number | null;
}

export interface MemoryStoreOptions<T = unknown> {
  maxSize?: number;
  defaultTTL?: number | null;
  sweepInterval?: number;
  onEvict?: (key: string, value: T) => void;
}

export class MemoryStore<T = unknown> {
  private readonly cache = new Map<string, CacheEntry<T>>();
  private readonly maxSize: number;
  private readonly defaultTTL: number | null;
  private readonly onEvict?: (key: string, value: T) => void;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: MemoryStoreOptions<T> = {}) {
    if (options.maxSize !== undefined && (!Number.isFinite(options.maxSize) || options.maxSize < 0) && options.maxSize !== Infinity) {
      throw new RangeError('maxSize must be a non-negative number or Infinity');
    }
    this.maxSize = options.maxSize ?? Infinity;
    this.defaultTTL = options.defaultTTL ?? null;
    this.onEvict = options.onEvict;

    if (options.sweepInterval && options.sweepInterval > 0) {
      this.sweepTimer = setInterval(() => this.sweep(), options.sweepInterval);
    }
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
      this.cache.delete(key);
      this.onEvict?.(key, entry.value);
      return undefined;
    }

    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, ttl?: number | null): void {
    const effectiveTTL = ttl !== undefined ? ttl : this.defaultTTL;

    this.cache.delete(key);
    this.cache.set(key, {
      value,
      createdAt: Date.now(),
      expiresAt: effectiveTTL !== null && effectiveTTL > 0 ? Date.now() + effectiveTTL * 1000 : null,
    });

    this.evict();
  }

  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
      this.cache.delete(key);
      this.onEvict?.(key, entry.value);
      return false;
    }

    this.cache.delete(key);
    this.cache.set(key, entry);
    return true;
  }

  delete(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    this.cache.delete(key);
    this.onEvict?.(key, entry.value);
    return true;
  }

  clear(): void {
    for (const [key, entry] of this.cache) this.onEvict?.(key, entry.value);
    this.cache.clear();
  }

  get size(): number {
    this.sweep();
    return this.cache.size;
  }

  keys(): string[] {
    this.sweep();
    return [...this.cache.keys()];
  }

  values(): T[] {
    const now = Date.now();
    const result: T[] = [];
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt !== null && now >= entry.expiresAt) {
        this.cache.delete(key);
        this.onEvict?.(key, entry.value);
        continue;
      }
      result.push(entry.value);
    }
    return result;
  }

  entries(): Array<[string, T]> {
    const now = Date.now();
    const result: Array<[string, T]> = [];
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt !== null && now >= entry.expiresAt) {
        this.cache.delete(key);
        this.onEvict?.(key, entry.value);
        continue;
      }
      result.push([key, entry.value]);
    }
    return result;
  }

  private evict(): void {
    if (this.cache.size <= this.maxSize) return;

    const iter = this.cache.keys();
    while (this.cache.size > this.maxSize) {
      const next = iter.next();
      if (next.done) break;
      const entry = this.cache.get(next.value);
      this.cache.delete(next.value);
      if (entry) this.onEvict?.(next.value, entry.value);
    }
  }

  sweep(maxAgeSeconds?: number): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      const isExpired = entry.expiresAt !== null && now >= entry.expiresAt;
      const exceedsMaxAge = maxAgeSeconds !== undefined && now - entry.createdAt >= maxAgeSeconds * 1000;
      if (isExpired || exceedsMaxAge) {
        this.cache.delete(key);
        this.onEvict?.(key, entry.value);
      }
    }
  }

  destroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.cache.clear();
  }
}
