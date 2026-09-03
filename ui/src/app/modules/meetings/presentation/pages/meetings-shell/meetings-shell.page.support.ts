import type { Signal } from '@angular/core';
import { computed, signal } from '@angular/core';
import type { Router } from '@angular/router';

import { MeetingsFacade } from '../../../application/facades/meetings.facade';
import type { MeetingsErrorInfo } from '../../../application/stores/meetings.store';
import { describeSpeakerOp, type SpeakerOp } from '../../../application/stores/speaker-history.model';
import { describeTranscriptOp, type TranscriptOp } from '../../../application/stores/transcript-history.model';
import type { SystemAudioStatus } from '../../../core/models/capture-source.model';
import type { FolderId } from '../../../core/models/folder.model';
import type { Meeting, MeetingId } from '../../../core/models/meeting.model';
import type { ModelsStatus } from '../../../core/models/models-status.model';
import type { UpdateConsent } from '../../../core/models/update.model';
import type { MeetingDragMoveRequest } from '../../components/meeting-sidebar/meeting-sidebar.component';

/**
 * Shown to the capture-source-picker before `checkSystemAudio()` has
 * resolved. `unknown`, not `unavailable` — there is no preflight API for
 * the audio permission, so the system/mixed options must stay selectable
 * even during this brief window, not just once the check settles.
 */
export const CHECKING_SYSTEM_AUDIO: SystemAudioStatus = { kind: 'unknown' };

const ISO_DATE_LENGTH = 10;

/** `"<title> - <YYYY-MM-DD>"` — the suggested file name the export dialog offers. */
export const buildExportFilename = (meeting: Meeting): string =>
  `${meeting.title} - ${meeting.createdAt.toISOString().slice(0, ISO_DATE_LENGTH)}`;

/** The meeting's CURRENT folder (or `null`), looked up from `meetings` — used to preserve filing when archiving. */
function currentFolderId(meetings: readonly Meeting[], id: MeetingId): FolderId | null {
  return meetings.find((meeting) => meeting.id === id)?.folderId ?? null;
}

/**
 * Drag-and-drop is the only way to move or archive a meeting — this is the
 * sole handler for both; it routes by the drop target's `kind`, always via
 * `facade.placeMeeting` with `previousId`/`nextId` both `null` (the backend
 * resolves that to `Placement::Keep` — container change only, matching
 * today's behaviour but as one write instead of two). Archiving preserves
 * the meeting's CURRENT folder — looked up from `meetings` — so a meeting
 * dragged to the archive never loses its filing.
 */
export function runMeetingMoveRequested(facade: MeetingsFacade, meetings: readonly Meeting[], request: MeetingDragMoveRequest): void {
  const { target } = request;
  if (target.kind === 'placement') {
    const { container, previousId, nextId } = target;
    if (container.kind === 'archive') {
      void facade.placeMeeting(request.id, currentFolderId(meetings, request.id), true, previousId, nextId);
      return;
    }
    const folderId = container.kind === 'folder' ? container.folderId : null;
    void facade.placeMeeting(request.id, folderId, false, previousId, nextId);
    return;
  }
  if (target.kind === 'archive') {
    void facade.placeMeeting(request.id, currentFolderId(meetings, request.id), true, null, null);
    return;
  }
  const folderId = target.kind === 'folder' ? target.folderId : null;
  void facade.placeMeeting(request.id, folderId, false, null, null);
}

/**
 * There is no finished recording session on disk to stop first —
 * `cancelRecording()` stops the session and wipes the meeting dir, including
 * audio.wav, instead of `deleteMeeting()`.
 */
export function runMeetingDeleted(facade: MeetingsFacade, router: Router, id: MeetingId): void {
  if (facade.busy() && facade.selectedMeeting()?.id === id) {
    void facade.cancelRecording().then(() => router.navigate(['/meetings']));
    return;
  }
  void facade.deleteMeeting(id).then(() => {
    if (facade.selectedMeeting() === undefined) {
      void router.navigate(['/meetings']);
    }
  });
}

/**
 * Wired to the detail pane's `retryRequested`, which is emitted from the
 * hoisted error banner regardless of which pane is showing — not just the
 * meeting-selected detail branch. With a meeting selected, "retry" means
 * re-opening it. With no meeting selected (e.g. an import rejected before
 * any placeholder meeting was created — see meeting-detail-pane.component.html),
 * re-opening is impossible, so retry instead just dismisses the error so the
 * user can try again from a clean state.
 */
export function runErrorRetry(facade: MeetingsFacade): void {
  const current = facade.selectedMeeting();
  if (current) {
    void facade.openMeeting(current.id);
  } else {
    facade.clearError();
  }
}

/**
 * Label for the transcript toolbar's Undo button — the standing
 * `TRANSCRIPT_UNDO` slot rendered via `describeTranscriptOp`, or `null` when
 * nothing structural is undoable (button hidden).
 */
export const describeLatestTranscriptUndo = (op: TranscriptOp | null): string | null =>
  op === null ? null : describeTranscriptOp(op);

/**
 * Label for the speaker toolbar's Undo button — the TOP of the
 * `SPEAKER_HISTORY` stack rendered via `describeSpeakerOp` (undo pops the
 * top), or `null` when the stack is empty (button hidden).
 */
