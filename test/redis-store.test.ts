import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Redis } from 'ioredis';
import { buildValueKey, generationKey } from '../src/core/cache-key.js';
import { redisStore } from '../src/redis/redis-store.js';
import type { CacheStore } from '../src/core/types.js';
import { assertDockerWhenRequired, canRunIntegration } from './docker-available.js';
import { startValkey, type ValkeyContainer } from './valkey-container.js';

const BOOT_MS = 120_000;

describe.skipIf(!canRunIntegration())('redisStore against a real Valkey', () => {
  let container: ValkeyContainer;
  let redis: Redis;
  let store: CacheStore;

  beforeAll(async () => {
    assertDockerWhenRequired();
    container = await startValkey();
    redis = new Redis(container.url, { maxRetriesPerRequest: 1, commandTimeout: 2_000 });
    redis.on('error', () => {});
    store = redisStore(redis);
  }, BOOT_MS);

  afterAll(async () => {
    await redis?.quit().catch(() => {});
    container?.stop();
  });

  test('round-trips an envelope and removes it', async () => {
    await store.set('k1', { status: 200, body: { ok: true } }, 60);
    expect(await store.get('k1')).toEqual({ status: 200, body: { ok: true } });
    await store.remove('k1');
    expect(await store.get('k1')).toBeNull();
  });

  test('a missing key is a miss, not an error', async () => {
    expect(await store.get('never-written')).toBeNull();
  });

  test('a positive ttl expires the entry, a ttl of 0 does not', async () => {
    await store.set('with-ttl', { status: 200, body: 1 }, 60);
    await store.set('no-ttl', { status: 200, body: 1 }, 0);
    expect(await redis.ttl('with-ttl')).toBeGreaterThan(0);
    expect(await redis.ttl('no-ttl')).toBe(-1);
  });

  test('a negative ttl stores nothing at all', async () => {
    await store.set('never', { status: 200, body: 1 }, -1);
    expect(await store.get('never')).toBeNull();
  });

  test('generations start at 0 and an invalidation is one INCR with no expiry', async () => {
    expect(await store.getGenerations('biz', ['fresh-tag'])).toEqual([0]);
    await store.invalidateTag('biz', 'fresh-tag');
    expect(await store.getGenerations('biz', ['fresh-tag'])).toEqual([1]);
    // No TTL on a generation key: if it expired, every key built against it would
    // become reachable again. -1 is "exists, never expires".
    expect(await redis.ttl(generationKey('biz', 'fresh-tag'))).toBe(-1);
  });

  test('several tags come back in one pipelined read, positionally aligned', async () => {
    await store.invalidateTags('biz', ['a', 'a', 'b']);
    expect(await store.getGenerations('biz', ['a', 'b', 'c'])).toEqual([2, 1, 0]);
  });

  test('no tags means no round-trip', async () => {
    expect(await store.getGenerations('biz', [])).toEqual([]);
  });

  test('a value key and its generation keys carry the same hash tag', async () => {
    const valueKey = buildValueKey({
      scope: 'biz',
      route: '/campaigns',
      tags: ['campaigns'],
      generations: [1],
      params: {},
    });
    const genKey = generationKey('biz', 'campaigns');
    const tagOf = (key: string) => key.slice(key.indexOf('{'), key.indexOf('}') + 1);
    expect(tagOf(valueKey)).toBe('{biz}');
    expect(tagOf(genKey)).toBe('{biz}');

    // Best effort: when the server can compute slots, prove they really collide.
    try {
      const [a, b] = await Promise.all([
        redis.call('CLUSTER', 'KEYSLOT', valueKey),
        redis.call('CLUSTER', 'KEYSLOT', genKey),
      ]);
      expect(a).toBe(b as never);
    } catch {
      // standalone build without CLUSTER support — the hash tag above is the guarantee
    }
  });

  test('a poisoned value is dropped and reported as a miss', async () => {
    await redis.set('poisoned', 'this is not json');
    expect(await store.get('poisoned')).toBeNull();
    expect(await redis.exists('poisoned')).toBe(0);
  });

  test('keyPrefix namespaces both value and generation keys', async () => {
    const prefixed = redisStore(redis, { keyPrefix: 'app' });
    await prefixed.set('pk', { status: 200, body: 'x' }, 60);
    expect(await redis.get('app:pk')).toBeTruthy();
    await prefixed.invalidateTag('biz', 'pref');
    expect(await redis.get(`app:${generationKey('biz', 'pref')}`)).toBe('1');
  });

  test('an injected codec is used for both directions', async () => {
    const calls: string[] = [];
    const custom = redisStore(redis, {
      serializer: (value) => {
        calls.push('ser');
        return JSON.stringify(value);
      },
      deserializer: (raw) => {
        calls.push('de');
        return JSON.parse(raw);
      },
    });
    await custom.set('codec', { status: 201, body: [1, 2] }, 60);
    expect(await custom.get('codec')).toEqual({ status: 201, body: [1, 2] });
    expect(calls).toEqual(['ser', 'de']);
  });

  test('dropKey is remove under a name that reads well from host code', async () => {
    await store.set('escape', { status: 200, body: 1 }, 60);
    await store.dropKey('escape');
    expect(await store.get('escape')).toBeNull();
  });

  test(
    'every operation fails open once Redis is gone',
    async () => {
      const doomed = await startValkey();
      const client = new Redis(doomed.url, {
        maxRetriesPerRequest: 1,
        commandTimeout: 1_000,
        retryStrategy: () => null,
      });
      client.on('error', () => {});
      const failing = redisStore(client);

      await failing.set('before', { status: 200, body: 1 }, 60);
      doomed.stop();

      // Not "throws a nice error" — returns, so the handler runs and the user is served.
      expect(await failing.get('before')).toBeNull();
      expect(await failing.getGenerations('biz', ['x', 'y'])).toEqual([0, 0]);
      await failing.set('after', { status: 200, body: 1 }, 60);
      await failing.invalidateTag('biz', 'x');
      await failing.invalidateTags('biz', ['x', 'y']);
      await failing.remove('before');

      client.disconnect();
    },
    BOOT_MS,
  );

  test('getErrorBehavior: throws surfaces the error instead of degrading', async () => {
    const client = new Redis('redis://127.0.0.1:1', {
      maxRetriesPerRequest: 1,
      commandTimeout: 500,
      retryStrategy: () => null,
      lazyConnect: true,
    });
    client.on('error', () => {});
    const strict = redisStore(client, { getErrorBehavior: 'throws' });
    await expect(strict.get('anything')).rejects.toBeDefined();
    client.disconnect();
  });
});
