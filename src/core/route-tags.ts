function isDynamic(segment: string): boolean {
  return segment.startsWith(':') || segment.startsWith('*');
}

/**
 * Default tags for a registered route, with zero domain knowledge.
 *
 * Trailing dynamic segments are dropped first — a tag pointing at one specific
 * id would only ever invalidate that id's own entry, and a write to a child
 * almost always has to invalidate the collection that lists it.
 *
 *   /campaigns/:id/targets/:targetId -> ['campaigns/:id/targets', 'campaigns']
 *   /campaigns                       -> ['campaigns']
 *   /a/b/c                           -> ['a/b/c', 'a']
 */
export function deriveRouteTags(route: string): string[] {
  const segments = route.split('/').filter(Boolean);
  while (segments.length > 0 && isDynamic(segments[segments.length - 1] as string)) segments.pop();
  if (segments.length === 0) return [];
  const specific = segments.join('/');
  const broad = segments[0] as string;
  return specific === broad ? [specific] : [specific, broad];
}
