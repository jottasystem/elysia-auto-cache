import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const sources = walk(join(root, 'src')).filter((f) => f.endsWith('.ts'));

describe('packaging', () => {
  test('declares the three subpaths, each with types and a default', () => {
    for (const subpath of ['.', './core', './redis']) {
      expect(pkg.exports[subpath]).toBeDefined();
      expect(pkg.exports[subpath].types).toMatch(/^\.\/lib\/.*\.d\.ts$/);
      expect(pkg.exports[subpath].default).toMatch(/^\.\/lib\/.*\.js$/);
    }
  });

  test('ships ESM, not the CommonJS the sibling libraries emit', () => {
    expect(pkg.type).toBe('module');
  });

  test('every subpath resolves and exports its surface', async () => {
    const rootEntry = await import('../src/index.js');
    expect(typeof rootEntry.autoCache).toBe('function');

    const core = await import('../src/core/index.js');
    expect(typeof core.buildValueKey).toBe('function');
    expect(typeof core.deriveRouteTags).toBe('function');
    expect(typeof core.SingleFlight).toBe('function');

    const redis = await import('../src/redis/index.js');
    expect(typeof redis.redisStore).toBe('function');
  });

  test('core never imports elysia or ioredis — that is what makes it reusable', () => {
    for (const file of sources.filter((f) => f.includes('/src/core/'))) {
      const body = readFileSync(file, 'utf8');
      expect(body).not.toMatch(/from ['"]elysia['"]/);
      expect(body).not.toMatch(/from ['"]ioredis['"]/);
    }
  });

  test('redis and elysia are peer dependencies, not bundled ones', () => {
    expect(pkg.peerDependencies.elysia).toBeDefined();
    expect(pkg.peerDependencies.ioredis).toBeDefined();
    expect(pkg.dependencies).toBeUndefined();
  });

  test('nothing shipped depends on Bun to run', () => {
    for (const file of sources) {
      const body = readFileSync(file, 'utf8');
      expect(body).not.toMatch(/\bBun\./);
      expect(body).not.toMatch(/from ['"]bun:/);
    }
  });

  test('relative imports carry the .js extension NodeNext requires', () => {
    for (const file of sources) {
      const body = readFileSync(file, 'utf8');
      for (const match of body.matchAll(/from ['"](\.[^'"]*)['"]/g)) {
        expect(match[1]).toMatch(/\.js$/);
      }
    }
  });
});
