import type { Observable } from 'rxjs';

import type { AudioDevice, AudioLevel } from '../models/audio-device.model';
import type { AudioSource } from '../models/audio-source.model';
import type { CaptureSource, SystemAudioStatus } from '../models/capture-source.model';
import type { Meeting } from '../models/meeting.model';
import type { RecordingState } from '../models/recording-state.model';

/**
 * Maps onto the frozen Rust command surface: list_input_devices,
 * default_input_device, list_audio_sources, start_recording, stop_recording,
 * cancel_recording, recording_state, system_audio_status,
 * request_system_audio_permission, plus the recording://state and
 * recording://level events.
 */
export abstract class RecorderPort {
  abstract start(
    title: string,
    deviceName?: string,
    source?: CaptureSource,
    systemSource?: string,
  ): Promise<Meeting>;
  abstract stop(): Promise<Meeting>;
  abstract cancel(): Promise<void>;
  abstract state(): Promise<RecordingState>;
  abstract levels(): Observable<AudioLevel>;
  abstract stateChanges(): Observable<RecordingState>;
  /**
   * The system audio source `recording://state` reports as ACTUALLY in
   * effect for the current/last recording — after any silent fallback
   * (permission denied, or a requested app that has since quit). `null`
   * whenever no system audio is being captured (e.g. microphone-only).
   */
  abstract effectiveSystemSourceChanges(): Observable<AudioSource | null>;
  abstract listDevices(): Promise<readonly AudioDevice[]>;
  abstract defaultDevice(): Promise<AudioDevice>;
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
