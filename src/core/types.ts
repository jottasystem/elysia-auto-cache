/**
 * The public shapes of the library. `core` never imports `elysia` or `ioredis`:
 * everything here is plain TypeScript so the host can implement a store, a scope
 * resolver or a tag resolver without dragging either dependency in.
 */

/**
 * The only thing ever serialized into the store.
 *
 * Deliberately just status + body: headers are NOT replayed on a hit. A cached
 * `Set-Cookie` would hand one viewer another viewer's session, and a cached
 * `x-request-id` would lie. Routes that set either are simply never stored.
 */
export interface CacheEnvelope<T = unknown> {
  status: number;
  body: T;
}

/**
 * The store contract. Adapted from `nestjs-auto-cache`'s `CacheInterface`
 * (get/set/remove), extended with the generation operations that make tag
 * invalidation O(1).
 */
export interface CacheStore {
  get(key: string): Promise<CacheEnvelope | null>;
  set(key: string, value: CacheEnvelope, ttl: number): Promise<void>;
  remove(key: string): Promise<void>;
  /** Public escape hatch; an alias of `remove` with a name that reads well from host code. */
  dropKey(key: string): Promise<void>;
  /** Current generation of each tag, in the order asked. A tag never invalidated reads as 0. */
  getGenerations(scope: string, tags: string[]): Promise<number[]>;
  /** One INCR. Every value key built against the previous generation becomes unreachable. */
  invalidateTag(scope: string, tag: string): Promise<void>;
  invalidateTags(scope: string, tags: string[]): Promise<void>;
}

/** A route as the router registered it — `/campaigns/:id/targets`, never the requested URL. */
export interface RouteInfo {
  method: string;
  route: string;
}

export interface AutoCacheContext {
  request: Request;
  /** The registered route pattern. Stable across requests; this is the cache identity. */
  route: string;
  /** The URL path as requested. Present for host hooks; never used to build a key. */
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  set: { status?: number | string; headers: Record<string, string> };
  /** Whatever the host decorated onto the Elysia context — `ctx.auth`, and so on. */
  [hostField: string]: unknown;
}

/**
 * Resolves the cache partition for this request. Returning `null`/`undefined`
 * means "do not read and do not write" — fail-closed, and the reason the library
 * cannot leak one tenant's response to another.
 */
export type ScopeFn = (ctx: AutoCacheContext) => string | null | undefined;

/**
 * Overrides the default path-derived tags for a route. Return `undefined` to fall
 * back to the derivation; an empty array means the route has no tags at all.
 */
export type TagsFn = (route: RouteInfo) => string[] | undefined;

export interface AutoCacheOptions {
  store: CacheStore;
  scope: ScopeFn;
  tags?: TagsFn;
  /** Default `x-auto-cache-bypass`. Presence skips the read; the cache is still filled. */
  bypassHeader?: string;
  /** A ttl of 0 means "never expires" and throws unless this is explicitly enabled. */
  allowInfiniteCaching?: boolean;
}

export type TtlResolver<TResult = unknown> = (result: TResult) => number;

export interface CacheRouteConfig<TResult = unknown> {
  /**
   * Seconds. A function receives the handler's result.
   * Positive = store for that long · negative = do not store · 0 = never expires
   * (rejected unless `allowInfiniteCaching`).
   */
  ttl: number | TtlResolver<TResult>;
  /** This route's read-cache tags. Defaults to the path derivation. */
  tags?: string[];
  /** Tags to bump on a successful mutation. Only meaningful on a mutating verb. */
  invalidates?: string[];
  /** `'30s' | '5m' | '1h'` — rounds temporal values before hashing so keys repeat. */
  bucket?: string;
  /** Opt in to caching a 404. Every other non-2xx is never cached. */
  cacheNotFound?: boolean;
  /** Fires for every request served a stored response: a hit, or a joiner of an in-flight miss. */
  onHit?: (ctx: AutoCacheContext) => void | Promise<void>;
  onMiss?: (ctx: AutoCacheContext) => void | Promise<void>;
}
