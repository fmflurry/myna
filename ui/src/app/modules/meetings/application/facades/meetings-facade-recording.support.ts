import type { MeetingId } from '../../core/models/meeting.model';
import type { RecorderPort } from '../../core/ports/recorder.port';
import type { TranscriberPort } from '../../core/ports/transcriber.port';
import type { MeetingsStore } from '../stores/meetings.store';
import type { CancelRecordingUseCase } from '../use-cases/cancel-recording.usecase';
import type { StartRecordingUseCase } from '../use-cases/start-recording.usecase';
import type { StopRecordingUseCase } from '../use-cases/stop-recording.usecase';
import { toErrorInfo } from './meetings-facade.support';

/**
 * Recording lifecycle flows for `MeetingsFacade`, extracted to keep the
 * facade class under the project's max-lines limit. Behavior is identical to
 * the inline bodies they replaced; never optimistic — the store only ever
 * reflects meetings the backend actually persisted.
 */

/** Starts a recording: resets the live transcript, then mirrors the created meeting into both read paths. */
export async function runStartRecording(
  store: MeetingsStore,
  startRecordingUseCase: StartRecordingUseCase,
  title: string,
  deviceName: string | undefined,
): Promise<void> {
  store.setStartingRecording(true);
  try {
    store.resetLiveTranscript();
    const meeting = await startRecordingUseCase.with(title, deviceName, store.captureSource(), store.selectedAudioSource());
    store.setSelectedMeeting(meeting);
    store.addMeeting(meeting);
    // Starting a recording switches the selection to a different meeting —
    // any captured speaker-op inverse now targets the wrong meeting; drop
    // the undo stack.
    store.setSpeakerHistory([]);
    store.clearError();
  } catch (caught) {
    store.setError(toErrorInfo(caught));
  } finally {
    store.setStartingRecording(false);
  }
}

/**
 * Stops the recording: `stop_recording` resolves with the finalized meeting
 * (duration + transcript + track flags), so the facade mirrors it into both
 * read paths the moment the stop settles — the sync Stop landing. The
 * `recording://completed` event does not exist on the backend, so waiting
 * for it would leave the start row (duration 0, no transcript) on screen.
 * The completed stream stays subscribed as a best-effort mirror; its upsert
 * filters by id, so a double landing is exactly-once, never a duplicate.
 */
export async function runStopRecording(store: MeetingsStore, stopRecordingUseCase: StopRecordingUseCase): Promise<void> {
  store.setRecordingState('stopping');
  try {
    const meeting = await stopRecordingUseCase.stop();
    store.setSelectedMeeting(meeting);
    store.addMeeting(meeting);
    // Stopping switches the selection to the finalized row — any captured
    // speaker-op inverse now targets the stale in-flight row; drop the undo
    // stack. Redundant with `setSelectedMeeting`'s own clear, kept to mirror
    // `runStartRecording`.
    store.setSpeakerHistory([]);
    store.clearError();
  } catch (caught) {
    store.setError(toErrorInfo(caught));
  }
}

/** Cancels the recording, dropping the cancelled meeting from the list and clearing the selection. */
export async function runCancelRecording(store: MeetingsStore, cancelRecordingUseCase: CancelRecordingUseCase): Promise<void> {
  const cancelled = store.selectedMeeting();
  try {
    await cancelRecordingUseCase.cancel();
    if (cancelled) {
      store.setMeetings(store.meetings().filter((meeting) => meeting.id !== cancelled.id));
    }
    store.clearSelectedMeeting();
    store.clearError();
  } catch (caught) {
    store.setError(toErrorInfo(caught));
  }
}

/**
 * Boot-time re-attach for an interrupted recording (ADR 0011): the store's
 * constructor already re-subscribes to every event, so all that was missing
 * is the *initial* state and the *past* finals — both recovered here from the
 * two query commands instead of relying on having caught the events.
 *
 * - `recording` → flip the state machine and publish the elapsed baseline,
 *   best-effort opening the meeting and replaying the durability journal
 *   first. `ACTIVE_RECORDING` is written BEFORE `RECORDING_STATE` so the
 *   shell's timer effect always sees a seeded baseline the moment it starts
 *   ticking. The open and the replay each run in their OWN try/catch: the
 *   Stop button and timer matter more than transcript replay or selection,
 *   so neither failure may gate the state flip — reproducing the
 *   no-Stop-button incident is the one outcome resume must never have.
 * - `stopping` → publish the slots only: the session is finalizing, so opening
 *   the meeting or seeding a transcript would fight the stop flow that is
 *   already in flight (its `recording://state` events take the UI to idle).
 * - `idle` (or a session that vanished mid-await) → no-op; events take over.
 *
 * Never rejects: a boot query that fails (e.g. the meeting dir was removed
 * while the webview was down) must not leave the app stuck on a spinner —
 * but every swallowed failure is logged, never silenced.
 */
export async function runResumeActiveRecording(
  store: MeetingsStore,
  recorder: RecorderPort,
  transcriber: TranscriberPort,
  openMeeting: (id: MeetingId) => Promise<void>,
): Promise<void> {
  try {
    const snapshot = await recorder.state();
    if (snapshot.state === 'idle' || snapshot.meetingId === null) {
      return;
    }
    const active = { meetingId: snapshot.meetingId, elapsedSec: snapshot.elapsedSec ?? 0 };
    if (snapshot.state === 'stopping') {
      store.setActiveRecording(active);
      store.setRecordingState('stopping');
      return;
    }
    try {
      await openMeeting(snapshot.meetingId);
    } catch (caught) {
      console.warn('resumeActiveRecording: openMeeting failed', caught);
    }
    try {
      // A session that stopped between the snapshot and this query resolves
      // to an empty transcript — seeding empty is correct, the live stream
      // owns finals from here.
      const live = await transcriber.liveTranscriptFor(snapshot.meetingId);
      store.seedFinalizedSegments(live.segments);
    } catch (caught) {
      console.warn('resumeActiveRecording: journal replay failed', caught);
    }
    store.setActiveRecording(active);
    store.setRecordingState('recording');
  } catch (caught) {
    // The snapshot query itself failed: there is no reliable state to
    // restore, so retire the slot rather than show a phantom session. Log
    // first — a silently swallowed boot failure is undiagnosable.
    console.warn('resumeActiveRecording failed', caught);
    store.clearActiveRecording();
  }
}
