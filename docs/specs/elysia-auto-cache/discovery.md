# Discovery — elysia-auto-cache

Written by the spec orchestrator from facts verified directly in this session (source
read, types read, Elysia's compiled output inspected). No later phase needs to sweep any
repository: everything below is a real path with a real line number.

## 1. Reference implementation — `@raphaabreu/nestjs-auto-cache`

Path: `/Users/jotta/Documents/personal-libs/nestjs-auto-cache`. Repo `git@github.com:jottasystem/nestjs-auto-cache.git`. It is a **method-level** cache (a `Proxy` over a service object), not an HTTP cache. Port the mechanisms, not the shape.

| File | What to reuse |
|---|---|
| `src/interfaces.ts:1-5` | `CacheInterface<TValue>` — `get/set/remove`, the whole store contract |
| `src/result-cache.ts:5-18` | `ttl: number \| ((result) => number)`; **negative = do not store, 0 = never expires, positive = seconds** |
| `src/result-cache.ts:79-89` | `calculateTtl` — an errored result defaults to ttl `-1` (not cached) unless a ttl function says otherwise |
| `src/auto-cache.ts:79-85` | `validateTtl` — ttl `0` throws unless `allowInfiniteCaching: true`. Keep this guard |
| `src/with-auto-cache.ts:60` | `upstreamCallCache: Map<string, Promise<any>>` — in-process single-flight, deleted in a `finally` |
| `src/with-auto-cache.ts:32-36` | the `after(result, ...args)` hook, where `result` carries `cached: boolean`. This is the ancestor of `onHit`/`onMiss` |
| `src/with-auto-cache.ts:66-71` | `noCache` / `autoCache` escape hatches |

**Do not port** `after(){ this.for('getData').remove(id) }` (README "Manipulating the cache"): manual invalidation declared on the writer is exactly what tag invalidation replaces.

## 2. Reference store — `@raphaabreu/nestjs-ioredis`

Path: `/Users/jotta/Documents/personal-libs/nestjs-ioredis`. `src/redis-string-cache.ts` is the store template:

- options shape at `:4-16` — `serializer`/`deserializer` (defaults are `flatted`'s `stringify`/`parse`), `keyPrefix`, and three independent error behaviours: `getErrorBehavior: 'throws'|'returnsNull'`, `deserializeErrorBehavior: 'removes'|'ignores'`, `setErrorBehavior: 'throws'|'ignores'`. Defaults at `:18-27` are the fail-open set.
- `get` at `:40-85` — a deserialize failure removes the poisoned key and returns null.
- `set` at `:87-118` — `ttl > 0` uses `SETEX`, otherwise plain `SET` (no expiry).
- `:19` uses `flatted` over `JSON` to survive circular structures. For HTTP response bodies `JSON` is the right default; keep the serializer injectable so `flatted` remains a one-line swap.

## 3. Elysia 1.4.19 — verified against compiled output, not documentation

Inspected in `/Users/jotta/Documents/bearound/bearound-controlhub-api/node_modules/elysia/`.

- **`beforeHandle` short-circuit** (`dist/compose.js:744-790`): when a `beforeHandle` returns a value other than `undefined`, the codegen emits `if(be!==undefined){` and then still runs, in order, **every `afterHandle` hook**, `validator.response`, **every `mapResponse` hook**, `afterResponse`, and cookie encoding. Consequence, and this is load-bearing: serving the cached value as a **plain object** from `beforeHandle` keeps the route's TypeBox `response` schema and all downstream hooks working. Returning a pre-rendered `Response` would bypass them.
- **Macro** (`dist/index.d.ts:1472`, `:1489`, `:1500`): three overloads; the object form takes a record of macro name to config. The lifecycle keys a macro may return are enumerated in `dist/types.d.ts:935-965` — `onParse`, `onTransform`, `onBeforeHandle`, `onAfterHandle`, `onError`, `mapResponse`, `onAfterResponse`. A macro only fires for routes that declare its key, which is why opt-in reads are a macro and automatic invalidation cannot be.
- **Context** (`dist/context.d.ts`): `path` is the URL path as requested (`/id/9`); **`route` is the path as registered on the router** (`/id/:id`). `route` is the stable identity for a cache key and for path-derived tags — never `path`. Also available: `request`, `set` (with `set.status` and `set.headers`), `store`, `server`, `redirect`, `status`.
- Global hooks are registered with `{ as: 'global' }`; a plugin gets a stable identity via `new Elysia({ name: 'auto-cache' })` (dedupe on repeated `.use`).

## 4. Integration test pattern — real Valkey, not a fake

`/Users/jotta/Documents/personal-libs/nestjs-ioredis/test/valkey-container.ts` is the template to mirror:

- `:5` image pinned via `VALKEY_IMAGE`, default `valkey/valkey:9.1`.
- `:22-32` `freePort()` opens an ephemeral listener to claim a port, then closes it.
- `:34-49` `waitFor(check, timeoutMs, what)` polls a predicate and throws with the last error.
- `:14-20` `docker(...)` / `cli(...)` wrap `execFileSync` with `stdio: ['ignore','pipe','pipe']`.
- `:51+` `startValkeyCluster()` boots a single node announcing the host-mapped port, and returns `{ name, host, port, url, version, stop }`.

Jest is configured with `testTimeout: 60000` (`jest.config.js:9`) precisely because container boot is slow.

## 5. Package conventions in the two sibling libs

Both use: `main: lib/index.js`, `types: lib/index.d.ts`, `files: ["lib"]`, scripts `clean`/`build`/`format`/`lint`/`test`/`prepare`/`prepublishOnly`/`preversion`/`version`/`postversion`, prettier `{ printWidth: 120, trailingComma: "all", singleQuote: true }`, and `peerDependencies` for the framework. `nestjs-ioredis` is the newer of the two: ESLint 9 flat config (`eslint.config.mjs`), `engines.node >= 20`, split `tsconfig.json` / `tsconfig.spec.json`.

**One deliberate deviation.** Both siblings compile to CommonJS (`tsconfig.json: "module": "commonjs"`). This library must ship **ESM**: the consumer is `"type": "module"` on Bun, and the package needs subpath exports (`.`, `./core`, `./redis`). Do not copy `module: commonjs`.

## 6. Consumer facts that constrain the design

Target consumer `/Users/jotta/Documents/bearound/bearound-controlhub-api` (branch `origin/v2`): Bun 1.3.14, `elysia@1.4.19`, `ioredis@^5.8.2`.

- Its Redis client is a **single node** — `new Redis(config.redis.endpoint, …)` at `src/services/aws/redis.ts:33`, not `Redis.Cluster`. A multi-key `MGET` of generation keys is therefore safe there, but a generic library must not assume it: cross-slot `MGET` fails on a real cluster. Use a pipeline, or hash-tag the keys, and say which.
- Prior art proving the `onHit` requirement is real: `src/routes/admin/ingest-live.ts:87-95` writes a PII access record **on the cache hit**, with the reason in the comment — a 15s cache must not turn a second read into an invisible one.
- Prior art proving the `bucket` requirement is real: `src/services/analytics/query-engine.ts:1254-1256` documents that a params object carrying `periodEnd = new Date()` mints a fresh key per request, so the entry never hits.
- Existing generic cache-aside, useful as a behavioural reference for fail-open and single-flight: `src/services/analytics/query-cache.ts` — FNV-1a over stable JSON (`:53-70`), `SET NX EX` lock with bounded wait, and every Redis error path degrading to the origin call.

## 7. Constraints for this run

- `/Users/jotta/Documents/personal-libs` is **not** a git repository, and the new directory must not become one. **Never run `git init`** — creating a repository is the owner's decision. Run sequential: no worktrees, no commits.
- Scope is the standalone library only. No file under `/Users/jotta/Documents/bearound` may be created or modified.
- Node-compatible output: no Bun-only APIs (`Bun.env`, `Bun.file`, `bun:test` in shipped code).

## Open questions

1. **Package scope.** The siblings publish as `@raphaabreu/*` while the repos live under the `jottasystem` GitHub org. This spec assumes **`@jottasystem/elysia-auto-cache`**, since it is a new package with no inherited npm name.
2. **Test runner.** The siblings use Jest; the consumer runs Bun. This spec assumes **`bun test`** (the consumer's runtime is what the library must work on), keeping the container helper framework-agnostic so a Jest port stays cheap.
3. **Single-roundtrip read.** A Lua `EVALSHA` that reads generations and value in one call is deliberately **not** in scope until a measurement justifies it; the two-roundtrip path ships first.
