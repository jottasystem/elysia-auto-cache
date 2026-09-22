import { buildValueKey } from '../core/cache-key.js';
import { normalizeForBucket, parseBucket } from '../core/bucket.js';
import { SingleFlight, type SingleFlightOutcome } from '../core/single-flight.js';
import { resolveTtl, shouldStore } from '../core/ttl.js';
import type { AutoCacheOptions, CacheEnvelope, CacheRouteConfig } from '../core/types.js';
import { DEFAULT_BYPASS_HEADER, isBypassed } from './bypass.js';
import { asAutoCacheContext, getState, numericStatus, putState } from './request-state.js';
import { resolveTags } from './tags.js';

const READ_METHODS = new Set(['GET', 'HEAD']);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  let settled = false;
  return {
    promise,
    settle(value: T) {
      if (settled) return;
      settled = true;
      resolve(value);
    },
  };
}

/**
 * Things that must never be written to a shared cache, whatever the ttl says.
 *
 * A `Set-Cookie` is the dangerous one: replaying it would hand one viewer another
 * viewer's session. The rest are simply not values — a stream or a `Response` has
 * already been consumed by the time anyone could read it back.
 */
function isCacheableBody(body: unknown): boolean {
  if (body === undefined || body === null) return false;
  if (typeof body === 'function') return false;
  if (typeof Response !== 'undefined' && body instanceof Response) return false;
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) return false;
  if (typeof Blob !== 'undefined' && body instanceof Blob) return false;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return false;
  if (typeof body === 'object' && Symbol.asyncIterator in (body as object)) return false;
  return true;
}

function setsCookie(ctx: { set?: { headers?: Record<string, unknown>; cookie?: Record<string, unknown> } }): boolean {
  const headers = ctx.set?.headers ?? {};
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === 'set-cookie') return true;
  }
  const cookie = ctx.set?.cookie;
  return !!cookie && Object.keys(cookie).length > 0;
}

/**
 * The `cache` macro. Present only on routes that declare it — which is what makes
 * caching opt-in while invalidation stays automatic.
 *
 * The macro body runs at ROUTE REGISTRATION, so a bad `bucket` or an unguarded
 * infinite ttl throws while the app is being built, not on the first request.
 */
export function createCacheMacro(options: AutoCacheOptions) {
  const flight = new SingleFlight<CacheEnvelope>();
  const bypassHeader = options.bypassHeader ?? DEFAULT_BYPASS_HEADER;

  return function cache(config: CacheRouteConfig<any>) {
    const bucketSeconds = config.bucket === undefined ? undefined : parseBucket(config.bucket);
    if (typeof config.ttl === 'number') {
      // Registration-time guard; a ttl FUNCTION can only be checked once it runs.
      resolveTtl(config.ttl, undefined, options.allowInfiniteCaching);
    }

    return {
      async beforeHandle(rawCtx: any) {
        const ctx = asAutoCacheContext(rawCtx);
        const method = ctx.request.method.toUpperCase();

        const scope = options.scope(ctx);
        const resolvedScope = scope === null || scope === undefined ? null : scope;

        // State exists even for a mutating verb: the invalidation hook reads
        // `config.invalidates` from it.
        putState(rawCtx, { config, scope: resolvedScope, hit: false, joined: false });

        // Fail-closed: no scope, no cache — in either direction, before any I/O.
        if (resolvedScope === null) return undefined;
        if (!READ_METHODS.has(method)) return undefined;

        const tags = resolveTags(options, { method, route: ctx.route }, config.tags);
        const generations = await options.store.getGenerations(resolvedScope, tags);

        const rawParams = { ...(ctx.params ?? {}), ...(ctx.query ?? {}) } as Record<string, unknown>;
        const params = bucketSeconds === undefined ? rawParams : normalizeForBucket(rawParams, bucketSeconds);

        const key = buildValueKey({ scope: resolvedScope, route: ctx.route, tags, generations, params });
        const state = getState(rawCtx)!;
        state.key = key;

        const inFlight = flight.join(key);
        if (inFlight) {
          state.joined = true;
          const outcome = await inFlight;
          if (outcome.cacheable) {
            ctx.set.status = outcome.value.status;
            return outcome.value.body;
          }
          // The leader produced something unshareable. Run the handler ourselves
          // rather than hand this caller someone else's cookie.
          state.joined = false;
          return undefined;
        }

        // Lead BEFORE the read, so concurrent callers also skip the round-trip.
        const gate = deferred<SingleFlightOutcome<CacheEnvelope>>();
        state.settle = (cacheable, value) =>
          gate.settle(cacheable ? { cacheable: true, value: value as CacheEnvelope } : { cacheable: false });
        flight.lead(key, () => gate.promise);

        // Bypass skips the READ only; the write below still refreshes the entry.
        const cached = isBypassed(ctx.request, bypassHeader) ? null : await options.store.get(key);
        if (cached) {
          state.hit = true;
          state.settle(true, cached);
          await config.onHit?.(ctx);
          ctx.set.status = cached.status;
          return cached.body;
        }

        return undefined;
      },

      async afterHandle(rawCtx: any) {
        const state = getState(rawCtx);
        if (!state || state.hit || state.joined || !state.key || state.scope === null) return;

        const ctx = asAutoCacheContext(rawCtx);
        const body = rawCtx.responseValue;
        const status = numericStatus(ctx.set?.status);

        const statusOk = (status >= 200 && status <= 299) || (status === 404 && config.cacheNotFound === true);
        const storable = statusOk && !setsCookie(rawCtx) && isCacheableBody(body);

        if (!storable) {
          state.settle?.(false);
          await config.onMiss?.(ctx);
          return;
        }

        let ttl: number;
        try {
          ttl = resolveTtl(config.ttl, body, options.allowInfiniteCaching);
        } catch (error) {
          state.settle?.(false);
          throw error;
        }

        const envelope: CacheEnvelope = { status, body };
        if (shouldStore(ttl)) await options.store.set(state.key, envelope, ttl);
        state.settle?.(true, envelope);
        await config.onMiss?.(ctx);
      },

      // A handler that threw must release its joiners, or they wait forever on a
      // promise nothing will ever settle.
      error(rawCtx: any) {
        getState(rawCtx)?.settle?.(false);
        return undefined;
      },
    };
  };
}
