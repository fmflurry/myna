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

/** Inverse of a `delete_transcript_segment` op: re-insert `segment` at `index`. */
export interface TranscriptDeleteOp {
  readonly kind: 'delete';
  readonly meetingId: MeetingId;
  readonly index: number;
  readonly segment: TranscriptSegment;
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

/** Human label for the undo control, e.g. `Undo delete of segment 3`. */
export function describeTranscriptOp(op: TranscriptOp): string {
  switch (op.kind) {
    case 'delete':
      return `Undo delete of segment ${op.index + 1}`;
    case 'merge':
      return `Undo merge of segment ${op.index + 1}`;
  }
}
