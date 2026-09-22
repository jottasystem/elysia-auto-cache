# Design — elysia-auto-cache

**Spec:** docs/specs/elysia-auto-cache/
**Date:** 2026-09-22

## 1. Component design

Three subpaths, three responsibilities. `core` never imports `elysia` or `ioredis`;
`plugin` imports `core` + `elysia`; `redis` imports `core` + `ioredis`.

- **`core`** — pure, framework-free: `CacheStore`/`AutoCacheOptions`/`CacheRouteConfig`
  types (REQ-006,031); default tag derivation from a registered route (REQ-009,034);
  generation-key and value-key builders plus FNV-1a hashing (REQ-001,003,005,013,034);
  bucket duration parsing and value-shape normalization (REQ-016,017); ttl resolution
  (REQ-026,027); an in-process single-flight map (REQ-028,029).
- **`plugin`** — `autoCache(options)` returns `new Elysia({ name: 'auto-cache' })`
  (REQ-033) carrying two wiring pieces: (a) the `cache` **macro** — present only on
  routes that declare it, running `beforeHandle`/`afterHandle` for opt-in reads
  (REQ-012–021,024,035); (b) one **global** `onAfterHandle` hook (`{ as: 'global' }`)
  that fires for every route and invalidates on a 2xx mutating verb (REQ-007–011),
  independent of whether that route declares `cache`.
- **`redis`** — `redisStore(redis, options)` implements `CacheStore` over `ioredis`:
  hash-tagged, no-TTL generation keys with `INCR` (REQ-001,004,005), pipelined
  generation reads (REQ-002,005), `SETEX`/`SET` for values (REQ-004,027), injectable
  (de)serializer and the three ported error behaviors (REQ-030).

Only `plugin` knows about HTTP status, headers, and the Elysia `Context`; `core` and
`redis` operate on the `CacheEnvelope`/`CacheStore` shapes below and never see a
`Request`/`Response`.

## 2. API contracts (public TypeScript surface)

```ts
// core — types.ts
export interface CacheEnvelope<T = unknown> { status: number; body: T }

export interface CacheStore {
  get(key: string): Promise<CacheEnvelope | null>;
  set(key: string, value: CacheEnvelope, ttl: number): Promise<void>;
  remove(key: string): Promise<void>;
  dropKey(key: string): Promise<void>;                 // alias of remove; public escape hatch (REQ-025)
  getGenerations(scope: string, tags: string[]): Promise<number[]>;
  invalidateTag(scope: string, tag: string): Promise<void>;   // single INCR (REQ-001)
  invalidateTags(scope: string, tags: string[]): Promise<void>;
}

export interface RouteInfo { method: string; route: string }   // route = registered path (REQ-034)
export type ScopeFn = (ctx: AutoCacheContext) => string | null | undefined;
export type TagsFn = (route: RouteInfo) => string[];

export interface AutoCacheContext {
  request: Request; route: string; path: string;
  params: Record<string, string>; query: Record<string, string>;
  set: { status?: number | string; headers: Record<string, string> };
  [hostField: string]: unknown;                          // e.g. ctx.auth, injected by the host
}

export interface AutoCacheOptions {
  store: CacheStore;
  scope: ScopeFn;                                         // REQ-023
  tags?: TagsFn;                                           // REQ-011
  bypassHeader?: string;                                   // default 'x-auto-cache-bypass' (REQ-024)
  allowInfiniteCaching?: boolean;                          // default false (REQ-027)
}

export interface CacheRouteConfig<TResult = unknown> {
  ttl: number | ((result: TResult) => number);             // REQ-026
  tags?: string[];                                          // this route's own read-cache tags (override)
  invalidates?: string[];                                   // REQ-010, only meaningful on mutating verbs
  bucket?: string;                                           // 'Ns' | 'Nm' | 'Nh' (REQ-016,017)
  cacheNotFound?: boolean;                                   // default false (REQ-018)
  onHit?: (ctx: AutoCacheContext) => void | Promise<void>;   // REQ-014
  onMiss?: (ctx: AutoCacheContext) => void | Promise<void>;  // REQ-015
}

// plugin — index.ts
export function autoCache(options: AutoCacheOptions): Elysia;
// usage: new Elysia().use(autoCache({...})).get('/x', h, { cache: { ttl: 600 } })

// redis — redis-store.ts
export interface RedisStoreOptions {
  keyPrefix?: string;                                        // default ''
  serializer?: (v: CacheEnvelope) => string;                 // default JSON.stringify
  deserializer?: (s: string) => CacheEnvelope;                // default JSON.parse
  getErrorBehavior?: 'throws' | 'returnsNull';                // default 'returnsNull'
  deserializeErrorBehavior?: 'removes' | 'ignores';           // default 'removes'
  setErrorBehavior?: 'throws' | 'ignores';                    // default 'ignores'
}
export function redisStore(redis: Redis | Cluster, options?: RedisStoreOptions): CacheStore;
```

