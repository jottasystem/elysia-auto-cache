import { Elysia } from 'elysia';
import type { AutoCacheOptions } from '../core/types.js';
import { createCacheMacro } from './cache-macro.js';
import { createInvalidationHook } from './invalidation.js';

/**
 * Told to cache? It is cached. Wrote something? The tag drops.
 *
 * Two pieces of wiring, deliberately asymmetric:
 *
 *   - the `cache` MACRO runs only on routes that declare it, so caching a read is
 *     always someone's explicit decision;
 *   - the GLOBAL `afterHandle` runs on every route, so invalidating a write is
 *     nobody's decision to forget.
 *
 * The plugin is named, so `.use()`-ing it from several routers registers one
 * instance and a write is never invalidated twice.
 */
export function autoCache(options: AutoCacheOptions) {
  return new Elysia({ name: 'auto-cache' })
    .macro({ cache: createCacheMacro(options) })
    .onAfterHandle({ as: 'global' }, createInvalidationHook(options));
}
