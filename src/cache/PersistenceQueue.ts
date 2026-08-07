/**
 * Serializes asynchronous persistence operations per cache key while allowing
 * unrelated entities to write concurrently.
 */
export class PersistenceQueue {
  private readonly pending = new Map<string, Promise<void>>();

  enqueue(key: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.pending.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.pending.set(key, current);
    void current.then(
      () => this.removeIfCurrent(key, current),
      () => this.removeIfCurrent(key, current),
    );
    return current;
  }

  get size(): number {
    return this.pending.size;
  }

  private removeIfCurrent(key: string, operation: Promise<void>): void {
    if (this.pending.get(key) === operation) this.pending.delete(key);
  }
}
