# Requirements — elysia-auto-cache

**Spec:** docs/specs/elysia-auto-cache/
**Date:** 2026-09-22
**Mission (narrow, do not widen):** told to cache? it's cached. fetch, update, go. No PII
awareness, no auth rules, no boot-time route-metadata validation. Anything policy-shaped
is a function the host app injects (`scope`, `tags`, `onHit`, `onMiss`).

## A. Generation-counter invalidation & store contract

### REQ-001
The system SHALL identify cache entries using a generation-counter scheme where each tag
maps to an integer generation stored in a Redis key with no TTL, and invalidating a tag
SHALL be a single `INCR` on that key.
- [ ] **Acceptance criteria:** `INCR` is the only write issued to bump a tag; no `SCAN`/`KEYS` command exists
anywhere in the store implementation.

### REQ-002
WHEN a cache read is attempted for a route with resolved tags, the system SHALL fetch the
current generation of every tag before building the value key: one round trip for
generations, then one `GET` for the value (two round trips total).
- [ ] **Acceptance criteria:** for N tags, exactly one pipeline call (not N individual calls, not `MGET`) plus one
`GET` are issued per read attempt.

### REQ-003
The system SHALL compose the value key so it changes deterministically whenever any
relevant tag's generation changes, so a stale value key becomes permanently unreachable
and dies only by its own TTL.
- [ ] **Acceptance criteria:** after `INCR` on a tag, a subsequent read computes a different value key and misses;
the old key is never read again by the library.

### REQ-004
The system's generation keys SHALL be created without an expiry (no `EX`/`PX`/`EXPIRE`).
**Operational note (must also appear in README and design.md, verbatim intent):** because
generation keys carry no TTL, the Redis instance must run a `volatile-*` maxmemory-policy.
Under `allkeys-lru`, a generation key can be evicted while its value keys survive, making an
invalidated entry reachable again — the only path in this design that serves wrong data.
- [ ] **Acceptance criteria:** the store never issues `SETEX`/`EXPIRE`/`PEXPIRE` against a generation key.

### REQ-005
The system SHALL colocate all keys for one scope on the same Redis Cluster hash slot by
embedding the scope inside a hash-tag segment (`{scope}`) of every key, and SHALL fetch
multiple generations via a pipeline rather than a cross-slot `MGET`.
- [ ] **Acceptance criteria:** every generated key string contains `{<scope>}`; the generation-fetch code path
uses `.pipeline()`, never `.mget()`.

### REQ-006
The system SHALL expose a `CacheStore` contract with `get`, `set`, `remove`,
`invalidateTag`, `invalidateTags`, `dropKey`, ported from `CacheInterface`
(`nestjs-auto-cache/src/interfaces.ts:1-5`).
- [ ] **Acceptance criteria:** `./redis`'s store implements all six methods; `./core` declares the interface with
no import of `elysia` or `ioredis`.

## B. Automatic invalidation on mutating verbs

### REQ-007
WHEN a request's method is POST, PUT, PATCH or DELETE and the response status is 2xx, the
system SHALL await invalidation of the route's derived (or overridden) tags inside
`onAfterHandle`, before the response is sent — never in `onAfterResponse`.
- [ ] **Acceptance criteria:** a GET issued immediately after a successful DELETE never observes the pre-delete
value; the invalidation hook is registered on `onAfterHandle`.

### REQ-008
IF the mutating response status is not 2xx, THEN the system SHALL NOT invalidate any tag.
- [ ] **Acceptance criteria:** a 4xx/5xx response from a DELETE leaves every relevant generation counter
unchanged.

### REQ-009
The system SHALL derive default tags from the route's registered path (`route`, never
`path`) by emitting one tag per static path segment: the path truncated through that
segment inclusive of any preceding param segments. Example:
`DELETE /campaigns/:id/targets/:targetId` yields `campaigns/:id/targets` and `campaigns`.
- [ ] **Acceptance criteria:** a unit test on the pure derivation function reproduces this example plus a
one-static-segment and a three-static-segment case.

### REQ-010
WHERE a route declares `cache.invalidates`, the system SHALL use that explicit tag list
instead of the default path-derived tags for that route's invalidation.
- [ ] **Acceptance criteria:** a DELETE route with `invalidates: ['custom']` bumps only `custom`.

