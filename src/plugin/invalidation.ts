import type { AutoCacheOptions } from '../core/types.js';
import { asAutoCacheContext, getState, numericStatus } from './request-state.js';
import { resolveTags } from './tags.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The global `afterHandle` hook: it fires on every route, whether or not that
 * route declared `cache`.
 *
 * That asymmetry is the point of the library. Opting a read IN is a decision
 * someone makes once; remembering to invalidate on every write is a decision
 * someone has to make forever, and forgetting it serves wrong data silently.
 * Over-invalidating only costs a cache miss.
 *
 * `afterHandle`, never `afterResponse`: the bump has to land before the response
 * leaves, or a client that re-reads the instant its write returns sees the value
 * it just replaced.
 */
export function createInvalidationHook(options: AutoCacheOptions) {
  return async function invalidateOnMutation(ctx: unknown): Promise<void> {
    const context = asAutoCacheContext(ctx);
    const method = context.request.method.toUpperCase();
    if (!MUTATING.has(method)) return;

    // A 4xx/5xx changed nothing, so it invalidates nothing.
    const status = numericStatus(context.set?.status);
    if (status < 200 || status > 299) return;

    const scope = options.scope(context);
    if (scope === null || scope === undefined) return;

    const declared = getState(context as object)?.config?.invalidates;
    const tags = resolveTags(options, { method, route: context.route }, declared);
    if (tags.length === 0) return;

    // Fail-open: a write that succeeded must not be reported as failed because
    // the cache could not be told about it.
    await options.store.invalidateTags(scope, tags);
  };
}