`CacheRouteConfig` is registered under the Elysia macro name `cache`; a route that omits
it gets no read-through caching but is still subject to the global invalidation hook if
it is a mutating verb (REQ-007 does not require the macro).

### Effect on host routes (substitutes a route table — this library adds no HTTP routes of
its own)

| Trigger | Condition | Library behavior | Reqs |
|---|---|---|---|
| GET/HEAD, `cache` declared | scope resolved, no bypass header, hit | short-circuit in `beforeHandle`: `set.status = envelope.status`, return `envelope.body` (plain object) | REQ-012,013,014,034,035 |
| GET/HEAD, `cache` declared | miss, or bypass header present | handler runs; `afterHandle` captures `{status, body}`, stores if cacheable | REQ-015,018–021,024,028 |
| any verb | `scope()` returns null/undefined | no store call at all, either direction | REQ-023 |
| POST/PUT/PATCH/DELETE | scope resolved, response 2xx | global `onAfterHandle` invalidates derived/overridden tags, awaited | REQ-007–011 |
| POST/PUT/PATCH/DELETE | response not 2xx | no invalidation | REQ-008 |
| any route interaction with the store | Redis error/timeout/not-ready | treated as miss (read side) or silent no-op (invalidate side); handler always runs | REQ-022 |

## 3. Data models — Redis key formats

```
generation key:  {keyPrefix}ac:{<scope>}:gen:<tag>              value: INCR counter, no TTL   (REQ-001,004,005)
value key:       {keyPrefix}ac:{<scope>}:v:<route>:<fnv1a-hex>  value: JSON CacheEnvelope, TTL per route  (REQ-003,013)
```

`<scope>` is wrapped in `{}` so Redis Cluster hashes every key for one tenant to the same
slot (REQ-005). `fnv1a-hex` hashes `JSON.stringify({ route, tags: sortedTagGenPairs,
params: bucketedParams })`, where `sortedTagGenPairs` is `[[tag, generation], ...]`
alpha-sorted by tag so key order never affects the hash, and `bucketedParams` is the
route's `params` + `query` after REQ-016 rounding. Changing any generation changes the
hash, which changes the key — the old key is simply never looked up again (REQ-003).

`CacheEnvelope` is the only thing ever serialized: `{ status: number; body: unknown }`
(REQ-035) — no headers, no `Set-Cookie`, by construction, since those routes are never
written (REQ-019).

### Read path (hit / miss / single-flight join)

```mermaid
sequenceDiagram
  participant C as Client
  participant P as Plugin (beforeHandle)
  participant R as Redis (via CacheStore)
  C->>P: GET /campaigns/:id/targets
  P->>P: scope(ctx); if null/undefined -> run handler, no cache calls
  P->>R: pipeline GET generations for resolved tags
  R-->>P: [gen...] (missing = 0)
  P->>P: build value key (route+tags+gens+bucketed params -> fnv1a)
  P->>R: GET value key
  alt hit
    R-->>P: CacheEnvelope
    P->>P: await onHit(ctx); set.status = envelope.status
    P-->>C: return envelope.body (plain object; afterHandle/response schema still run)
  else miss, no in-flight leader
    P->>P: register Promise in single-flight map
    P-->>C: beforeHandle returns undefined; handler runs
    Note over P: afterHandle captures {status,body}; if cacheable, SET + resolve joiners; await onMiss(ctx)
    P->>P: delete map entry (finally)
  else miss, in-flight leader exists
    P->>P: await leader promise
    alt leader outcome cacheable
      P-->>C: reuse leader's {status,body} (no onHit/onMiss)
    else leader outcome not cacheable
      P-->>C: beforeHandle returns undefined; handler runs independently
    end
  end
```

### Write / invalidation path

