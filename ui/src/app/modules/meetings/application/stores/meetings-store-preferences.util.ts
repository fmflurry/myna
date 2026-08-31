import { ALL_SYSTEM_AUDIO_SOURCE_ID } from '../../core/models/audio-source.model';
import type { CaptureSource } from '../../core/models/capture-source.model';

/** localStorage key the selected summary output language is persisted under. */
export const SUMMARY_LANGUAGE_PREFERENCE_KEY = 'meetings.summaryLanguage';

/** localStorage key the selected capture source is persisted under. */
export const CAPTURE_SOURCE_PREFERENCE_KEY = 'meetings.captureSource';

/** localStorage key the selected system-audio source is persisted under. */
export const AUDIO_SOURCE_PREFERENCE_KEY = 'meetings.audioSource';

/** localStorage key the selected microphone device NAME is persisted under ('' = default-sentinel). */
export const MIC_DEVICE_PREFERENCE_KEY = 'meetings.micDevice';

/**
 * The persisted mic-selection sentinel: storing `''` (and reading it back as
 * falsy) means "OS default" — `start_recording` is then called WITHOUT a
 * device and the backend resolves the default at record time. Lives here
 * (not on `MeetingsFacade`) because both the facade and the store persist
 * with it, and the store cannot import the facade without a cycle.
 */
export const DEFAULT_MIC_SENTINEL = '';

/** Capture source assumed when nothing has been stored yet: both mic and system audio. */
export const DEFAULT_CAPTURE_SOURCE: CaptureSource = 'mixed';

/** System-audio source assumed when nothing has been stored yet: all system output. */
export const DEFAULT_AUDIO_SOURCE_ID = ALL_SYSTEM_AUDIO_SOURCE_ID;

const VALID_CAPTURE_SOURCES: readonly CaptureSource[] = ['microphone', 'system', 'mixed'];

export const isCaptureSource = (value: string | null): value is CaptureSource =>
  value !== null && (VALID_CAPTURE_SOURCES as readonly string[]).includes(value);
