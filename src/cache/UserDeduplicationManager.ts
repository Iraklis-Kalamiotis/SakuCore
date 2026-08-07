import type { APIUser } from '../types/index.js';

export class UserDeduplicationManager {
  private readonly userCache: Map<string, APIUser> = new Map();

  upsert(user: APIUser): APIUser {
    const existing = this.userCache.get(user.id);
    if (existing) {
      Object.assign(existing, user);
      return existing;
    }
    this.userCache.set(user.id, user);
    return user;
  }

  get(id: string): APIUser | undefined {
    return this.userCache.get(id);
  }

  delete(id: string): void {
    this.userCache.delete(id);
  }

  keys(): string[] {
    return Array.from(this.userCache.keys());
  }

  clear(): void {
    this.userCache.clear();
  }
}