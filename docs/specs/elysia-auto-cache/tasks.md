## Implementation Plan: elysia-auto-cache
**Spec:** docs/specs/elysia-auto-cache/
**Date:** 2026-09-22

Budget exceeded: F4-01 (the mandatory last-wave E2E task) enumerates every scenario in
the feature's own coverage list verbatim (hit/miss, per-verb invalidation, scope,
fail-open, single-flight, bucket, ttl, onHit) rather than drop one to fit 80 words.

**Wave width = 1 throughout.** Constraint from the feature brief: no git repo, so no
worktree isolation and no per-task commit checkpoints are available — the mechanisms
that make >1 concurrent writer safe without collision. Sequential is the named reason,
not a silent default. Every wave below has exactly one task.

### Reuse analysis

| What | Source | Action |
|---|---|---|
| `CacheInterface` get/set/remove contract | `nestjs-auto-cache/src/interfaces.ts:1-5` | adapt — extend with generation methods |
| ttl number-or-function, `calculateTtl` | `nestjs-auto-cache/src/result-cache.ts:5-18,74-84` | adapt — port to `core/ttl.ts` |
| ttl `0` guard (`allowInfiniteCaching`) | `nestjs-auto-cache/src/auto-cache.ts:79-85` | adapt |
| `upstreamCallCache` single-flight, `finally` cleanup, joined-caller skips hooks | `nestjs-auto-cache/src/with-auto-cache.ts:60,86-146` | adapt — port to `core/single-flight.ts` |
| `noCache`/`autoCache` escape hatches | `nestjs-auto-cache/src/with-auto-cache.ts:66-71` | reuse concept — becomes bypass header + `store.invalidateTag`/`dropKey` |
| `RedisStringCache` options + error-behavior branches | `nestjs-ioredis/src/redis-string-cache.ts:4-125` | adapt — port to `redis/redis-store.ts`, swap `flatted` default for `JSON` |
| Valkey container helper | `nestjs-ioredis/test/valkey-container.ts` | reuse — near-verbatim port |
| FNV-1a hashing pattern | `bearound-controlhub-api/.../query-engine.ts` (reference only, out of scope repo) | avoid copying — reimplement a small FNV-1a locally, zero dependency on bearound |
| `after(){ this.for('getData').remove(id) }` manual invalidation | `nestjs-auto-cache` README pattern | avoid — tag invalidation replaces it entirely (discovery §1) |

### Tasks

### Wave 1
- [x] F0-01 — Package scaffold
  - req: REQ-031, REQ-032
  - layer: infra
  - deps: none
  - writes: `package.json`, `tsconfig.json`, `tsconfig.spec.json`, `eslint.config.mjs`, `.prettierrc`, `src/index.ts`, `src/core/index.ts`, `src/redis/index.ts`
  - reuse: `nestjs-ioredis/package.json` — script names, engines, prettier config; deviate on `module: esm` + `exports` map (discovery §5)
  - design: "File-structure plan", "Non-goals & packaging"
  - tests: none (infra)
  - validate: `cd /Users/jotta/Documents/personal-libs/elysia-auto-cache && bun install && bunx tsc --noEmit -p tsconfig.json`
  - cost: m
  - kind: required

### Wave 2
- [x] F1-01 — Core types
  - req: REQ-006, REQ-031
  - layer: core
  - deps: F0-01
  - writes: `src/core/types.ts`
  - reuse: `nestjs-auto-cache/src/interfaces.ts:1-5` — `CacheInterface` shape as the base of `CacheStore`
  - design: "API contracts", "Component design §1"
  - tests: none (types only; proven by compilation)
  - validate: `cd /Users/jotta/Documents/personal-libs/elysia-auto-cache && bunx tsc --noEmit -p tsconfig.json`
  - cost: s
  - kind: required

### Wave 3
- [x] F1-02 — Generation/value key builders + FNV-1a
  - req: REQ-003, REQ-005, REQ-013, REQ-034
  - layer: core
  - deps: F1-01
  - writes: `src/core/fnv1a.ts`, `src/core/cache-key.ts`, `test/cache-key.test.ts`
  - reuse: FNV-1a pattern from bearound `query-engine.ts` (reference only, reimplemented)
  - design: "Data models — Redis key formats"
  - tests: unit — deterministic hash for identical input; differing gen/params change the hash; generated key string contains `{scope}`; key built from `route` not `path`
  - validate: `cd /Users/jotta/Documents/personal-libs/elysia-auto-cache && bun test test/cache-key.test.ts`
  - cost: m
  - kind: required

### Wave 4
- [x] F1-03 — Default route-tag derivation
  - req: REQ-009, REQ-034
  - layer: core
  - deps: F1-01
  - writes: `src/core/route-tags.ts`, `test/route-tags.test.ts`
  - reuse: none — new pure function, path-string only
  - design: "Component design §1"
  - tests: unit — `DELETE /campaigns/:id/targets/:targetId` yields `campaigns/:id/targets` + `campaigns`; 1-static-segment case; 3-static-segment case
  - validate: `cd /Users/jotta/Documents/personal-libs/elysia-auto-cache && bun test test/route-tags.test.ts`
  - cost: s
  - kind: required

