import type { TtlResolver } from './types.js';

/**
 * Ported from `nestjs-auto-cache`: positive seconds store, negative means do not
 * store, and `0` means never expires — which is refused unless the host opts in.
 *
 * The guard is the point. An entry with no expiry is the one that can outlive the
 * fact it describes, and every cache should be able to recover just by waiting.
 */
export function resolveTtl<T>(ttl: number | TtlResolver<T>, result: T, allowInfiniteCaching = false): number {
  const resolved = typeof ttl === 'function' ? ttl(result) : ttl;
  assertTtl(resolved, allowInfiniteCaching);
  return resolved;
}

export function assertTtl(ttl: number, allowInfiniteCaching = false): void {
  if (!Number.isFinite(ttl)) {
    throw new Error(`[auto-cache] ttl must be a finite number of seconds, received ${String(ttl)}.`);
  }
  if (ttl === 0 && !allowInfiniteCaching) {
    throw new Error(
      '[auto-cache] ttl 0 means the entry never expires. Set allowInfiniteCaching: true if that is really what you want — ' +
        'otherwise give it a ttl, so a wrong entry heals by itself.',
    );
  }
}

/** True when a resolved ttl says "store this". */
export function shouldStore(ttl: number): boolean {
  return ttl >= 0;
}