### REQ-011
WHERE the plugin option `tags` is provided, the system SHALL call it with the route info
to compute tags for both default read-caching and default invalidation, replacing the
built-in path derivation, unless a per-route override (REQ-010) applies.
- [ ] **Acceptance criteria:** a plugin configured with `tags: () => ['x']` tags every read and invalidation as
`x` unless the route overrides it.

## C. Opt-in reads via Elysia macro

### REQ-012
WHERE a route declares `cache: { ttl }`, the system SHALL register an Elysia macro that
reads from cache in `beforeHandle` and, on a hit, returns the deserialized value as a
plain JavaScript object — never a `Response` instance.
- [ ] **Acceptance criteria:** an integration test with a TypeBox `response` schema on the route observes the
schema, `afterHandle` and `mapResponse` all still executing on a cache hit.

### REQ-013
The system SHALL build the read cache key from the route's registered path, its resolved
scope, its resolved tags' generations, and its (bucket-normalized) request parameters,
combined with an FNV-1a hash.
- [ ] **Acceptance criteria:** two requests with identical route+scope+params hash to the same key; a differing
query value hashes to a different key.

### REQ-034
The system SHALL key the read cache and the invalidation-tag derivation on the Elysia
`route` context value (registered path, e.g. `/id/:id`), never on `path` (requested path,
e.g. `/id/9`).
- [ ] **Acceptance criteria:** requests to `/campaigns/1/targets` and `/campaigns/2/targets` derive identical
tags and identical value-key route component, differing only by hashed params.

## D. onHit / onMiss lifecycle

### REQ-014
WHEN a cache read resolves to a stored value, the system SHALL await the route's `onHit`
callback (if provided) as part of serving the hit.
- [ ] **Acceptance criteria:** a route with `onHit` registered runs it exactly once per hit, never on a miss.

### REQ-015
WHEN a cache read finds no stored value and the origin handler subsequently produces a
cacheable response, the system SHALL await the route's `onMiss` callback (if provided)
exactly once, for the original (non-joined) request only.
- [ ] **Acceptance criteria:** `onMiss` fires once per genuine miss; a request joining an in-flight single-flight
call triggers neither `onHit` nor `onMiss` (mirrors `with-auto-cache.ts:113-119`, where a
joined caller returns without invoking `after()`).

> **Amended 2026-09-22 (first host integration, BeAround ADR-0079).** A joiner now fires
> `onHit`; `onMiss` is unchanged. The ported behavior made the joiner an invisible read: an
> audit hook in `onHit` saw the leader and the later hits, never the second person to open
> the same screen in the same instant. A joiner is served a stored response exactly like a
> hit is, so it gets the hit's side effects. Test: `test/host-integration.test.ts`.
>
> Same amendment, three more findings: an unreadable generation returns a poison value, never
> `0` (generation 0 holds every entry written before the first invalidation); a host `tags()`
> returning `[]` means "no tags" and only `undefined` defers to the path derivation; a store
> that throws is skipped for that request by the plugin itself.

## E. Bucket normalization

### REQ-016
WHERE a route declares `cache.bucket` (e.g. `'60s'`), the system SHALL round every request
value that looks like an ISO-8601 datetime or a Unix timestamp (ms or s) down to the
nearest bucket boundary before it is folded into the key hash.
- [ ] **Acceptance criteria:** two requests one second apart with `to: Date.now()`, inside the same 60s window,
produce the same cache key; a request in the next window produces a different key.

### REQ-017
The system SHALL parse `cache.bucket` as a duration string (`Ns`, `Nm`, `Nh`) and throw at
route-registration time on an unparsable value.
- [ ] **Acceptance criteria:** `bucket: 'nope'` throws while the plugin builds the macro for that route.

## F. Cacheability rules

### REQ-018
The system SHALL store a read response only when its status is 2xx, or when its status is
404 and the route declares `cache.cacheNotFound: true`.
- [ ] **Acceptance criteria:** default config never stores a 404; `cacheNotFound: true` stores and later serves a
404 plain object; a 500 is never stored regardless of config.