### Wave 5
- [x] F1-04 — Bucket normalization
  - req: REQ-016, REQ-017
  - layer: core
  - deps: F1-01
  - writes: `src/core/bucket.ts`, `test/bucket.test.ts`
  - reuse: none — new; motivated by `query-engine.ts:1254-1256` (bearound, reference only)
  - design: "Data models — Redis key formats", "Error handling"
  - tests: unit — two timestamps in the same 60s window normalize identically; next window differs; `bucket: 'nope'` throws
  - validate: `cd /Users/jotta/Documents/personal-libs/elysia-auto-cache && bun test test/bucket.test.ts`
  - cost: m
  - kind: required

### Wave 6
- [x] F1-05 — TTL resolution
  - req: REQ-026, REQ-027
  - layer: core
  - deps: F1-01
  - writes: `src/core/ttl.ts`, `test/ttl.test.ts`
  - reuse: `nestjs-auto-cache/src/result-cache.ts:74-84` `calculateTtl`; `nestjs-auto-cache/src/auto-cache.ts:79-85` `validateTtl` guard — port directly
  - design: "API contracts (`CacheRouteConfig.ttl`)"
  - tests: unit — function ttl; positive number; negative means do-not-store; `0` without `allowInfiniteCaching` throws; `0` with the flag resolves to infinite
  - validate: `cd /Users/jotta/Documents/personal-libs/elysia-auto-cache && bun test test/ttl.test.ts`
  - cost: s
  - kind: required

### Wave 7
- [x] F1-06 — Single-flight map
  - req: REQ-028, REQ-029
  - layer: core
  - deps: F1-01
  - writes: `src/core/single-flight.ts`, `test/single-flight.test.ts`
  - reuse: `nestjs-auto-cache/src/with-auto-cache.ts:60,113-145` — `Map<string, Promise>`, `finally` cleanup, joined caller returns without hooks
  - design: "Data models — read-path diagram"
  - tests: unit — concurrent joins share one leader promise; entry deleted in `finally`; a leader outcome marked non-cacheable releases joiners to run independently
  - validate: `cd /Users/jotta/Documents/personal-libs/elysia-auto-cache && bun test test/single-flight.test.ts`
  - cost: m
  - kind: required

### Wave 8
- [x] F2-01 — Redis store implementation
  - req: REQ-001, REQ-002, REQ-004, REQ-005, REQ-006, REQ-025, REQ-030
  - layer: redis
  - deps: F1-01, F1-02
  - writes: `src/redis/redis-store.ts`, `src/redis/index.ts`
  - reuse: `nestjs-ioredis/src/redis-string-cache.ts:4-125` — options shape, get/set/remove, three error-behavior branches; JSON replaces `flatted` as default (de)serializer
  - design: "API contracts (`RedisStoreOptions`)", "Data models — Redis key formats"
  - tests: none in this task (needs real Redis; proven in F2-03)
  - validate: `cd /Users/jotta/Documents/personal-libs/elysia-auto-cache && bunx tsc --noEmit -p tsconfig.json`
  - cost: l
  - kind: required

### Wave 9
- [x] F2-02 — Docker/Valkey test harness
  - req: REQ-022, REQ-030
  - layer: test-infra
  - deps: F0-01
  - writes: `test/valkey-container.ts`, `test/docker-available.ts`
  - reuse: `nestjs-ioredis/test/valkey-container.ts` — port near-verbatim, already Node-compatible (`child_process`, `net`)
  - design: "Test strategy §5"
  - tests: none (infra; exercised by F2-03/F4-01)
  - validate: `cd /Users/jotta/Documents/personal-libs/elysia-auto-cache && bunx tsc --noEmit -p tsconfig.spec.json`
  - cost: s
  - kind: required

### Wave 10
- [x] F2-03 — Redis store integration tests
  - req: REQ-001, REQ-002, REQ-004, REQ-005, REQ-006, REQ-022, REQ-025, REQ-030
  - layer: redis
  - deps: F2-01, F2-02
  - writes: `test/redis-store.test.ts`
  - design: "Test strategy §5", "Error handling §4"
  - tests: integration — get/set/remove roundtrip; `INCR` generation with no TTL; pipelined multi-tag generation fetch; hash-tag colocation; poisoned value removed + null returned; fail-open when container is stopped; `invalidateTag`/`invalidateTags`/`dropKey` called directly outside a request
  - validate: `cd /Users/jotta/Documents/personal-libs/elysia-auto-cache && bun test test/redis-store.test.ts`
  - cost: l
  - kind: required

