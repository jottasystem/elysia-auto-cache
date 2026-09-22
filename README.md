# @jottasystem/elysia-auto-cache

Declarative response cache for [Elysia](https://elysiajs.com), with **automatic tag
invalidation** over Redis.

One asymmetry drives the whole design:

- **caching a read is opt-in** — you write `cache: { ttl }` on the route;
- **invalidating a write is automatic** — you write nothing.

That is on purpose. Forgetting to opt a read in costs a cache miss. Forgetting to
invalidate a write serves wrong data, silently, until a TTL you forgot about expires.
Automate the one whose failure mode is correctness.

## Install

```bash
bun add @jottasystem/elysia-auto-cache ioredis
```

`elysia` and `ioredis` are peer dependencies.

## Use

```ts
import { Elysia } from 'elysia';
import { Redis } from 'ioredis';
import { autoCache } from '@jottasystem/elysia-auto-cache';
import { redisStore } from '@jottasystem/elysia-auto-cache/redis';

const redis = new Redis(process.env.REDIS_URL!);

const app = new Elysia()
  .use(
    autoCache({
      store: redisStore(redis),
      // The cache partition. Returning null means "do not read, do not write".
      scope: (ctx) => (ctx.auth as { businessId?: string } | undefined)?.businessId ?? null,
    }),
  )

  // Read: opt in.
  .get('/campaigns/:id/targets', listTargets, { cache: { ttl: 600 } })

  // Write: declare nothing. Both `campaigns/:id/targets` and `campaigns` drop.
  .delete('/campaigns/:id/targets/:targetId', deleteTarget);
```

### Route options

```ts
{
  cache: {
    ttl: 600,                     // seconds; or (result) => seconds
    tags: ['campaigns'],          // override this route's read tags
    invalidates: ['campaigns'],   // override what a mutating route bumps
    bucket: '60s',                // round temporal params before hashing
    cacheNotFound: true,          // opt in to caching a 404
    onHit: (ctx) => auditRead(ctx),
    onMiss: (ctx) => auditRead(ctx),
  }
}
```

**`ttl`** — positive seconds store; **negative means do not store**; `0` means never
expires and throws unless you pass `allowInfiniteCaching: true` to the plugin. The guard
is deliberate: an entry with no expiry is the one that can outlive the fact it describes.

**`bucket`** — if a route builds `from`/`to` from `Date.now()`, every request mints a new
key and the cache is write-only. `bucket: '60s'` rounds anything that looks like a
timestamp or an ISO-8601 datetime down to the window boundary, so the key repeats.

**`onHit` / `onMiss`** — `onHit` fires for every request served a stored response: a hit,
and also a request that joined another's in-flight miss (it receives the same stored
response, so it gets the same side effects). `onMiss` fires once, for the request that ran
the handler. This exists so a request-scoped side effect (an audit row, a PII access record)
survives the cache: every reader is seen exactly once. The library does not know or care
what you run inside them.

**`tags` (plugin option)** — return the tags for a route, `[]` for "this route has no tags",
or `undefined` to fall back to the path derivation. An empty array is an answer: a write on
a route with no tags touches Redis not at all.

### Escape hatches

```ts
// Read-through: skips the read, still refreshes the entry.
fetch(url, { headers: { 'x-auto-cache-bypass': '1' } });

// Programmatic, outside any request.
await store.invalidateTag('biz-1', 'campaigns');
await store.invalidateTags('biz-1', ['campaigns', 'audiences']);
await store.dropKey(key);
```

## How invalidation works

Each tag has a **generation counter**. A value key embeds the current generation of every
tag it belongs to:

```
generation key   ac:{biz-1}:gen:campaigns              -> 7
value key        ac:{biz-1}:v:/campaigns/:id/targets:1a2b3c4d
```

Invalidating is one `INCR`. Every key built against generation 7 is now unreachable —
nothing is scanned and nothing is deleted; the orphans expire on their own TTL. This is
O(1) regardless of how many entries the tag covers, which is why there is no `SCAN` or
`KEYS` anywhere in this library.

Because correctness comes from the `INCR` and not from expiry, **TTLs on write-invalidated
routes can be long**. The TTL is a memory bound and a safety net, not the freshness
mechanism.

## ⚠ Required Redis configuration

**Set a `volatile-*` maxmemory policy:**

```
maxmemory-policy volatile-lru
```

Generation keys are stored **without a TTL**, deliberately — they must outlive every value
key they govern. Under `allkeys-lru` or `allkeys-random`, Redis may evict a generation key
while the value keys built against it survive. The generation then reads as `0` again, and
entries you already invalidated become addressable.

**This is the only path in this design that serves wrong data.** A `volatile-*` policy
closes it: those policies only ever evict keys that have an expiry, and generation keys
have none. A full `FLUSHALL` is safe — it takes the values with the generations, so the
cache is merely cold.

## Guarantees

| | |
|---|---|
| Redis down, slow, or serving garbage | the handler runs; the request is never failed |
| a host-written store that throws | same: the cache is skipped for that request, never a 500 |
| a generation that cannot be read | a poison generation: a miss, never generation 0 (which would re-open invalidated entries) |
| `scope()` returns `null` | nothing is read and nothing is written — fail-closed, no cross-tenant leak |
| response carries `Set-Cookie` | never cached |
| streaming / non-2xx response | never cached (404 only via `cacheNotFound`) |
| 10 concurrent requests, cold key | one handler execution; the rest join it, and each joiner fires `onHit` |
| leader's response not shareable | joiners run the handler themselves |
| headers set by the handler | **not** replayed on a hit — only status and body are stored |

## Layout

| Import | Contents |
|---|---|
| `@jottasystem/elysia-auto-cache` | the Elysia plugin |
| `@jottasystem/elysia-auto-cache/core` | framework-free primitives and types; imports neither `elysia` nor `ioredis` |
| `@jottasystem/elysia-auto-cache/redis` | `redisStore()` over ioredis |

## Tests

```bash
bun test                       # everything; integration suites skip without Docker
REQUIRE_DOCKER=1 bun test      # make a missing Docker fail instead of skip
```

Integration and E2E tests run against a real Valkey container — a fake Redis only tests
the belief of whoever wrote the fake.

## License

MIT