### REQ-019
The system SHALL NOT store or serve a cached response whose headers include `Set-Cookie`.
- [ ] **Acceptance criteria:** a route setting a `set-cookie` header is never cached; a subsequent identical
request still executes the handler.

### REQ-020
The system SHALL NOT intercept or cache a streaming/SSE response (handler returns a
`Response`/stream/generator, or `content-type: text/event-stream`).
- [ ] **Acceptance criteria:** such a route, even if misconfigured with `cache`, still streams on every request;
no value is written to the store for it.

### REQ-021
The system SHALL cache only the whole response body and status; it SHALL NOT offer
partial/component/fragment caching.
- [ ] **Acceptance criteria:** the store contract records exactly one value per key; no public API accepts a
sub-selector.

### REQ-035
The system SHALL cache and replay only the response `status` and `body`; any response
header the origin handler set, other than the `Set-Cookie` exclusion in REQ-019, is not
captured or replayed on a hit.
- [ ] **Acceptance criteria:** a route setting a custom header (e.g. `x-request-id`) on a miss does not have that
header present on a subsequent hit.

## G. Fail-open / fail-closed

### REQ-022
IF any Redis operation (generation fetch, value `GET`, value `SET`, `INCR`) errors, times
out, or the client is not ready, THEN the system SHALL treat the request as a cache miss
and call the origin handler without throwing.
- [ ] **Acceptance criteria:** with the Valkey container stopped mid-test, a route with `cache` declared still
returns its correct handler response, not a 500.

### REQ-023
IF `scope()` returns `null` or `undefined` for a request, THEN the system SHALL neither
read from nor write to the cache for that request — no generation fetch, no `GET`, no
`SET`, no invalidation.
- [ ] **Acceptance criteria:** with a scope function returning `null`, repeated identical GETs never hit and a
DELETE never issues an `INCR`.

## H. Escape hatches

### REQ-024
WHERE the request carries the configured bypass header (default `x-auto-cache-bypass`,
overridable via plugin option `bypassHeader`), the system SHALL skip the cache read while
still writing the fresh result to cache under the normal key.
- [ ] **Acceptance criteria:** a request with the header always executes the handler; a following request
without the header observes the freshly written value as a hit.

### REQ-025
The system SHALL expose programmatic `invalidateTag(tag)`, `invalidateTags(tags[])`, and
`dropKey(key)` on the object returned by `redisStore(...)`, callable outside any request.
- [ ] **Acceptance criteria:** calling `store.invalidateTag('campaigns')` directly bumps the generation, observed
by a subsequent key computation.

## I. TTL semantics (ported)

### REQ-026
The system SHALL accept `ttl` as a positive number of seconds or as a function of the
about-to-be-cached result; a resolved ttl below zero SHALL mean do-not-store and a
resolved ttl of exactly `0` SHALL mean never-expires.
- [ ] **Acceptance criteria:** ported unit tests mirror `result-cache.ts:74-84`'s branches (function, positive
number).

### REQ-027
IF a route resolves ttl to `0` and the plugin was not configured with
`allowInfiniteCaching: true`, THEN the system SHALL throw at route-registration time.
- [ ] **Acceptance criteria:** ported from `auto-cache.ts:79-85`; `{ cache: { ttl: 0 } }` without the flag throws;
with the flag, a `SET` with no expiry is issued.

## J. Single-flight (ported)

### REQ-028
The system SHALL deduplicate concurrent cache-miss requests for the identical computed
value key via an in-process `Map<string, Promise<...>>`, awaited by joining callers and
deleted in a `finally` once the leader settles.
- [ ] **Acceptance criteria:** 10 concurrent requests to the same cold key produce exactly one origin-handler
execution and one Redis `SET`.

### REQ-029
IF the leading single-flight call's outcome is not cacheable (REQ-018/019/020), THEN
joined callers SHALL run the origin handler independently rather than reuse the leader's
response.
- [ ] **Acceptance criteria:** concurrent requests to a route whose handler sets `Set-Cookie` each receive their
own cookie, never a shared one.

## K. Serialization (ported)