export function describeLatestSpeakerUndo(history: readonly SpeakerOp[]): string | null {
  const op = history.at(-1);
  return op === undefined ? null : describeSpeakerOp(op);
}

/**
 * Auto-diarize gate run once after `stopRecording` settles: only when the
 * stop landed cleanly (`error` slot empty), the meeting actually has a
 * `track-system.wav` (the backend answers NotFound without one — a mic-only
 * recording must never trigger), and the diarization models are on disk.
 * Manual corrections survive the relabel backend-side
 * (crates/myna-stt/src/relabel.rs:64), so pinned segments need no UI guard.
 */
export const shouldAutoDiarizeAfterStop = (
  error: MeetingsErrorInfo | undefined,
  meeting: Meeting | undefined,
  modelsStatus: ModelsStatus | undefined,
): boolean =>
  error === undefined && meeting?.hasSystemTrack === true && modelsStatus?.diarization?.present === true;

/**
 * Stops the recording, then auto-runs speaker detection when the finished
 * meeting can actually be diarized. `onDiarize` is the shell's manual
 * `onDiarizeRequested` handler, so the in-flight guard and error surfacing
 * are identical to the "Detect speakers" button.
 */
export async function runStopRecording(facade: MeetingsFacade, onDiarize: () => void): Promise<void> {
  await facade.stopRecording();
  if (shouldAutoDiarizeAfterStop(facade.error(), facade.selectedMeeting(), facade.modelsStatus())) {
    onDiarize();
  }
}

/** Loads the persisted consent on every launch; a `'granted'` result immediately runs a throttled, non-blocking check. */
export async function loadUpdatesOnLaunch(facade: MeetingsFacade): Promise<void> {
  await facade.updates.loadConsent();
  if (facade.updates.consent() === 'granted') {
    void facade.updates.checkForUpdate(false);
  }
}

/** Every update-check template binding the shell needs, grouped behind one field to keep `MeetingsShellPage` under the max-lines cap. */
export interface UpdateHandlers {
  /** First-run (and every-launch-until-decided) consent-modal visibility; suppressed while `busy()` too. */
  readonly visible: Signal<boolean>;
  readonly onGranted: () => void;
  readonly onDeclined: () => void;
  readonly onPostponed: () => void;
  readonly onConsentChanged: (consent: UpdateConsent) => void;
  readonly onCheckNow: () => void;
  readonly onBannerDismissed: () => void;
  /** Kicks the facade's never-throwing install state machine (banner [Update] / [Retry]). */
  readonly onUpdate: () => void;
  /** Applies a ready update; a rejected `restart_app` lands in {@link restartError} instead of throwing. */
  readonly onRestart: () => void;
  /** Message from the last rejected restart, shown by the banner in the ready state; `null` hides it. */
  readonly restartError: Signal<string | null>;
}

/** Builds {@link UpdateHandlers} bound to `facade`. "Turn on update checks" persists consent THEN immediately runs the first check; the settings toggle and × / Esc never check. */
export function createUpdateHandlers(facade: MeetingsFacade): UpdateHandlers {
  const restartError = signal<string | null>(null);
  return {
    visible: computed(() => facade.updates.consent() === 'unset' && !facade.busy()),
    onGranted: () => {
      void facade.updates.grantConsent().then(() => facade.updates.checkForUpdate(false));
    },
    onDeclined: () => void facade.updates.declineConsent(),
    onPostponed: () => undefined,
    onConsentChanged: (consent) => {
      if (consent === 'granted') {
        void facade.updates.grantConsent();
      } else {
        void facade.updates.declineConsent();
      }
    },
    onCheckNow: () => void facade.updates.checkForUpdate(true),
    onBannerDismissed: () => facade.updates.dismissBanner(),
    onUpdate: () => void facade.updates.installUpdate(),
    onRestart: () => {
      restartError.set(null);
      facade.updates.restartApp().catch((caught: unknown) => {
        restartError.set(caught instanceof Error ? caught.message : String(caught));
      });
    },
    restartError: restartError.asReadonly(),
  };
}

/**
 * Serialises backend meeting mutations. Speaker handlers can fire in the
 * same synchronous tick — a New-speaker commit emits reassign THEN rename —
 * and every op is an unlocked read-modify-write of meeting.json on the Rust
 * side, so overlapping them loses a write. An op arriving while the queue is
 * idle is dispatched IMMEDIATELY (single-op callers keep their synchronous
 * dispatch); later ops chain behind the in-flight one. Facade ops never
 * reject (errors land in the store's ERROR slot), but rejections are
 * swallowed anyway so no future rejecting path can wedge the chain.
 */
export class MeetingOpQueue {
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;

  /** Queues `run` against `meeting` — a no-op when nothing is selected. */
  enqueue(meeting: Meeting | undefined, run: (id: MeetingId) => Promise<void>): void {
    if (meeting === undefined) {
      return;
    }
    this.queued += 1;
    this.tail = this.queued === 1
      ? run(meeting.id).catch(() => undefined)
      : this.tail.then(() => run(meeting.id)).catch(() => undefined);
    void this.tail.then(() => {
      this.queued -= 1;
    });
  }
}
