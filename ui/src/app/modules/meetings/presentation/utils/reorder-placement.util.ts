import type { MeetingId } from '../../core/models/meeting.model';
import type { DropEdge } from './reorder-geometry.util';

/** The backend neighbour pair a placement resolves to; `null` for either end of the list. */
export interface ReorderPlacement {
  readonly previousId: MeetingId | null;
  readonly nextId: MeetingId | null;
}

/**
 * Computes the backend neighbour pair for dropping `draggedId` at `edge` of
 * `anchorId`, given the CONTAINER's rendered order. Returns `null` when the
 * drop is a no-op: the anchor is absent (stale — e.g. deleted mid-drag), the
 * anchor IS the dragged row, or the resolved neighbours are identical to the
 * dragged meeting's CURRENT neighbours (dropping a row back onto its own
 * slot). Neighbour ids are read from `rendered`, never an index — the
 * backend's ordering array and the UI's filtered array are different lists.
 */
export function computePlacement(
  rendered: readonly MeetingId[],
  draggedId: MeetingId,
  anchorId: MeetingId,
  edge: DropEdge,
): ReorderPlacement | null {
  const currentIndex = rendered.indexOf(draggedId);
  const currentPreviousId = currentIndex > 0 ? (rendered[currentIndex - 1] ?? null) : null;
  const currentNextId = currentIndex >= 0 ? (rendered[currentIndex + 1] ?? null) : null;

  const stripped = rendered.filter((id) => id !== draggedId);
  const anchorIndex = stripped.indexOf(anchorId);
  if (anchorIndex === -1) {
    return null;
  }

  const slotIndex = edge === 'before' ? anchorIndex : anchorIndex + 1;
  const previousId = slotIndex > 0 ? (stripped[slotIndex - 1] ?? null) : null;
  const nextId = stripped[slotIndex] ?? null;

  if (previousId === currentPreviousId && nextId === currentNextId) {
    return null;
  }

  return { previousId, nextId };
}
