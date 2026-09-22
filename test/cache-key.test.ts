import { describe, expect, test } from 'bun:test';
import { buildValueKey, generationKey, stableStringify } from '../src/core/cache-key.js';

const base = {
  scope: 'biz-1',
  route: '/campaigns/:id/targets',
  tags: ['campaigns/:id/targets', 'campaigns'],
  generations: [3, 7],
  params: { id: 'abc', page: 2 },
};

describe('buildValueKey', () => {
  test('is deterministic for identical input', () => {
    expect(buildValueKey(base)).toBe(buildValueKey({ ...base }));
  });

  test('is insensitive to the order keys were inserted in', () => {
    const reordered = { ...base, params: { page: 2, id: 'abc' } };
    expect(buildValueKey(reordered)).toBe(buildValueKey(base));
  });

  test('changes when any generation changes — this is the whole invalidation mechanism', () => {
    expect(buildValueKey({ ...base, generations: [4, 7] })).not.toBe(buildValueKey(base));
  });

  test('changes when a param changes', () => {
    expect(buildValueKey({ ...base, params: { id: 'abc', page: 3 } })).not.toBe(buildValueKey(base));
  });

  test('wraps the scope in a cluster hash tag', () => {
    expect(buildValueKey(base)).toContain('{biz-1}');
  });

  test('is built from the registered route, so two URLs on one route share a key', () => {
    const key = buildValueKey(base);
    expect(key).toContain('/campaigns/:id/targets');
    expect(key).not.toContain('/campaigns/abc/targets');
  });

  test('separates scopes — the same request for two tenants never collides', () => {
    expect(buildValueKey({ ...base, scope: 'biz-2' })).not.toBe(buildValueKey(base));
  });

  test('tag order in the input does not matter', () => {
    const swapped = { ...base, tags: ['campaigns', 'campaigns/:id/targets'], generations: [7, 3] };
    expect(buildValueKey(swapped)).toBe(buildValueKey(base));
  });
});

describe('generationKey', () => {
  test('is hash-tagged on the scope so it colocates with its value keys', () => {
    expect(generationKey('biz-1', 'campaigns')).toBe('ac:{biz-1}:gen:campaigns');
  });
});

describe('stableStringify', () => {
  test('sorts object keys at every depth', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
});
