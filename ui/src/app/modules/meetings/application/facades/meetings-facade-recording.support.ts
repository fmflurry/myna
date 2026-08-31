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

/** Stops the recording and mirrors the finalized meeting into both read paths. */
export async function runStopRecording(store: MeetingsStore, stopRecordingUseCase: StopRecordingUseCase): Promise<void> {
  try {
    const meeting = await stopRecordingUseCase.stop();
    store.setSelectedMeeting(meeting);
    store.addMeeting(meeting);
    // Stopping selects the finalized meeting — drop any speaker-op inverse
    // captured against the previously selected meeting.
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
