import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Elysia, t } from 'elysia';
import { Redis } from 'ioredis';
import { autoCache } from '../../src/plugin/auto-cache.js';
import { redisStore } from '../../src/redis/redis-store.js';
import type { CacheStore } from '../../src/core/types.js';
import { assertDockerWhenRequired, canRunIntegration } from '../docker-available.js';
import { startValkey, type ValkeyContainer } from '../valkey-container.js';

const BOOT_MS = 120_000;
const tenant = (name = 'biz-1') => ({ headers: { 'x-tenant': name } });

describe.skipIf(!canRunIntegration())('autoCache end to end', () => {
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

  test('a miss runs the handler, a repeat is served from the cache', async () => {
    let runs = 0;
    const app = new Elysia().use(autoCache({ store, scope })).get(
      '/campaigns',
      () => {
        runs++;
        return { items: ['a'], runs };
      },
      { cache: { ttl: 600 } },
    );

    const first = await app.handle(new Request('http://localhost/campaigns', tenant()));
    expect(await first.json()).toEqual({ items: ['a'], runs: 1 });

    const second = await app.handle(new Request('http://localhost/campaigns', tenant()));
    expect(await second.json()).toEqual({ items: ['a'], runs: 1 });
    expect(runs).toBe(1);
  });

  test('a hit still runs the response schema and downstream afterHandle hooks', async () => {
    const app = new Elysia()
      .use(autoCache({ store, scope }))
      .onAfterHandle({ as: 'global' }, ({ set }) => {
        set.headers['x-downstream'] = 'ran';
      })
      .get('/typed', () => ({ name: 'ok' }), {
        cache: { ttl: 600 },
        response: { 200: t.Object({ name: t.String() }) },
      });

    const miss = await app.handle(new Request('http://localhost/typed', tenant()));
    expect(miss.headers.get('x-downstream')).toBe('ran');

    const hit = await app.handle(new Request('http://localhost/typed', tenant()));
    expect(hit.status).toBe(200);
    expect(await hit.json()).toEqual({ name: 'ok' });
    // Proof the short-circuit did not bypass the rest of the lifecycle.
    expect(hit.headers.get('x-downstream')).toBe('ran');
  });

  test('a header set inside the handler is not replayed on a hit', async () => {
    const app = new Elysia().use(autoCache({ store, scope })).get(
      '/hdr',
      ({ set }) => {
        set.headers['x-from-handler'] = 'yes';
        return { ok: true };
      },
      { cache: { ttl: 600 } },
    );

    const miss = await app.handle(new Request('http://localhost/hdr', tenant()));
    expect(miss.headers.get('x-from-handler')).toBe('yes');

    const hit = await app.handle(new Request('http://localhost/hdr', tenant()));
    expect(await hit.json()).toEqual({ ok: true });
    expect(hit.headers.get('x-from-handler')).toBeNull();
  });

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    test(`${method} on the same resource family drops the cached read`, async () => {
      let runs = 0;
      const app = new Elysia()
        .use(autoCache({ store, scope }))
        .get(
          '/campaigns/:id/targets',
          () => {
            runs++;
            return { runs };
          },
          { cache: { ttl: 600 } },
        )
        .post('/campaigns/:id/targets', () => ({ created: true }))
        .put('/campaigns/:id/targets/:targetId', () => ({ replaced: true }))
        .patch('/campaigns/:id/targets/:targetId', () => ({ patched: true }))
        .delete('/campaigns/:id/targets/:targetId', () => ({ removed: true }));

      await app.handle(new Request('http://localhost/campaigns/c1/targets', tenant()));
      await app.handle(new Request('http://localhost/campaigns/c1/targets', tenant()));
      expect(runs).toBe(1);

      const path = method === 'POST' ? '/campaigns/c1/targets' : '/campaigns/c1/targets/t1';
      await app.handle(new Request(`http://localhost${path}`, { method, ...tenant() }));

      await app.handle(new Request('http://localhost/campaigns/c1/targets', tenant()));
      expect(runs).toBe(2);
    });
  }

  test('a mutating route that answers non-2xx invalidates nothing', async () => {
    let runs = 0;
    const app = new Elysia()
      .use(autoCache({ store, scope }))
      .get(
        '/campaigns',
        () => {
          runs++;
          return { runs };
        },
        { cache: { ttl: 600 } },
      )
      .delete('/campaigns/:id', ({ set }) => {
        set.status = 404;
        return { code: 'NOT_FOUND' };
      });

    await app.handle(new Request('http://localhost/campaigns', tenant()));
    await app.handle(new Request('http://localhost/campaigns/missing', { method: 'DELETE', ...tenant() }));
    await app.handle(new Request('http://localhost/campaigns', tenant()));
    expect(runs).toBe(1);
  });

  test('`invalidates` overrides what a write drops', async () => {
    let runs = 0;
    const app = new Elysia()
      .use(autoCache({ store, scope }))
      .get(
        '/reports',
        () => {
          runs++;
          return { runs };
        },
        { cache: { ttl: 600, tags: ['reports'] } },
      )
      .delete('/unrelated/:id', () => ({ ok: true }), { cache: { ttl: -1, invalidates: ['reports'] } });

    await app.handle(new Request('http://localhost/reports', tenant()));
    await app.handle(new Request('http://localhost/reports', tenant()));
    expect(runs).toBe(1);

    await app.handle(new Request('http://localhost/unrelated/9', { method: 'DELETE', ...tenant() }));
    await app.handle(new Request('http://localhost/reports', tenant()));
    expect(runs).toBe(2);
  });

  test('a plugin-level tags resolver replaces the path derivation in both directions', async () => {
    let runs = 0;
    const app = new Elysia()
      .use(autoCache({ store, scope, tags: () => ['everything'] }))
      .get(
        '/a',
        () => {
          runs++;
          return { runs };
        },
        { cache: { ttl: 600 } },
      )
      .post('/completely/unrelated', () => ({ ok: true }));

    await app.handle(new Request('http://localhost/a', tenant()));
    await app.handle(new Request('http://localhost/a', tenant()));
    expect(runs).toBe(1);

    await app.handle(new Request('http://localhost/completely/unrelated', { method: 'POST', ...tenant() }));
    await app.handle(new Request('http://localhost/a', tenant()));
    expect(runs).toBe(2);
  });

  test('bucket collapses a moving timestamp into one key, and the next window splits it', async () => {
    let runs = 0;
    const app = new Elysia().use(autoCache({ store, scope })).get(
      '/metrics',
      () => {
        runs++;
        return { runs };
      },
      { cache: { ttl: 600, bucket: '60s' } },
    );

    const base = 1_767_225_600_000;
    await app.handle(new Request(`http://localhost/metrics?to=${base}`, tenant()));
    await app.handle(new Request(`http://localhost/metrics?to=${base + 1_000}`, tenant()));
    await app.handle(new Request(`http://localhost/metrics?to=${base + 59_000}`, tenant()));
    expect(runs).toBe(1);

    await app.handle(new Request(`http://localhost/metrics?to=${base + 60_000}`, tenant()));
    expect(runs).toBe(2);
  });

  test('an entry really expires', async () => {
    let runs = 0;
    const app = new Elysia().use(autoCache({ store, scope })).get(
      '/short',
      () => {
        runs++;
        return { runs };
      },
      { cache: { ttl: 1 } },
    );

    await app.handle(new Request('http://localhost/short', tenant()));
    await app.handle(new Request('http://localhost/short', tenant()));
    expect(runs).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 1_300));
    await app.handle(new Request('http://localhost/short', tenant()));
    expect(runs).toBe(2);
  }, 15_000);

  test('onHit fires on a hit, onMiss on a genuine miss', async () => {
    const events: string[] = [];
    const app = new Elysia().use(autoCache({ store, scope })).get('/hooked', () => ({ ok: true }), {
      cache: {
        ttl: 600,
        onHit: () => {
          events.push('hit');
        },
        onMiss: () => {
          events.push('miss');
        },
      },
    });

    await app.handle(new Request('http://localhost/hooked', tenant()));
    expect(events).toEqual(['miss']);

    await app.handle(new Request('http://localhost/hooked', tenant()));
    // The reason this hook exists: an audit record must still be written for the
    // second read, or a cache turns a real access into an invisible one.
    expect(events).toEqual(['miss', 'hit']);
  });

  test('a 404 is not cached by default, and is with cacheNotFound', async () => {
    let strictRuns = 0;
    let optedRuns = 0;
    const notFound = (counter: () => void) => (ctx: any) => {
      counter();
      ctx.set.status = 404;
      return { code: 'NOT_FOUND' };
    };

    const app = new Elysia()
      .use(autoCache({ store, scope }))
      .get(
        '/strict',
        notFound(() => strictRuns++),
        { cache: { ttl: 600 } },
      )
      .get(
        '/opted',
        notFound(() => optedRuns++),
        { cache: { ttl: 600, cacheNotFound: true } },
      );

    await app.handle(new Request('http://localhost/strict', tenant()));
    await app.handle(new Request('http://localhost/strict', tenant()));
    expect(strictRuns).toBe(2);

    const first = await app.handle(new Request('http://localhost/opted', tenant()));
    expect(first.status).toBe(404);
    const second = await app.handle(new Request('http://localhost/opted', tenant()));
    expect(second.status).toBe(404);
    expect(optedRuns).toBe(1);
  });

  test('a response that sets a cookie is never cached', async () => {
    let runs = 0;
    const app = new Elysia().use(autoCache({ store, scope })).get(
      '/login-ish',
      ({ set }) => {
        runs++;
        set.headers['set-cookie'] = `sid=${runs}; Path=/`;
        return { ok: true };
      },
      { cache: { ttl: 600 } },
    );

    const a = await app.handle(new Request('http://localhost/login-ish', tenant()));
    const b = await app.handle(new Request('http://localhost/login-ish', tenant()));
    expect(runs).toBe(2);
    expect(a.headers.get('set-cookie')).not.toBe(b.headers.get('set-cookie'));
  });

  test('a streamed response is never cached', async () => {
    let runs = 0;
    const app = new Elysia().use(autoCache({ store, scope })).get(
      '/stream',
      async function* () {
        runs++;
        yield 'chunk-1';
        yield 'chunk-2';
      },
      { cache: { ttl: 600 } },
    );

    await (await app.handle(new Request('http://localhost/stream', tenant()))).text();
    await (await app.handle(new Request('http://localhost/stream', tenant()))).text();
    expect(runs).toBe(2);
  });

  test('the bypass header skips the read but still refreshes the entry', async () => {
    let runs = 0;
    const app = new Elysia().use(autoCache({ store, scope })).get(
      '/bypassable',
      () => {
        runs++;
        return { runs };
      },
      { cache: { ttl: 600 } },
    );

    await app.handle(new Request('http://localhost/bypassable', tenant()));
    expect(runs).toBe(1);

    const bypassed = await app.handle(
      new Request('http://localhost/bypassable', { headers: { 'x-tenant': 'biz-1', 'x-auto-cache-bypass': '1' } }),
    );
    expect(await bypassed.json()).toEqual({ runs: 2 });
    expect(runs).toBe(2);

    // Refreshed, not merely skipped: the next normal read serves the new value.
    const after = await app.handle(new Request('http://localhost/bypassable', tenant()));
    expect(await after.json()).toEqual({ runs: 2 });
    expect(runs).toBe(2);
  });

  test('two tenants never see each other', async () => {
    const app = new Elysia()
      .use(autoCache({ store, scope }))
      .get('/mine', ({ request }) => ({ tenant: request.headers.get('x-tenant') }), { cache: { ttl: 600 } });

    const one = await app.handle(new Request('http://localhost/mine', tenant('biz-1')));
    const two = await app.handle(new Request('http://localhost/mine', tenant('biz-2')));
    expect(await one.json()).toEqual({ tenant: 'biz-1' });
    expect(await two.json()).toEqual({ tenant: 'biz-2' });
  });
});
