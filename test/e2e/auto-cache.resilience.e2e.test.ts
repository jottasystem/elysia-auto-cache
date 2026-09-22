import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { Redis } from 'ioredis';
import { autoCache } from '../../src/plugin/auto-cache.js';
import { redisStore } from '../../src/redis/redis-store.js';
import type { CacheStore } from '../../src/core/types.js';
import { assertDockerWhenRequired, canRunIntegration } from '../docker-available.js';
import { startValkey, type ValkeyContainer } from '../valkey-container.js';

const BOOT_MS = 120_000;
const tenant = (name = 'biz-1') => ({ headers: { 'x-tenant': name } });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wraps a store and counts what the plugin actually asked it to do. */
function counting(inner: CacheStore) {
  const calls = { get: 0, set: 0, getGenerations: 0, invalidateTags: 0 };
  const store: CacheStore = {
    get: (k) => (calls.get++, inner.get(k)),
    set: (k, v, t) => (calls.set++, inner.set(k, v, t)),
    remove: (k) => inner.remove(k),
    dropKey: (k) => inner.dropKey(k),
    getGenerations: (s, t) => (calls.getGenerations++, inner.getGenerations(s, t)),
    invalidateTag: (s, t) => inner.invalidateTag(s, t),
    invalidateTags: (s, t) => (calls.invalidateTags++, inner.invalidateTags(s, t)),
  };
  return { store, calls };
}

