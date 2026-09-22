import type { AutoCacheContext, CacheRouteConfig } from '../core/types.js';

/** Per-request scratch space, carried on the context object itself. */
export interface RequestState {
  config: CacheRouteConfig<any>;
  scope: string | null;
  key?: string;
  /** Served straight from the cache — afterHandle must not store it again. */
  hit: boolean;
  /** Joined another request's in-flight work — it owns the store and the hooks. */
  joined: boolean;
  /** Settles the single-flight promise this request is leading, if any. */
  settle?: (cacheable: boolean, value?: unknown) => void;
}

const STATE = Symbol.for('elysia-auto-cache.state');

export function putState(ctx: object, state: RequestState): void {
  (ctx as Record<symbol, unknown>)[STATE] = state;
}

export function getState(ctx: object): RequestState | undefined {
  return (ctx as Record<symbol, RequestState | undefined>)[STATE];
}

/** Elysia's context already carries everything `AutoCacheContext` promises. */
export function asAutoCacheContext(ctx: unknown): AutoCacheContext {
  return ctx as AutoCacheContext;
}

/**
 * `set.status` may be a number, a status name, or absent. Absent means Elysia
 * will answer 200, so that is what the cache has to assume too.
 */
export function numericStatus(status: number | string | undefined): number {
  if (typeof status === 'number') return status;
  if (typeof status === 'string') {
    const parsed = Number(status);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 200;
}
