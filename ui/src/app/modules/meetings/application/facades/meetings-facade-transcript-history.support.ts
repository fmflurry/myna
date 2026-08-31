import type { Meeting, MeetingId } from '../../core/models/meeting.model';
import type { MeetingsStore } from '../stores/meetings.store';
import type { TranscriptDeleteOp, TranscriptMergeOp, TranscriptOp } from '../stores/transcript-history.model';
import type { DeleteTranscriptSegmentUseCase } from '../use-cases/delete-transcript-segment.usecase';
import type { MergeTranscriptSegmentUpUseCase } from '../use-cases/merge-transcript-segment-up.usecase';
import type { RestoreTranscriptSegmentsUseCase } from '../use-cases/restore-transcript-segments.usecase';
import { toErrorInfo } from './meetings-facade.support';

/**
 * Transcript structural-mutation (delete / merge-up) undo plumbing for
 * `MeetingsFacade`, kept out of the facade class to stay under the project's
 * max-lines limit. Unlike `meetings-facade-speaker-history.support.ts`'s
 * capped stack, `TRANSCRIPT_UNDO` holds at most one op: a structural
 * mutation shifts every later segment's index, so replaying an older
 * inverse after a second structural op would rewrite the wrong line — see
 * `transcript-history.model.ts`.
 */

/** Captures the delete inverse for segment `index`, or `null` when `meeting` is not the one being mutated or the index is out of range. */
function captureDeleteInverse(meeting: Meeting | undefined, id: MeetingId, index: number): TranscriptDeleteOp | null {
  if (meeting?.id !== id) {
    return null;
  }
  const segment = meeting.transcript?.segments[index];
  return segment === undefined ? null : { kind: 'delete', meetingId: id, index, segment };
}

/** Captures the merge inverse for segment `index` and the one immediately above it, or `null` when either is missing. */
function captureMergeInverse(meeting: Meeting | undefined, id: MeetingId, index: number): TranscriptMergeOp | null {
  if (meeting?.id !== id) {
    return null;
  }
  const previous = meeting.transcript?.segments[index - 1];
  const current = meeting.transcript?.segments[index];
  return previous === undefined || current === undefined ? null : { kind: 'merge', meetingId: id, index, previous, current };
}

/** Deletes a transcript segment AND records the deletion's inverse once the backend confirms. Never optimistic. */
export async function runDeleteTranscriptSegmentWithHistory(
  store: MeetingsStore,
  deleteTranscriptSegmentUseCase: DeleteTranscriptSegmentUseCase,
  id: MeetingId,
  index: number,
  expectedText: string,
): Promise<void> {
  const inverse = captureDeleteInverse(store.selectedMeeting(), id, index);
  try {
    store.updateMeeting(await deleteTranscriptSegmentUseCase.delete(id, index, expectedText));
    store.setTranscriptUndo(inverse);
    // A structural mutation shifts every later index — any captured
    // speaker-op inverse would now target the wrong line.
    store.setSpeakerHistory([]);
    store.clearError();
  } catch (caught) {
    store.setError(toErrorInfo(caught));
  }
}

/** Merges a segment into the one above it AND records the merge's inverse once the backend confirms. Never optimistic. */
export async function runMergeTranscriptSegmentUpWithHistory(
  store: MeetingsStore,
  mergeTranscriptSegmentUpUseCase: MergeTranscriptSegmentUpUseCase,
  id: MeetingId,
  index: number,
  expectedText: string,
): Promise<void> {
  const inverse = captureMergeInverse(store.selectedMeeting(), id, index);
  try {
    store.updateMeeting(await mergeTranscriptSegmentUpUseCase.merge(id, index, expectedText));
    store.setTranscriptUndo(inverse);
    // A structural mutation shifts every later index — any captured
    // speaker-op inverse would now target the wrong line.
    store.setSpeakerHistory([]);
    store.clearError();
  } catch (caught) {
    store.setError(toErrorInfo(caught));
  }
}

/**
 * Executes the pending transcript op's inverse through
 * `RestoreTranscriptSegmentsUseCase` (persisted, never optimistic). The slot
 * is cleared BEFORE the inverse runs: a failed undo surfaces through the
 * ERROR slot and is never retried silently. A stale op captured against a
 * different meeting (selection changed without clearing the slot) is
 * dropped WITHOUT calling the repository — applying meeting A's inverse to
 * meeting B would corrupt B's transcript.
 */
export async function runUndoLastTranscriptOp(
  store: MeetingsStore,
  restoreTranscriptSegmentsUseCase: RestoreTranscriptSegmentsUseCase,
): Promise<void> {
  const op: TranscriptOp | null = store.transcriptUndo();
  const meeting = store.selectedMeeting();
  if (!op || !meeting) {
    return;
  }
  store.setTranscriptUndo(null);
  if (op.meetingId !== meeting.id) {
    return;
  }
  const id = meeting.id;
  try {
    if (op.kind === 'delete') {
      store.updateMeeting(await restoreTranscriptSegmentsUseCase.restore(id, op.index, 0, [op.segment]));
    } else {
      store.updateMeeting(await restoreTranscriptSegmentsUseCase.restore(id, op.index - 1, 1, [op.previous, op.current]));
    }
    store.clearError();
  } catch (caught) {
    store.setError(toErrorInfo(caught));
  }
}
