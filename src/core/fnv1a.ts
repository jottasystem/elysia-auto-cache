/**
 * FNV-1a, 32-bit. Not cryptographic and not meant to be: it only has to spread
 * cache keys, and it has to be cheap enough to run on every request.
 *
 * `Math.imul` rather than `*`: the 32-bit product of the FNV prime overflows a
 * double's integer range, so plain multiplication silently loses low bits and
 * stops being FNV-1a.
 */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