### REQ-030
The system SHALL support an injectable serializer/deserializer on the redis store
(default `JSON.stringify`/`JSON.parse`), and independent `getErrorBehavior`,
`deserializeErrorBehavior`, `setErrorBehavior` options ported from
`redis-string-cache.ts:5-27`, defaulting to the same fail-open set.
- [ ] **Acceptance criteria:** a poisoned value that fails to deserialize is removed from Redis and the request
proceeds as a miss, matching `redis-string-cache.ts:66-83`.

## L. Packaging & runtime

### REQ-031
The library SHALL ship three subpath entry points — `.` (Elysia plugin), `./core`
(framework-free types and pure functions), `./redis` (ioredis-backed store) — each
independently importable.
- [ ] **Acceptance criteria:** `package.json#exports` resolves all three; `./core` has zero import of `elysia` or
`ioredis`.

### REQ-032
The library SHALL compile to ESM and SHALL NOT call any Bun-only global (`Bun.*`) or use
`bun:test` inside `src/`.
- [ ] **Acceptance criteria:** `grep -R "Bun\." src/` and `grep -R "bun:test" src/` return no matches; the
compiled module target is ESM.

### REQ-033
The system SHALL register itself as `new Elysia({ name: 'auto-cache' })` so repeated
`.use(autoCache(...))` calls on the same app dedupe to a single registration.
- [ ] **Acceptance criteria:** calling `.use()` twice with the same plugin instance does not double-invalidate
(integration test counts `INCR` calls after a single DELETE).

## Assumptions

1. Package name `@jottasystem/elysia-auto-cache`; test runner `bun test` (discovery open
   Qs 1–2). Single-roundtrip Lua read stays out of scope (discovery open Q3).
2. `onHit`/`onMiss` are **per-route** fields on `cache` (not plugin-level), inferred from
   the `ingest-live.ts` prior art (a route-specific audit side effect).
3. `bucket` normalizes by value-shape sniffing (ISO datetime / Unix timestamp), not by an
   explicit field allowlist — keeps the public shape a bare duration string as given.
4. 404 opt-in is a boolean `cache.cacheNotFound`, not a general `statuses` allow-list —
   narrowest reading of "404 only via explicit opt-in."
5. Bypass header defaults to `x-auto-cache-bypass`; plugin option `bypassHeader` overrides.
6. Value key embeds generations via hash (FNV-1a over route+params+gens), not literal
   numbers in the key string — bounds key length while preserving "changes when generation
   changes."
7. Cluster-safety (hash-tag `{scope}` + pipeline) is precautionary: the current consumer
   runs single-node Redis; no cluster integration test exists in this spec.
8. Docker skip/fail posture (`REQUIRE_DOCKER` env var) is newly designed for this library —
   the sibling's `valkey.integration.spec.ts` does not itself implement a skip/fail branch
   (verified: `beforeAll` calls `startValkeyCluster()` unconditionally).
9. Programmatic invalidation (REQ-025) lives on the `redisStore(...)` return value, not a
   separate exported factory — the host already holds that reference.

## Open questions

1. Bucket's value-shape heuristic (assumption 3) vs. an explicit field allowlist — both
   are non-breaking to swap later since `bucket` stays a string either way.
2. Whether `onHit`/`onMiss` should also exist as a plugin-level default — additive, not
   blocking.
3. `cacheNotFound: boolean` vs. a general `statuses` list (assumption 4) — widening later
   is a non-breaking additive field.
4. `REQUIRE_DOCKER` env var name (assumption 8) is invented; confirm no existing
   organization-wide convention before other libs copy it.
5. No cluster-topology integration test backs REQ-005; it is verified by code inspection
   (hash-tag presence, pipeline usage) only, in this spec.

## Unchanged behavior

- ttl negative/0/positive semantics stay identical to `result-cache.ts` (the reference
  this library ports from, not modified by this spec).
- Redis store fail-open defaults (`returnsNull`/`removes`/`ignores`) stay identical to
  `redis-string-cache.ts`'s defaults (the reference, not modified by this spec).
- No file under `/Users/jotta/Documents/bearound` is created or modified by this spec.
- `nestjs-auto-cache` and `nestjs-ioredis` are read-only references; neither package is
  changed by this spec.
