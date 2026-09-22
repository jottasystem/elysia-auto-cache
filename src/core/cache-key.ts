import { fnv1a } from './fnv1a.js';

/**
 * Both key shapes wrap the scope in `{...}`. That is a Redis Cluster hash tag:
 * every key belonging to one tenant lands in the same slot, which is what makes
 * a multi-key generation read legal on a clustered deployment.
 */
function scoped(scope: string): string {
  return `ac:{${scope}}`;
}

/** `ac:{<scope>}:gen:<tag>` — an INCR counter, never given a TTL. */
export function generationKey(scope: string, tag: string): string {
  return `${scoped(scope)}:gen:${tag}`;
}

/** Deterministic JSON: object key order must never change the hash. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export interface ValueKeyInput {
  scope: string;
  /** The REGISTERED route (`/campaigns/:id/targets`), never the requested path. */
  route: string;
  tags: string[];
  /** Current generation per tag, positionally aligned with `tags`. */
  generations: number[];
  /** Request params + query, already bucket-normalized when the route asked for it. */
  params: Record<string, unknown>;
}

/**
 * `ac:{<scope>}:v:<route>:<fnv1a>`.
 *
 * The generations are folded INTO the hash, which is the whole invalidation
 * mechanism: bump a tag and every key built against the old generation stops
 * being addressable. Nothing is deleted — the orphans expire on their own TTL.
 */
export function buildValueKey(input: ValueKeyInput): string {
  const pairs = input.tags
    .map((tag, i) => [tag, input.generations[i] ?? 0] as [string, number])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const material = stableStringify({ route: input.route, tags: pairs, params: input.params });
  return `${scoped(input.scope)}:v:${input.route}:${fnv1a(material)}`;
}
