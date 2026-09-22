export const DEFAULT_BYPASS_HEADER = 'x-auto-cache-bypass';

/**
 * Bypass means "do not READ the cache", not "do not cache".
 *
 * The request still fills the entry on its way out, so the escape hatch someone
 * reaches for when they suspect a stale response is also the one that repairs it.
 */
export function isBypassed(request: Request, headerName: string = DEFAULT_BYPASS_HEADER): boolean {
  const value = request.headers.get(headerName.toLowerCase());
  if (value === null) return false;
  return value !== '0' && value.toLowerCase() !== 'false';
}
