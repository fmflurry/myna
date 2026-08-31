/**
 * Session-scoped undo for speaker operations: a capped inverse-command stack
 * living in the `SPEAKER_HISTORY` flurryx slot.
 *
 * Each op carries everything needed to reverse it, captured from
 * `store.selectedMeeting()` BEFORE the forward mutation runs; the op is
 * pushed only after the backend confirms the mutation. Undo re-executes the
 * inverse through the EXISTING use cases (persisted, never optimistic) —
 * flurryx `undo()`/`restoreStoreAt` are deliberately NOT used: they rewind
 * UI messages only, while disk is the source of truth, so rewinding the
 * store alone would desync the two.
 *
 * KNOWN LIMITATION: the Angular domain model has no per-segment
 * `speaker_pinned` field (pins live only backend-side), so an inverse
 * restores labels/names only. The inverse `set_segment_speaker` calls
 * ALWAYS re-pin the segments they touch, so pin state is OVER-restored:
 * segments that were unpinned before the forward op come back pinned after
 * undo, and `relabel_others` skips pinned segments — diarization can never
 * re-claim them until the user manually unpins.
 */

import type { MeetingId } from '../../core/models/meeting.model';

/** Inverse of a `rename_speaker` op: restore (or clear, via `null`) `label`'s display name. */
export interface SpeakerRenameOp {
  readonly kind: 'rename';
  readonly meetingId: MeetingId;
  readonly label: string;
  readonly previousName: string | null;
}

/** One segment's speaker label as it was before a `remove_speaker` op. */
export interface SpeakerRemovedSegment {
  readonly index: number;
  readonly previousLabel: string;
}

/** Inverse of a `remove_speaker` op: restore the display name and every segment label the removal reset. */
export interface SpeakerRemoveOp {
  readonly kind: 'remove';
  readonly meetingId: MeetingId;
  readonly label: string;
  readonly previousName: string | null;
  readonly segments: readonly SpeakerRemovedSegment[];
}

/** Inverse of a `set_segment_speaker` op: put segment `index` back on `previousLabel`. */
export interface SpeakerReassignOp {
  readonly kind: 'reassign';
  readonly meetingId: MeetingId;
  readonly index: number;
  readonly previousLabel: string;
}

/**
 * Inverse of a batched `set_segment_speaker` op: restore every touched
 * segment's label. ACCEPTED asymmetry (see the file header): captures only
 * `previousLabel`, and the backend `set_segment_speaker` ALWAYS re-pins — so
 * undo restores labels but cannot un-pin; touched segments remain pinned
 * after undo and are skipped by future diarization relabels.
 */
export interface SpeakerReassignManyOp {
  readonly kind: 'reassign-many';
  readonly meetingId: MeetingId;
  readonly segments: readonly SpeakerRemovedSegment[];
}

export type SpeakerOp = SpeakerRenameOp | SpeakerRemoveOp | SpeakerReassignOp | SpeakerReassignManyOp;

/** Undo stack depth cap — the oldest ops fall off first. */
export const SPEAKER_HISTORY_CAP = 50;

/** Immutable push: appends `op`, dropping the oldest beyond {@link SPEAKER_HISTORY_CAP}. */
export const pushSpeakerOp = (history: readonly SpeakerOp[], op: SpeakerOp): readonly SpeakerOp[] =>
  [...history, op].slice(-SPEAKER_HISTORY_CAP);

/** Human label for the undo control, e.g. `Undo remove Jean`. */
export function describeSpeakerOp(op: SpeakerOp): string {
  switch (op.kind) {
    case 'rename':
      return `Undo rename of ${op.previousName ?? op.label}`;
    case 'remove':
      return `Undo remove ${op.previousName ?? op.label}`;
    case 'reassign':
      return `Undo speaker change (segment ${op.index + 1})`;
    case 'reassign-many':
      return `Undo speaker change (${op.segments.length} segments)`;
  }
}
