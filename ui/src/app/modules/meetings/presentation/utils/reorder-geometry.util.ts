/** Which side of a row a drop resolves to. */
export type DropEdge = 'before' | 'after';

/**
 * Resolves a pointer's vertical position within a row to a drop edge.
 * Strictly `< rect.height / 2` is `'before'` — the exact midpoint (and
 * everything below it) resolves to `'after'`. Degenerate input — a
 * zero/negative-height rect (jsdom's `getBoundingClientRect` always returns
 * an all-zero rect) or a non-finite `clientY` — resolves to `'before'`.
 */
export function resolveDropEdge(rect: { readonly top: number; readonly height: number }, clientY: number): DropEdge {
  if (rect.height <= 0 || !Number.isFinite(clientY)) {
    return 'before';
  }
  return clientY - rect.top < rect.height / 2 ? 'before' : 'after';
}