```mermaid
sequenceDiagram
  participant C as Client
  participant P as Plugin (onAfterHandle, global)
  participant R as Redis (via CacheStore)
  C->>P: DELETE /campaigns/:id/targets/:targetId
  P->>P: scope(ctx); if null/undefined -> skip entirely
  P->>P: response 2xx? if not -> skip entirely (REQ-008)
  P->>P: resolve tags: route.invalidates override, else plugin tags(), else path-derived (REQ-009-011)
  P->>R: INCR each generation key (awaited, sequential-safe, independent keys)
  R-->>P: ok (or error -> swallowed, fail-open, REQ-022)
  P-->>C: response proceeds (this hook already ran before send; onAfterResponse never used)
```

## 4. Error handling

| Layer | Failure | Behavior | Reqs |
|---|---|---|---|
| redis store | `get` errors/timeout/not-ready | `getErrorBehavior` default `returnsNull` → treated as miss | REQ-022,030 |
| redis store | deserialize throws | `deserializeErrorBehavior` default `removes` → key deleted, then null returned | REQ-030 |
| redis store | `set` errors | `setErrorBehavior` default `ignores` → swallowed; handler response unaffected | REQ-022,030 |
| redis store | `INCR`/invalidate errors | swallowed; mutating response still sent | REQ-022 |
| plugin | `scope()` → null/undefined | short-circuit before any store call, either direction | REQ-023 |
| plugin | `cache.bucket` unparsable | throw at route-registration time, not per-request | REQ-017 |
| plugin | ttl resolves to `0`, `allowInfiniteCaching` unset | throw at route-registration time | REQ-027 |
| plugin | response has `Set-Cookie` / is a stream / non-2xx without `cacheNotFound` | skip storing only; response returned normally | REQ-018–020 |

Fail-open (REQ-022) and fail-closed (REQ-023) never overlap: a null scope never reaches
Redis to begin with, so there is nothing to fail open on for that request.

## 5. Test strategy

- **Unit** (`bun test`, no Docker) — `core`'s pure functions in isolation: route-tag
  derivation (REQ-009,034), key building + FNV-1a determinism (REQ-001,003,013), bucket
  parsing/normalization (REQ-016,017), ttl resolution (REQ-026,027), single-flight map
  mechanics against a fake `CacheStore` (REQ-028,029).
- **Integration** (`bun test`, real Valkey via a ported `startValkeyCluster()`) —
  `redis-store`'s `CacheStore` contract against real Redis, including the three error
  behaviors by forcing a poisoned value or a stopped container (REQ-022,030); a full
  `auto-cache.e2e.test.ts` wiring `autoCache` + `redisStore` into a real `Elysia` app
  covering: hit/miss, per-verb tag invalidation, scope fail-closed, fail-open with the
  container stopped, single-flight under concurrency, bucket normalization, TTL expiry,
  `onHit` firing on a hit, `Set-Cookie`/streaming/non-2xx exclusions. This e2e file is the
  library's equivalent of a user-facing-flow test (no UI exists to drive with Playwright).
- **Docker posture** — `test/docker-available.ts` exports `dockerAvailable()` (a bounded
  `docker info` check); every integration file wraps its suite in
  `describe.skipIf(!dockerAvailable() && !process.env.REQUIRE_DOCKER)` and throws inside
  `beforeAll` when `REQUIRE_DOCKER=1` and Docker is unavailable — a newly designed
  mechanism (Assumption 8 in requirements.md), since the sibling spec file itself has no
  skip/fail branch to copy verbatim.

## 6. File-structure plan

