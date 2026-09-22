import { deriveRouteTags } from '../core/route-tags.js';
import type { AutoCacheOptions, RouteInfo } from '../core/types.js';

/**
 * One precedence order, used by both directions.
 *
 * An explicit list on the route wins, then the host's resolver, then the path
 * derivation. The derivation is last on purpose: it is the one that knows
 * nothing, so it must never override something that does.
 */
export function resolveTags(options: AutoCacheOptions, route: RouteInfo, override?: string[]): string[] {
  if (override && override.length > 0) return override;
  // `undefined` defers to the derivation; an empty array is an answer ("no tags").
  // Treating [] as "no opinion" made every write on a route the host knows nothing
  // about bump a path-derived tag, one Redis INCR per POST on the hottest paths.
  const fromHost = options.tags?.(route);
  if (fromHost !== undefined) return fromHost;
  return deriveRouteTags(route.route);
}
