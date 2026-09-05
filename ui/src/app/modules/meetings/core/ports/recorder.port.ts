import type { Observable } from 'rxjs';

import type { AudioDevice, AudioLevel } from '../models/audio-device.model';
import type { AudioSource } from '../models/audio-source.model';
import type { CaptureSource, SystemAudioStatus } from '../models/capture-source.model';
import type { Meeting, MeetingId } from '../models/meeting.model';
import type { RecordingHealthEvent, StopAcknowledgement, StopPhase } from '../models/recording-lifecycle.model';
import type { RecordingState } from '../models/recording-state.model';

/**
 * A point-in-time snapshot of the recorder, read from the `recording_state`
 * command. Carries more than the bare state machine: the active meeting id
 * and the elapsed-seconds clock, so a reloaded webview can re-derive "am I
 * mid-recording, of which meeting, for how long" from a single query — the
 * query half of the session-resilience contract (ADR 0011), never reliant
 * on having caught the events.
 */
export interface RecordingSnapshot {
  readonly state: RecordingState;
  readonly meetingId: MeetingId | null;
  readonly elapsedSec: number | null;
}

/**
 * Maps onto the Rust command surface: list_input_devices,
 * default_input_device, list_audio_sources, start_recording, stop_recording,
 * cancel_recording, recording_state, system_audio_status,
 * request_system_audio_permission, plus the recording://state,
 * recording://level, recording://stop-progress, recording://completed and
 * recording://health events.
 */
export abstract class RecorderPort {
  abstract start(
    title: string,
    deviceName?: string,
    source?: CaptureSource,
    systemSource?: string,
  ): Promise<Meeting>;
  /**
   * Requests the stop. The Tauri backend resolves with the finalized meeting
   * (duration + transcript + track flags) — the facade mirrors it into the
   * store the moment the stop settles (the sync Stop landing). The
   * `recording://completed` event does not exist on the backend; the
   * {@link completedMeetings} stream is retained only as a best-effort
   * mirror whose upsert filters by id (exactly-once on double landing).
   */
  abstract stop(): Promise<Meeting>;
  /** Requests the discard; resolves with the acknowledgement the backend accepts it with. */
  abstract cancel(): Promise<StopAcknowledgement>;
  abstract state(): Promise<RecordingSnapshot>;
  abstract levels(): Observable<AudioLevel>;
  abstract stateChanges(): Observable<RecordingState>;
  /**
   * Fine-grained progress of an in-flight stop/cancel, from `recording://stop-progress`.
   * Lets the UI render phase-specific text instead of one generic label.
   */
  abstract stopProgressChanges(): Observable<StopPhase>;
  /**
   * The durable, finalized meeting from `recording://completed` — the ONLY
   * event that may end the 'stopping' state and publish the finished row.
   */
  abstract completedMeetings(): Observable<Meeting>;
  /**
   * Mid-recording durability warnings/errors from `recording://health`
   * (WAV writes, journal writes, decode drops, tap rebuilds, disk pressure).
   */
  abstract healthChanges(): Observable<RecordingHealthEvent>;
  /**
   * The system audio source `recording://state` reports as ACTUALLY in
   * effect for the current/last recording — after any silent fallback
   * (permission denied, or a requested app that has since quit). `null`
   * whenever no system audio is being captured (e.g. microphone-only).
   */
  abstract effectiveSystemSourceChanges(): Observable<AudioSource | null>;
  abstract listDevices(): Promise<readonly AudioDevice[]>;
  abstract defaultDevice(): Promise<AudioDevice>;
  /** All available audio OUTPUT devices, for the "plays through" indicator; never used to select a capture device. */
  abstract listOutputDevices(): Promise<readonly AudioDevice[]>;
  abstract defaultOutputDevice(): Promise<AudioDevice>;
  /**
   * All capturable system-audio sources: always led by the all-output
   * source (`system:all`), followed by one entry per running application.
   */
  abstract listAudioSources(): Promise<readonly AudioSource[]>;
  /** Whether system-audio capture is available in the current process. */
  abstract systemAudioStatus(): Promise<SystemAudioStatus>;
  /**
   * Prompts the OS permission dialog. macOS caches the result for the
   * lifetime of the process, so a `permission_denied` response with
   * `restartRequired: true` can only ever resolve to `available` after the
   * app is relaunched — never by re-polling within the same session.
   */
  abstract requestSystemAudioPermission(): Promise<SystemAudioStatus>;
}
