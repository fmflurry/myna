import type { Meeting, MeetingId } from '../../core/models/meeting.model';
import type { TranscriptSegment } from '../../core/models/transcript.model';
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
  return segment === undefined ? null : { kind: 'delete', meetingId: id, index, segments: [segment] };
}

/** Captures the compound delete inverse for every index in `indices`, or `null` unless `meeting` matches and ALL segments resolve. */
function captureSectionDeleteInverse(
  meeting: Meeting | undefined,
  id: MeetingId,
  indices: readonly number[],
): TranscriptDeleteOp | null {
  if (meeting?.id !== id) {
    return null;
  }
  // Capture in ASCENDING index order — the original transcript order — no
  // matter what order the caller passed, so undo's single splice at
  // `startIndex` re-inserts the section exactly as it stood.
  const ascending = [...indices].sort((a, b) => a - b);
  const segments: TranscriptSegment[] = [];
  for (const index of ascending) {
    const segment = meeting.transcript?.segments[index];
    if (segment === undefined) {
      return null;
    }
    segments.push(segment);
  }
  const startIndex = ascending.at(0);
  return startIndex === undefined ? null : { kind: 'delete', meetingId: id, index: startIndex, segments };
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

/**
 * Deletes a whole VISIBLE SECTION (a contiguous group of segments sharing
 * one speaker) as ONE compound undo step. The CAS `expectedText` for every
 * index is resolved from `store.selectedMeeting()` at CALL time — the UI's
 * current truth — then the deletes run sequentially HIGHEST index first, so
 * indices queued below never shift under the loop. On the FIRST failure the
 * loop stops: the already-deleted prefix stays applied (the backend commits
 * each delete on its own), NO undo op is written (a partial section has no
 * meaningful single-slot inverse — re-opening the meeting resyncs the UI),
 * and both standing histories are dropped when anything was applied: the
 * shifted indices invalidate SPEAKER_HISTORY inverses AND any TRANSCRIPT_UNDO
 * captured by a previous successful op. On full success exactly
 * ONE compound `{index: min, segments}` op lands in `TRANSCRIPT_UNDO`.
 */
export async function runDeleteTranscriptSectionWithHistory(
  store: MeetingsStore,
  deleteTranscriptSegmentUseCase: DeleteTranscriptSegmentUseCase,
  id: MeetingId,
  indices: readonly number[],
): Promise<void> {
  const meeting = store.selectedMeeting();
  const inverse = captureSectionDeleteInverse(meeting, id, indices);
  const texts = new Map(indices.map((index) => [index, meeting?.transcript?.segments[index]?.text ?? '']));
  const descending = [...indices].sort((a, b) => b - a);
  let applied = 0;
  try {
    for (const index of descending) {
      store.updateMeeting(await deleteTranscriptSegmentUseCase.delete(id, index, texts.get(index) ?? ''));
      applied += 1;
    }
    store.setTranscriptUndo(inverse);
    // A structural mutation shifts every later index — any captured
    // speaker-op inverse would now target the wrong line.
    store.setSpeakerHistory([]);
    store.clearError();
  } catch (caught) {
    if (applied > 0) {
      // The applied prefix shifted every later index: standing speaker-op
      // inverses AND any TRANSCRIPT_UNDO captured by an EARLIER successful
      // structural op now target the wrong lines — replaying either would
      // rewrite or duplicate a different segment. Drop both.
      store.setSpeakerHistory([]);
      store.setTranscriptUndo(null);
    }
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
 * ERROR slot and is never retried silently. On success SPEAKER_HISTORY is
 * cleared too — a restore shifts indices just like the forward op did. A
 * stale op captured against a different meeting (selection changed without
 * clearing the slot) is dropped WITHOUT calling the repository — applying
 * meeting A's inverse to meeting B would corrupt B's transcript.
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
      store.updateMeeting(await restoreTranscriptSegmentsUseCase.restore(id, op.index, 0, op.segments));
    } else {
      store.updateMeeting(await restoreTranscriptSegmentsUseCase.restore(id, op.index - 1, 1, [op.previous, op.current]));
    }
    // The restore is a blind splice (the backend has no CAS): it shifts every
    // later index exactly like the forward op it reverses, so it is itself a
    // structural mutation — standing speaker-op inverses now target the wrong
    // lines. Same contract as the forward paths.
    store.setSpeakerHistory([]);
    store.clearError();
  } catch (caught) {
    store.setError(toErrorInfo(caught));
  }
}
