/**
 * What the leader found. `cacheable: false` is not a failure — it is a response
 * that must not be shared (a Set-Cookie, a stream, a non-2xx), so joiners are
 * released to run the handler themselves rather than receive someone else's.
 */
export type SingleFlightOutcome<T> = { cacheable: true; value: T } | { cacheable: false };

/**
 * In-process dedupe of concurrent misses on one key. Ported from
 * `nestjs-auto-cache`'s `upstreamCallCache`, including the `finally` cleanup —
 * an entry that outlives its promise would pin every later caller to a stale result.
 *
 * In-process on purpose: it removes the thundering herd inside one replica for
 * free, with no round-trip. Cross-replica dedupe is a distributed lock, which
 * costs a round-trip on every miss and is not what this buys.
 */
export class SingleFlight<T> {
  private readonly inflight = new Map<string, Promise<SingleFlightOutcome<T>>>();

  /** The in-flight promise for `key`, or undefined when this caller should lead. */
  join(key: string): Promise<SingleFlightOutcome<T>> | undefined {
    return this.inflight.get(key);
  }

  lead(key: string, work: () => Promise<SingleFlightOutcome<T>>): Promise<SingleFlightOutcome<T>> {
    const running = work().finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, running);
    return running;
  }

  get size(): number {
    return this.inflight.size;
  }
}
