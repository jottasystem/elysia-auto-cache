import type { Cluster, Redis } from 'ioredis';
import { generationKey } from '../core/cache-key.js';
import type { CacheEnvelope, CacheStore } from '../core/types.js';

export interface RedisStoreOptions {
  keyPrefix?: string;
  serializer?: (value: CacheEnvelope) => string;
  deserializer?: (raw: string) => CacheEnvelope;
  getErrorBehavior?: 'throws' | 'returnsNull';
  deserializeErrorBehavior?: 'removes' | 'ignores';
  setErrorBehavior?: 'throws' | 'ignores';
  /** Called with every swallowed error. Wire your logger here; defaults to silence. */
  onError?: (error: unknown, operation: string, key: string) => void;
}

const defaults = {
  keyPrefix: '',
  serializer: JSON.stringify as (value: CacheEnvelope) => string,
  deserializer: JSON.parse as (raw: string) => CacheEnvelope,
  getErrorBehavior: 'returnsNull',
  deserializeErrorBehavior: 'removes',
  setErrorBehavior: 'ignores',
  onError: () => {},
} satisfies Required<RedisStoreOptions>;

let poisonCounter = 0;

/** Negative and unique per call: INCR only ever produces positive generations. */
function poison(count: number): number[] {
  const base = -(Date.now() * 1000 + (poisonCounter++ % 1000));
  return Array.from({ length: count }, () => base);
}

/**
 * `CacheStore` over ioredis. Adapted from `nestjs-ioredis`'s `RedisStringCache`,
 * with `JSON` replacing `flatted` as the default codec — an HTTP response body
 * has already survived being JSON, so nothing here can be circular.
 *
 * The defaults are the fail-open set: a Redis that is down, slow or serving
 * garbage degrades the request to the origin handler and never fails it.
 */
export function redisStore(redis: Redis | Cluster, options: RedisStoreOptions = {}): CacheStore {
  const opts = { ...defaults, ...options };
  const withPrefix = (key: string) => (opts.keyPrefix ? `${opts.keyPrefix}:${key}` : key);

  async function remove(key: string): Promise<void> {
    try {
      await redis.del(withPrefix(key));
    } catch (error) {
      opts.onError(error, 'remove', key);
    }
  }

  return {
    async get(key: string): Promise<CacheEnvelope | null> {
      const fullKey = withPrefix(key);
      let raw: string | null;
      try {
        raw = await redis.get(fullKey);
      } catch (error) {
        opts.onError(error, 'get', key);
        if (opts.getErrorBehavior === 'returnsNull') return null;
        throw error;
      }
      if (raw === null || raw === undefined) return null;

      try {
        return opts.deserializer(raw);
      } catch (error) {
        opts.onError(error, 'deserialize', key);
        // A value we cannot read is worse than no value: it would fail on every
        // later request too, until its TTL ran out. Drop it and take the miss.
        if (opts.deserializeErrorBehavior === 'removes') await remove(key);
        if (opts.getErrorBehavior === 'returnsNull') return null;
        throw error;
      }
    },

    async set(key: string, value: CacheEnvelope, ttl: number): Promise<void> {
      if (ttl < 0) return;
      const fullKey = withPrefix(key);
      let payload: string;
      try {
        payload = opts.serializer(value);
      } catch (error) {
        opts.onError(error, 'serialize', key);
        if (opts.setErrorBehavior === 'ignores') return;
        throw error;
      }
      try {
        if (ttl > 0) await redis.setex(fullKey, ttl, payload);
        else await redis.set(fullKey, payload);
      } catch (error) {
        opts.onError(error, 'set', key);
        if (opts.setErrorBehavior === 'ignores') return;
        throw error;
      }
    },

    remove,
    dropKey: remove,

    /**
     * One pipeline, not N round-trips. Every key is hash-tagged on the scope, so
     * a clustered deployment routes them all to one slot and the pipeline is legal.
     * A tag never invalidated has no key at all, and reads as generation 0.
     *
     * A generation that could NOT be read is never 0. Generation 0 is a real,
     * addressable generation: every entry written before the tag's first
     * invalidation lives there, so answering 0 on an error re-opens entries that
     * were already invalidated. An unreadable generation gets a poison value no
     * write ever produced, the key built from it never exists, and the request is
     * a miss.
     */
    async getGenerations(scope: string, tags: string[]): Promise<number[]> {
      if (tags.length === 0) return [];
      try {
        const pipeline = redis.pipeline();
        for (const tag of tags) pipeline.get(withPrefix(generationKey(scope, tag)));
        const replies = await pipeline.exec();
        if (!replies) {
          opts.onError(new Error('pipeline returned no replies'), 'getGenerations', scope);
          return poison(tags.length);
        }
        const generations: number[] = [];
        for (const [error, value] of replies) {
          const parsed = value === null ? 0 : Number(value);
          if (error || !Number.isSafeInteger(parsed)) {
            opts.onError(error ?? new Error(`unreadable generation ${String(value)}`), 'getGenerations', scope);
            return poison(tags.length);
          }
          generations.push(parsed);
        }
        return generations;
      } catch (error) {
        opts.onError(error, 'getGenerations', scope);
        return poison(tags.length);
      }
    },

    async invalidateTag(scope: string, tag: string): Promise<void> {
      try {
        await redis.incr(withPrefix(generationKey(scope, tag)));
      } catch (error) {
        opts.onError(error, 'invalidateTag', tag);
      }
    },

    async invalidateTags(scope: string, tags: string[]): Promise<void> {
      if (tags.length === 0) return;
      try {
        const pipeline = redis.pipeline();
        for (const tag of tags) pipeline.incr(withPrefix(generationKey(scope, tag)));
        await pipeline.exec();
      } catch (error) {
        opts.onError(error, 'invalidateTags', tags.join(','));
      }
    },
  };
}
