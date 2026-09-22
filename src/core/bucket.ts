const DURATION = /^(\d+)(s|m|h)$/;
const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600 };
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const DIGITS = /^\d+$/;

/** Below this a number is not plausibly a timestamp — it is a page, a limit, an id. */
const UNIX_SECONDS_FLOOR = 1_000_000_000;
const UNIX_MILLIS_FLOOR = 1_000_000_000_000;

/** `'30s' | '5m' | '1h'` -> seconds. Throws on anything else. */
export function parseBucket(spec: string): number {
  const match = DURATION.exec(spec);
  if (!match) {
    throw new Error(`[auto-cache] unparsable bucket ${JSON.stringify(spec)} — expected a duration like "60s", "5m" or "1h".`);
  }
  const amount = Number(match[1]);
  const unit = UNIT_SECONDS[match[2] as string] as number;
  if (amount <= 0) throw new Error(`[auto-cache] bucket ${JSON.stringify(spec)} must be greater than zero.`);
  return amount * unit;
}

function floorTo(millis: number, bucketMillis: number): number {
  return Math.floor(millis / bucketMillis) * bucketMillis;
}

/**
 * Rounds anything that LOOKS like a moment in time down to the bucket boundary.
 *
 * This exists because a caller that builds `to: Date.now()` mints a brand new
 * key on every request, so the entry is written and never read. Rounding makes
 * the key repeat within the window, which is the difference between a cache and
 * a write-only Redis.
 */
export function normalizeForBucket(
  value: Record<string, unknown>,
  bucketSeconds: number,
): Record<string, unknown> {
  const bucketMillis = bucketSeconds * 1000;

  const walk = (node: unknown): unknown => {
    if (node instanceof Date) return new Date(floorTo(node.getTime(), bucketMillis)).toISOString();
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, walk(v)]));
    }
    if (typeof node === 'number' && Number.isFinite(node)) {
      if (node >= UNIX_MILLIS_FLOOR) return floorTo(node, bucketMillis);
      if (node >= UNIX_SECONDS_FLOOR) return floorTo(node * 1000, bucketMillis) / 1000;
      return node;
    }
    if (typeof node === 'string') {
      if (ISO_DATETIME.test(node)) {
        const parsed = Date.parse(node);
        if (!Number.isNaN(parsed)) return new Date(floorTo(parsed, bucketMillis)).toISOString();
      }
      // Query params arrive as strings — `?to=1767225600000` is the common case,
      // and it is the exact one this whole mechanism exists for. Round it, and
      // hand it back as a string so the value keeps the shape it came in with.
      if (DIGITS.test(node)) {
        const parsed = Number(node);
        if (Number.isSafeInteger(parsed)) {
          if (parsed >= UNIX_MILLIS_FLOOR) return String(floorTo(parsed, bucketMillis));
          if (parsed >= UNIX_SECONDS_FLOOR) return String(floorTo(parsed * 1000, bucketMillis) / 1000);
        }
      }
    }
    return node;
  };

  return walk(value) as Record<string, unknown>;
}