```
elysia-auto-cache/
  package.json                 # name, type:module, exports for ./ ./core ./redis, peerDeps elysia>=1.3 ioredis>=5
  tsconfig.json                # build config, ESM module target
  tsconfig.spec.json           # includes test/, mirrors nestjs-ioredis split
  eslint.config.mjs            # flat config, mirrors nestjs-ioredis
  .prettierrc                  # printWidth 120, trailingComma all, singleQuote true
  README.md                    # usage + the generation-key operational note (REQ-004)
  src/
    index.ts                   # subpath '.'    -> re-exports plugin/auto-cache.ts
    core/
      index.ts                 # subpath './core' -> re-exports the pure primitives below
      types.ts                 # CacheEnvelope, CacheStore, AutoCacheOptions, CacheRouteConfig, ScopeFn, TagsFn, RouteInfo
      route-tags.ts             # default tag derivation from a registered route (REQ-009,034)
      cache-key.ts               # generation-key + value-key builders (REQ-001,003,005,013,034)
      fnv1a.ts                    # tiny non-cryptographic hash
      bucket.ts                    # duration parse + value-shape rounding (REQ-016,017)
      ttl.ts                        # ttl resolution + allowInfiniteCaching guard (REQ-026,027)
      single-flight.ts               # in-process Map<string, Promise<CacheEnvelope|null>> (REQ-028,029)
    plugin/
      auto-cache.ts             # autoCache(options) factory, new Elysia({name:'auto-cache'}) (REQ-033)
      cache-macro.ts             # the `cache` macro: beforeHandle/afterHandle wiring (REQ-012-021,024,035)
      invalidation.ts             # global onAfterHandle: mutating-verb invalidation (REQ-007-011)
      bypass.ts                    # bypass-header check helper (REQ-024)
    redis/
      index.ts                  # subpath './redis' -> re-exports redis-store.ts
      redis-store.ts             # redisStore(redis, options): CacheStore over ioredis (REQ-001,002,004,005,006,025,030)
  test/
    docker-available.ts         # dockerAvailable() + REQUIRE_DOCKER posture helper
    valkey-container.ts          # ported from nestjs-ioredis/test/valkey-container.ts
    route-tags.test.ts            # unit
    cache-key.test.ts              # unit
    bucket.test.ts                  # unit
    ttl.test.ts                      # unit
    single-flight.test.ts             # unit
    bypass.test.ts                     # unit
    redis-store.test.ts                 # integration, real Valkey
    packaging.test.ts                    # unit — subpath resolution, no Bun-only APIs
    e2e/
      auto-cache.e2e.test.ts               # integration, real Elysia app + real Valkey
      auto-cache.resilience.e2e.test.ts     # integration, fail-open/scope/single-flight/dedupe
```

## 7. Non-goals & packaging

REQ-021: `CacheEnvelope` holds exactly one whole response per key; nothing in
`CacheStore`, the macro config, or `redisStore` accepts a fragment/selector — whole-
response caching only, no partial/component caching.

REQ-031/REQ-032: the three subpaths (`.`, `./core`, `./redis`) are independent
`package.json#exports` entries resolving into `lib/index.js`, `lib/core/index.js`,
`lib/redis/index.js`; the TypeScript build target is ESM (`"module": "es2022"`-class
config, deliberately not `commonjs` like the two CommonJS siblings). No file under `src/`
calls a `Bun.*` global or imports `bun:test` — `bun test` is used to *run* the suite
(consumer runtime), but nothing shipped depends on Bun to *execute*.

## 8. Requirement coverage index

| REQ | Design section | REQ | Design section |
|---|---|---|---|
| REQ-001 | §1 redis, §3 key formats | REQ-019 | §2 effect table, §3 CacheEnvelope |
| REQ-002 | §3 read-path diagram | REQ-020 | §4 error handling row 4 |
| REQ-003 | §3 key formats | REQ-021 | §7 |
| REQ-004 | §3 key formats (op. note) | REQ-022 | §4 error handling |
| REQ-005 | §1 redis, §3 key formats | REQ-023 | §2 effect table, §4 |
| REQ-006 | §2 `CacheStore` contract | REQ-024 | §2 effect table |
| REQ-007 | §1 plugin, §3 write-path diagram | REQ-025 | §2 `dropKey`/`invalidateTag(s)` |
| REQ-008 | §3 write-path diagram | REQ-026 | §2 `CacheRouteConfig.ttl` |
| REQ-009 | §1 plugin, §3 write-path diagram | REQ-027 | §4 error handling |
| REQ-010 | §3 write-path diagram | REQ-028 | §1 core, §3 read-path diagram |
| REQ-011 | §3 write-path diagram | REQ-029 | §3 read-path diagram (leader not cacheable) |
| REQ-012 | §2 effect table | REQ-030 | §1 redis, §4 error handling |
| REQ-013 | §2 `AutoCacheContext`, §3 key formats | REQ-031 | §1, §7, §6 file structure |
| REQ-014 | §3 read-path diagram | REQ-032 | §7 |
| REQ-015 | §3 read-path diagram | REQ-033 | §1 plugin |
| REQ-016 | §1 core, §3 bucketedParams | REQ-034 | §2 `RouteInfo.route`, §3 |
| REQ-017 | §1 core, §4 error handling | REQ-035 | §2 `CacheEnvelope`, §3 |
| REQ-018 | §2 effect table, §4 | | |
