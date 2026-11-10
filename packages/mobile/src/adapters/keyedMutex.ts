/**
 * A per-key async mutex.
 *
 * `run(keys, fn)` waits until every earlier holder of any of `keys` has
 * finished, then runs `fn` while holding all of them. Locks are claimed
 * synchronously at call time, so operations on a key run strictly in call
 * order (FIFO) and multi-key operations cannot deadlock: every waiter only
 * ever waits on holders that were registered before it.
 *
 * UI code and headless tasks share one JS runtime per process, so this is
 * enough to serialize their reads and writes against the same document.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(keys: readonly string[], fn: () => Promise<T>): Promise<T> {
    const unique = [...new Set(keys)];
    const previous = unique.map(k => this.tails.get(k) ?? Promise.resolve());
    let release!: () => void;
    const done = new Promise<void>(resolve => {
      release = resolve;
    });
    for (const k of unique) this.tails.set(k, done);
    try {
      // `previous` promises only ever resolve (see `finally` below).
      await Promise.all(previous);
      return await fn();
    } finally {
      release();
      for (const k of unique) {
        if (this.tails.get(k) === done) this.tails.delete(k);
      }
    }
  }

  /** Number of keys currently locked or queued (for tests). */
  get size(): number {
    return this.tails.size;
  }
}
