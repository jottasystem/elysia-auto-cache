/**
 * Findings from the first host integration (BeAround controlhub-api, ADR-0079).
 * Docker-free on purpose: these are plugin semantics, not Redis semantics.
 */
import { describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import type { Redis } from 'ioredis';
import { autoCache } from '../src/plugin/auto-cache.js';
import { redisStore } from '../src/redis/redis-store.js';
import type { CacheEnvelope, CacheStore } from '../src/core/types.js';

class MemoryStore implements CacheStore {
  values = new Map<string, CacheEnvelope>();
  generations = new Map<string, number>();
  invalidated: string[][] = [];
  async get(key: string) {
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: CacheEnvelope, ttl: number) {
    if (ttl >= 0) this.values.set(key, value);
  }
  async remove(key: string) {
    this.values.delete(key);
  }
  dropKey = this.remove;
  async getGenerations(scope: string, tags: string[]) {
    return tags.map((t) => this.generations.get(`${scope}|${t}`) ?? 0);
  }
  async invalidateTag(scope: string, tag: string) {
    await this.invalidateTags(scope, [tag]);
  }
  async invalidateTags(scope: string, tags: string[]) {
    this.invalidated.push(tags);
    for (const t of tags) this.generations.set(`${scope}|${t}`, (this.generations.get(`${scope}|${t}`) ?? 0) + 1);
  }
}

const scope = () => 'tenant';
const url = (path: string) => `http://localhost${path}`;

describe('onHit covers every request served a stored response', () => {
  test('a joiner of an in-flight miss fires onHit, so an audit hook sees every reader', async () => {
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const app = new Elysia().use(autoCache({ store: new MemoryStore(), scope })).get(
      '/slow',
      async () => {
        await gate;
        return { ok: true };
      },
      { cache: { ttl: 60, onHit: () => void events.push('hit'), onMiss: () => void events.push('miss') } },
    );

    const leader = app.handle(new Request(url('/slow')));
    await new Promise((r) => setTimeout(r, 10));
    const joiners = [app.handle(new Request(url('/slow'))), app.handle(new Request(url('/slow')))];
    await new Promise((r) => setTimeout(r, 10));
    release();
    const responses = await Promise.all([leader, ...joiners]);

    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(events.sort()).toEqual(['hit', 'hit', 'miss']);
  });
});

describe('an empty tag list from the host is an answer, not "no opinion"', () => {
  test('tags() returning [] never falls back to the path derivation', async () => {
    const store = new MemoryStore();
    const app = new Elysia()
      .use(autoCache({ store, scope, tags: () => [] }))
      .post('/ingest/events', () => ({ ok: true }));
    await app.handle(new Request(url('/ingest/events'), { method: 'POST' }));
    expect(store.invalidated).toEqual([]);
  });

  test('tags() returning undefined still defers to the derivation', async () => {
    const store = new MemoryStore();
    const app = new Elysia()
      .use(autoCache({ store, scope, tags: () => undefined }))
      .post('/campaigns', () => ({ ok: true }));
    await app.handle(new Request(url('/campaigns'), { method: 'POST' }));
    expect(store.invalidated).toEqual([['campaigns']]);
  });
});

describe('a store that throws never fails the request', () => {
  const boom = async () => {
    throw new Error('store down');
  };

  test.each(['getGenerations', 'get', 'set'] as const)('%s throwing still serves the handler', async (method) => {
    const store = new MemoryStore();
    Object.assign(store, { [method]: boom });
    let runs = 0;
    const app = new Elysia().use(autoCache({ store, scope })).get('/r', () => ({ n: ++runs }), { cache: { ttl: 60 } });
    const response = await app.handle(new Request(url('/r')));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ n: 1 });
  });

  test('invalidateTags throwing does not turn a successful write into a failure', async () => {
    const store = new MemoryStore();
    Object.assign(store, { invalidateTags: boom });
    const app = new Elysia().use(autoCache({ store, scope })).post('/campaigns', () => ({ ok: true }));
    expect((await app.handle(new Request(url('/campaigns'), { method: 'POST' }))).status).toBe(200);
  });
});

describe('redisStore: an unreadable generation is a miss, never generation 0', () => {
  const fakeRedis = (exec: () => Promise<unknown>) => ({ pipeline: () => ({ get() {}, exec }) }) as unknown as Redis;

  test('absent key reads 0 and a written one reads its value', async () => {
    const store = redisStore(
      fakeRedis(async () => [
        [null, null],
        [null, '7'],
      ]),
    );
    expect(await store.getGenerations('s', ['a', 'b'])).toEqual([0, 7]);
  });

  test.each([
    ['pipeline rejects', async () => Promise.reject(new Error('down'))],
    [
      'one reply carries an error',
      async () => [
        [null, '3'],
        [new Error('MOVED'), null],
      ],
    ],
    ['exec returns null', async () => null],
    ['value is not an integer', async () => [[null, 'garbage']]],
  ])('%s -> poison, reported to onError', async (_, exec) => {
    const errors: string[] = [];
    const store = redisStore(fakeRedis(exec as () => Promise<unknown>), {
      onError: (_e, operation) => void errors.push(operation),
    });
    const generations = await store.getGenerations('s', ['a']);
    expect(generations.every((g) => g < 0)).toBe(true);
    expect(errors).toEqual(['getGenerations']);
  });

  test('two poisoned reads never produce the same generation', async () => {
    const store = redisStore(fakeRedis(async () => null));
    const [a] = await store.getGenerations('s', ['t']);
    const [b] = await store.getGenerations('s', ['t']);
    expect(a).not.toBe(b);
  });
});
