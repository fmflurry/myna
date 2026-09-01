/**
 * Session-scoped undo for transcript structural mutations (delete / merge-up),
 * living in the `TRANSCRIPT_UNDO` flurryx slot. Unlike `SPEAKER_HISTORY` (a
 * capped stack), this slot holds at most ONE op: a structural mutation
 * shifts every later segment's index, so an older captured inverse would
 * target the wrong line the moment a second structural op runs. Clearing
 * `SPEAKER_HISTORY` alongside every structural op is mandatory for the same
 * reason — see `meetings-facade-transcript-history.support.ts`.
 *
 * Each op carries everything needed to reverse it, captured from
 * `store.selectedMeeting()` BEFORE the forward mutation runs; the slot is
 * populated only after the backend confirms the mutation. Undo re-executes
 * the inverse through the existing `RestoreTranscriptSegmentsUseCase`
 * (persisted, never optimistic) — mirrors `speaker-history.model.ts`'s
 * contract: flurryx `undo()`/`restoreStoreAt` are deliberately NOT used,
 * since disk is the source of truth.
 */

import type { MeetingId } from '../../core/models/meeting.model';
import type { TranscriptSegment } from '../../core/models/transcript.model';

/**
 * Inverse of one or more `delete_transcript_segment` calls made as ONE
 * compound op (a whole visible section): re-insert every entry of `segments`
 * — in ascending original order — at `index` (the group's FIRST index) in a
 * single `restore_transcript_segments` splice. The UI only ever deletes
 * CONTIGUOUS groups, which is what makes "splice everything back at the
 * minimum index" an exact inverse.
 */
export interface TranscriptDeleteOp {
  readonly kind: 'delete';
  readonly meetingId: MeetingId;
  readonly index: number;
  readonly segments: readonly TranscriptSegment[];
}

/** Inverse of a `merge_transcript_segment_up` op: restore both original segments at `index - 1` and `index`. */
export interface TranscriptMergeOp {
  readonly kind: 'merge';
  readonly meetingId: MeetingId;
  readonly index: number;
  readonly previous: TranscriptSegment;
  readonly current: TranscriptSegment;
}

export type TranscriptOp = TranscriptDeleteOp | TranscriptMergeOp;

/** Human label for the undo control, e.g. `Undo delete of segment 3` / `Undo delete of 2 segments`. */
export function describeTranscriptOp(op: TranscriptOp): string {
  switch (op.kind) {
    case 'delete':
      return op.segments.length === 1
        ? `Undo delete of segment ${op.index + 1}`
        : `Undo delete of ${op.segments.length} segments`;
    case 'merge':
      return `Undo merge of segment ${op.index + 1}`;
  }
}