### Wave 11
- [x] F3-01 — Bypass helper + plugin skeleton
  - req: REQ-024, REQ-031, REQ-033
  - layer: plugin
  - deps: F1-01
  - writes: `src/plugin/bypass.ts`, `src/plugin/auto-cache.ts`, `test/bypass.test.ts`
  - reuse: `nestjs-auto-cache/src/with-auto-cache.ts:66-71` — escape-hatch concept
  - design: "Component design §1", "API contracts (`AutoCacheOptions`)"
  - tests: unit — default header name `x-auto-cache-bypass`; `bypassHeader` option overrides it; header presence/absence detection
  - validate: `cd /Users/jotta/Documents/personal-libs/elysia-auto-cache && bun test test/bypass.test.ts`
  - cost: s
  - kind: required

### Wave 12
- [x] F3-02 — Global invalidation hook
  - req: REQ-007, REQ-008, REQ-010, REQ-011, REQ-023
  - layer: plugin
  - deps: F3-01, F1-03, F2-01
  - writes: `src/plugin/invalidation.ts`
  - reuse: `src/core/route-tags.ts` (F1-03), `CacheStore.invalidateTags` (F2-01)
  - design: "Component design §1", "Data models — write-path diagram", "Effect on host routes table"
  - tests: none in this task (needs a composed app; proven in F4-01)
  - validate: `cd /Users/jotta/Documents/personal-libs/elysia-auto-cache && bunx tsc --noEmit -p tsconfig.json`
  - cost: m
  - kind: required

### Wave 13
- [x] F3-03 — Cache macro (read path)
  - req: REQ-012, REQ-013, REQ-014, REQ-015, REQ-016, REQ-017, REQ-018, REQ-019, REQ-020, REQ-021, REQ-023, REQ-024, REQ-028, REQ-029, REQ-034, REQ-035
  - layer: plugin
  - deps: F3-01, F1-02, F1-04, F1-05, F1-06, F2-01
  - writes: `src/plugin/cache-macro.ts`
  - reuse: `src/core/{cache-key,bucket,ttl,single-flight}.ts`; control-flow shape of `nestjs-auto-cache/src/with-auto-cache.ts:86-146`
  - design: "Component design §1", "API contracts", "Data models — read-path diagram", "Error handling §4"
  - tests: none in this task (needs a composed app; proven in F4-01)
  - validate: `cd /Users/jotta/Documents/personal-libs/elysia-auto-cache && bunx tsc --noEmit -p tsconfig.json`
  - cost: l
  - kind: required

### Wave 14
- [x] F3-04 — Compose plugin, README, packaging checks
  - req: REQ-004, REQ-031, REQ-032, REQ-033
  - layer: plugin
  - deps: F3-02, F3-03
  - writes: `src/plugin/auto-cache.ts`, `README.md`, `test/packaging.test.ts`
  - design: "Component design §1", "Non-goals & packaging"
  - tests: unit — all three subpaths (`.`, `./core`, `./redis`) resolve; `core/*.ts` source contains no `from 'elysia'`/`from 'ioredis'`; no `Bun.` or `bun:test` substring anywhere under `src/`
  - validate: `cd /Users/jotta/Documents/personal-libs/elysia-auto-cache && bun test test/packaging.test.ts`
  - cost: m
  - kind: required

### Wave 15
- [x] F4-01 — Full E2E coverage
  - req: REQ-006, REQ-007, REQ-008, REQ-009, REQ-010, REQ-011, REQ-012, REQ-013, REQ-014, REQ-015, REQ-016, REQ-017, REQ-018, REQ-019, REQ-020, REQ-021, REQ-022, REQ-023, REQ-024, REQ-025, REQ-028, REQ-029, REQ-033, REQ-034, REQ-035
  - layer: plugin
  - deps: F3-04, F2-02
  - writes: `test/e2e/auto-cache.e2e.test.ts`, `test/e2e/auto-cache.resilience.e2e.test.ts`
  - design: "Test strategy §5", "Data models — read/write-path diagrams", "Effect on host routes table"
  - tests: integration, real Elysia app + real Valkey — (1) hit returns plain object, response schema/afterHandle/mapResponse still run; (2) miss stores then a repeat request hits; (3) tag invalidation after POST/PUT/PATCH/DELETE, each verb, default-derived and `invalidates`-overridden and plugin-`tags`-overridden; (4) non-2xx mutating response does not invalidate; (5) `scope` returning null/undefined never reads or writes; (6) fail-open when the Valkey container is stopped mid-test; (7) 10 concurrent requests to a cold key produce exactly one handler execution (single-flight); (8) repeated `.use()` does not double-invalidate; (9) bucket normalization within/across a 60s window; (10) TTL expiry (short ttl, real wait); (11) `onHit` fires exactly once per hit, `onMiss` once per genuine miss, neither on a joined single-flight request; (12) `cacheNotFound` opt-in caches a 404, default config never does; (13) a response with `Set-Cookie` is never cached; (14) a streaming/SSE response is never cached; (15) a custom response header is not replayed on a hit; (16) bypass header skips the read but still fills the cache
  - validate: `cd /Users/jotta/Documents/personal-libs/elysia-auto-cache && bun test test/e2e/auto-cache.e2e.test.ts test/e2e/auto-cache.resilience.e2e.test.ts`
  - cost: l
  - kind: required
