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
  const fromHost = options.tags?.(route);
  if (fromHost && fromHost.length > 0) return fromHost;
  return deriveRouteTags(route.route);
}
