// Pure cache-eviction rule shared by the position cache and the pin cache.
// Kept out of App.tsx so it can be unit-tested without pulling in React Flow
// or the DOM.

/** Anything that can answer "how many agents do I know about, and is this one
 *  of them" — a Map of agents keyed by id, or a plain Set of ids. */
type LiveIds = { readonly size: number; has(id: string): boolean };

/**
 * Drop cached entries whose agent no longer exists — unless the graph is empty.
 *
 * Both caches are seeded from localStorage during the very first render, while
 * the event log is still replaying over SSE, so at that moment the agent map is
 * legitimately empty. Pruning against it would delete every position the user
 * had arranged and hand the whole canvas back to dagre on each reload. An empty
 * graph carries no information about what is stale, so it evicts nothing.
 */
export function pruneStaleEntries<T>(cache: Map<string, T>, live: LiveIds): void {
  if (live.size === 0) return;
  for (const id of Array.from(cache.keys())) {
    if (!live.has(id)) cache.delete(id);
  }
}
