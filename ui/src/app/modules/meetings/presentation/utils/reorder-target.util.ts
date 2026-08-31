import type { FolderId } from '../../core/models/folder.model';
import type { MeetingId } from '../../core/models/meeting.model';
import type { DropEdge } from './reorder-geometry.util';
import { computePlacement } from './reorder-placement.util';

/** The container a dragged/reordered meeting resolves into — no positioning info. */
export type MeetingContainer =
  | { readonly kind: 'folder'; readonly folderId: FolderId }
  | { readonly kind: 'uncategorized' }
  | { readonly kind: 'archive' };

/** A row-level placement within/into a container — carries the resolved neighbour pair. */
export interface MeetingPlacementTarget {
  readonly kind: 'placement';
  readonly container: MeetingContainer;
  readonly previousId: MeetingId | null;
  readonly nextId: MeetingId | null;
}

/**
 * Resolves a row-level drop (`edge` of `anchorId`) within `container`'s
 * rendered order to a `MeetingPlacementTarget`, or `null` for a no-op drop
 * (see `computePlacement`).
 */
export function resolveRowDropPlacement(
  rendered: readonly MeetingId[],
  draggedId: MeetingId,
  anchorId: MeetingId,
  edge: DropEdge,
  container: MeetingContainer,
): MeetingPlacementTarget | null {
  const placement = computePlacement(rendered, draggedId, anchorId, edge);
  if (!placement) {
    return null;
  }
  return { kind: 'placement', container, previousId: placement.previousId, nextId: placement.nextId };
}

/**
 * Resolves an Alt+Arrow keyboard swap of `draggedId` with its neighbour
 * (`direction`) in `rendered`'s current order to a `MeetingPlacementTarget`,
 * or `null` at a container boundary / when `draggedId` isn't found in `rendered`.
 */
export function resolveKeyboardSwapPlacement(
  rendered: readonly MeetingId[],
  draggedId: MeetingId,
  direction: 'up' | 'down',
  container: MeetingContainer,
): MeetingPlacementTarget | null {
  const index = rendered.indexOf(draggedId);
  if (index === -1) {
    return null;
  }
  const swapIndex = direction === 'down' ? index + 1 : index - 1;
  if (swapIndex < 0 || swapIndex >= rendered.length) {
    return null;
  }
  const anchorId = rendered[swapIndex];
  if (anchorId === undefined) {
    return null;
  }
  const edge: DropEdge = direction === 'down' ? 'after' : 'before';
  return resolveRowDropPlacement(rendered, draggedId, anchorId, edge, container);
}
