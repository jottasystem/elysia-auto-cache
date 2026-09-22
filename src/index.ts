export { autoCache } from './plugin/auto-cache.js';
export { DEFAULT_BYPASS_HEADER, isBypassed } from './plugin/bypass.js';
export { deriveRouteTags } from './core/route-tags.js';
export { normalizeForBucket, parseBucket } from './core/bucket.js';
export { buildValueKey, generationKey } from './core/cache-key.js';
export type {
  AutoCacheContext,
  AutoCacheOptions,
  CacheEnvelope,
  CacheRouteConfig,
  CacheStore,
  RouteInfo,
  ScopeFn,
  TagsFn,
  TtlResolver,
} from './core/types.js';