describe.skipIf(!canRunIntegration())('autoCache resilience', () => {
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

  beforeEach(async () => {
    await redis.flushall();
  });

  const scope = (ctx: any) => (ctx.request.headers.get('x-tenant') as string | null) ?? null;

  test('a null scope touches the store in neither direction', async () => {
    const { store: counted, calls } = counting(store);
    let runs = 0;
    const app = new Elysia()
      .use(autoCache({ store: counted, scope: () => null }))
      .get(
        '/anything',
        () => {
          runs++;
          return { runs };
        },
        { cache: { ttl: 600 } },
      )
      .delete('/anything/:id', () => ({ ok: true }));

    await app.handle(new Request('http://localhost/anything'));
    await app.handle(new Request('http://localhost/anything'));
    await app.handle(new Request('http://localhost/anything/1', { method: 'DELETE' }));

    expect(runs).toBe(2);
    expect(calls).toEqual({ get: 0, set: 0, getGenerations: 0, invalidateTags: 0 });
  });

  test('an undefined scope is treated exactly like null', async () => {
    const { store: counted, calls } = counting(store);
    const app = new Elysia()
      .use(autoCache({ store: counted, scope: () => undefined }))
      .get('/x', () => ({ ok: true }), { cache: { ttl: 600 } });

    await app.handle(new Request('http://localhost/x'));
    expect(calls.get).toBe(0);
    expect(calls.set).toBe(0);
  });

  test('ten concurrent requests on a cold key run the handler once', async () => {
    const { store: counted, calls } = counting(store);
    let runs = 0;
    const app = new Elysia().use(autoCache({ store: counted, scope })).get(
      '/slow',
      async () => {
        runs++;
        await sleep(40);
        return { runs };
      },
      { cache: { ttl: 600 } },
    );

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => app.handle(new Request('http://localhost/slow', tenant()))),
    );
    const bodies = await Promise.all(responses.map((r) => r.json()));

    expect(runs).toBe(1);
    expect(calls.set).toBe(1);
    for (const body of bodies) expect(body).toEqual({ runs: 1 });
  });

  test('joiners run on their own when the leader produced something unshareable', async () => {
    let runs = 0;
    const app = new Elysia().use(autoCache({ store, scope })).get(
      '/cookied',
      async ({ set }) => {
        // Captured BEFORE the await: `runs` is shared, so reading it after the
        // sleep would hand every concurrent caller the same final number and the
        // test would be measuring its own bug instead of the library's behaviour.
        const mine = ++runs;
        await sleep(30);
        set.headers['set-cookie'] = `sid=${mine}; Path=/`;
        return { runs: mine };
      },
      { cache: { ttl: 600 } },
    );

    const responses = await Promise.all(
      Array.from({ length: 4 }, () => app.handle(new Request('http://localhost/cookied', tenant()))),
    );
    const cookies = responses.map((r) => r.headers.get('set-cookie'));

    // Every caller got its OWN cookie — never the leader's.
    expect(runs).toBe(4);
    expect(new Set(cookies).size).toBe(4);
  });

  test('a handler that throws still releases the callers waiting on it', async () => {
    let runs = 0;
    const app = new Elysia().use(autoCache({ store, scope })).get(
      '/boom',
      async () => {
        runs++;
        await sleep(20);
        throw new Error('upstream exploded');
      },
      { cache: { ttl: 600 } },
    );

    const responses = await Promise.all(
      Array.from({ length: 3 }, () => app.handle(new Request('http://localhost/boom', tenant()))),
    );
    for (const response of responses) expect(response.status).toBeGreaterThanOrEqual(500);
    expect(runs).toBeGreaterThanOrEqual(1);
  }, 15_000);

  test('using the plugin twice registers it once, so a write invalidates once', async () => {
    const { store: counted, calls } = counting(store);
    const plugin = autoCache({ store: counted, scope });
    const app = new Elysia().use(plugin).use(plugin).delete('/campaigns/:id', () => ({ ok: true }));

    await app.handle(new Request('http://localhost/campaigns/1', { method: 'DELETE', ...tenant() }));
    expect(calls.invalidateTags).toBe(1);
  });

  test(
    'everything keeps answering once Redis is gone',
    async () => {
      const doomed = await startValkey();
      const client = new Redis(doomed.url, {
        maxRetriesPerRequest: 1,
        commandTimeout: 1_000,
        retryStrategy: () => null,
      });
      client.on('error', () => {});

      let runs = 0;
      const app = new Elysia()
        .use(autoCache({ store: redisStore(client), scope }))
        .get(
          '/survives',
          () => {
            runs++;
            return { runs };
          },
          { cache: { ttl: 600 } },
        )
        .delete('/survives/:id', () => ({ removed: true }));

      const warm = await app.handle(new Request('http://localhost/survives', tenant()));
      expect(warm.status).toBe(200);

      doomed.stop();

      // Reads degrade to the handler...
      const readAfter = await app.handle(new Request('http://localhost/survives', tenant()));
      expect(readAfter.status).toBe(200);
      expect(await readAfter.json()).toEqual({ runs: 2 });

      // ...and a write still succeeds even though its invalidation cannot land.
      const writeAfter = await app.handle(
        new Request('http://localhost/survives/1', { method: 'DELETE', ...tenant() }),
      );
      expect(writeAfter.status).toBe(200);
      expect(await writeAfter.json()).toEqual({ removed: true });

      client.disconnect();
    },
    BOOT_MS,
  );

  test('a bad bucket is refused while the app is being built, not on the first request', () => {
    expect(() =>
      new Elysia().use(autoCache({ store, scope })).get('/bad', () => ({ ok: true }), {
        cache: { ttl: 600, bucket: 'nope' },
      }),
    ).toThrow(/unparsable bucket/);
  });

  test('an infinite ttl is refused unless it was opted into', () => {
    expect(() =>
      new Elysia().use(autoCache({ store, scope })).get('/forever', () => ({ ok: true }), { cache: { ttl: 0 } }),
    ).toThrow(/never expires/);

    expect(() =>
      new Elysia()
        .use(autoCache({ store, scope, allowInfiniteCaching: true }))
        .get('/forever', () => ({ ok: true }), { cache: { ttl: 0 } }),
    ).not.toThrow();
  });

  test('a negative ttl runs the handler every time and stores nothing', async () => {
    const { store: counted, calls } = counting(store);
    let runs = 0;
    const app = new Elysia().use(autoCache({ store: counted, scope })).get(
      '/never-stored',
      () => {
        runs++;
        return { runs };
      },
      { cache: { ttl: -1 } },
    );

    await app.handle(new Request('http://localhost/never-stored', tenant()));
    await app.handle(new Request('http://localhost/never-stored', tenant()));
    expect(runs).toBe(2);
    expect(calls.set).toBe(0);
  });

  test('invalidating a tag by hand drops the cached read', async () => {
    let runs = 0;
    const app = new Elysia().use(autoCache({ store, scope })).get(
      '/manual',
      () => {
        runs++;
        return { runs };
      },
      { cache: { ttl: 600 } },
    );

    await app.handle(new Request('http://localhost/manual', tenant()));
    await app.handle(new Request('http://localhost/manual', tenant()));
    expect(runs).toBe(1);

    await store.invalidateTag('biz-1', 'manual');

    await app.handle(new Request('http://localhost/manual', tenant()));
    expect(runs).toBe(2);
  });
});
