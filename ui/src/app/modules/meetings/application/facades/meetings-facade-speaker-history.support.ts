import type { Meeting, MeetingId } from '../../core/models/meeting.model';
import type { MeetingsStore } from '../stores/meetings.store';
import {
  pushSpeakerOp,
  type SpeakerOp,
  type SpeakerReassignOp,
  type SpeakerRemoveOp,
  type SpeakerRenameOp,
} from '../stores/speaker-history.model';
import type { RemoveSpeakerUseCase } from '../use-cases/remove-speaker.usecase';
import type { RenameSpeakerUseCase } from '../use-cases/rename-speaker.usecase';
import type { SetSegmentSpeakerUseCase } from '../use-cases/set-segment-speaker.usecase';
import { toErrorInfo } from './meetings-facade.support';

/**
 * Speaker-operation undo plumbing for `MeetingsFacade`, kept out of the
 * facade class to stay under the project's max-lines limit. The inverse of
 * each op is captured from `store.selectedMeeting()` BEFORE the forward
 * mutation and pushed onto `SPEAKER_HISTORY` only after the backend confirms
 * — see `speaker-history.model.ts` for the stack's contract.
 */

/** Captures the rename inverse for `label`, or `null` when `meeting` is not the one being mutated. */
function captureRenameInverse(meeting: Meeting | undefined, id: MeetingId, label: string): SpeakerRenameOp | null {
  if (meeting?.id !== id) {
    return null;
  }
  return { kind: 'rename', meetingId: id, label, previousName: meeting.speakerNames?.[label] ?? null };
}

/** Captures the remove inverse: the label's name plus every segment currently carrying it. */
function captureRemoveInverse(meeting: Meeting | undefined, id: MeetingId, label: string): SpeakerRemoveOp | null {
  if (meeting?.id !== id) {
    return null;
  }
  return {
    kind: 'remove',
    meetingId: id,
    label,
    previousName: meeting.speakerNames?.[label] ?? null,
    segments: (meeting.transcript?.segments ?? [])
      .map((segment, index) => ({ index, previousLabel: segment.speaker }))
      .filter((entry) => entry.previousLabel === label),
  };
}

/** Captures the reassign inverse for segment `index`, or `null` when it has no current label to restore. */
function captureReassignInverse(meeting: Meeting | undefined, id: MeetingId, index: number): SpeakerReassignOp | null {
  const previousLabel = meeting?.id === id ? meeting.transcript?.segments[index]?.speaker : undefined;
  return previousLabel === undefined ? null : { kind: 'reassign', meetingId: id, index, previousLabel };
}

/** Runs a persisted speaker mutation, pushing its captured inverse only after the backend confirms. Never optimistic. */
async function runSpeakerMutation(store: MeetingsStore, mutate: () => Promise<Meeting>, op: SpeakerOp | null): Promise<void> {
  try {
    store.updateMeeting(await mutate());
    if (op !== null) {
      store.setSpeakerHistory(pushSpeakerOp(store.speakerHistory(), op));
    }
    store.clearError();
  } catch (caught) {
    store.setError(toErrorInfo(caught));
  }
}

/** Renames a speaker AND records the rename's inverse once the backend confirms. */
export async function runRenameSpeakerWithHistory(
  store: MeetingsStore,
  renameSpeakerUseCase: RenameSpeakerUseCase,
  id: MeetingId,
  label: string,
  name: string,
): Promise<void> {
  const inverse = captureRenameInverse(store.selectedMeeting(), id, label);
  await runSpeakerMutation(store, () => renameSpeakerUseCase.rename(id, label, name), inverse);
}

/** Removes a speaker AND records the removal's inverse once the backend confirms. */
export async function runRemoveSpeakerWithHistory(
  store: MeetingsStore,
  removeSpeakerUseCase: RemoveSpeakerUseCase,
  id: MeetingId,
  label: string,
): Promise<void> {
  const inverse = captureRemoveInverse(store.selectedMeeting(), id, label);
  await runSpeakerMutation(store, () => removeSpeakerUseCase.remove(id, label), inverse);
}

/** Reassigns one segment's speaker AND records the reassign's inverse once the backend confirms. */
export async function runSetSegmentSpeakerWithHistory(
  store: MeetingsStore,
  setSegmentSpeakerUseCase: SetSegmentSpeakerUseCase,
  id: MeetingId,
  index: number,
  speaker: string,
): Promise<void> {
  const inverse = captureReassignInverse(store.selectedMeeting(), id, index);
  await runSpeakerMutation(store, () => setSegmentSpeakerUseCase.set(id, index, speaker), inverse);
}

/**
 * Pops and executes the last speaker op's inverse through the existing use
 * cases (persisted, never optimistic). The op is dropped BEFORE the inverse
 * runs: a failed undo surfaces through the ERROR slot and is never retried
 * silently. For a remove, every segment label is restored first, then the
 * display name — each step mirroring its persisted meeting so the store
 * never diverges from disk.
 */
export async function runUndoLastSpeakerOp(
  store: MeetingsStore,
  renameSpeakerUseCase: RenameSpeakerUseCase,
  removeSpeakerUseCase: RemoveSpeakerUseCase,
  setSegmentSpeakerUseCase: SetSegmentSpeakerUseCase,
): Promise<void> {
  const history = store.speakerHistory();
  const op = history.at(-1);
  const meeting = store.selectedMeeting();
  if (!op || !meeting) {
    return;
  }
  store.setSpeakerHistory(history.slice(0, -1));
  if (op.meetingId !== meeting.id) {
    // Stale op captured against a different meeting (selection changed
    // without clearing the stack): drop it WITHOUT executing — applying
    // meeting A's inverses to meeting B would corrupt B's speakers.
    return;
  }
  const id = meeting.id;
  try {
    if (op.kind === 'rename') {
      // An empty name clears the entry, mirroring `renameSpeaker`'s contract.
      store.updateMeeting(await renameSpeakerUseCase.rename(id, op.label, op.previousName ?? ''));
    } else if (op.kind === 'reassign') {
      store.updateMeeting(await setSegmentSpeakerUseCase.set(id, op.index, op.previousLabel));
    } else {
      for (const segment of op.segments) {
        store.updateMeeting(await setSegmentSpeakerUseCase.set(id, segment.index, segment.previousLabel));
      }
      if (op.previousName !== null) {
        store.updateMeeting(await renameSpeakerUseCase.rename(id, op.label, op.previousName));
      }
    }
    store.clearError();
  } catch (caught) {
    store.setError(toErrorInfo(caught));
  }
}
