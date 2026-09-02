import type { AudioDevice, AudioLevel } from '../../core/models/audio-device.model';
import type { AudioSource } from '../../core/models/audio-source.model';
import type { CaptureSource, SystemAudioStatus } from '../../core/models/capture-source.model';
import type { Folder, FolderId } from '../../core/models/folder.model';
import type { Meeting, MeetingId } from '../../core/models/meeting.model';
import type { ModelsStatus } from '../../core/models/models-status.model';
import type { MeetingsErrorCode, RecordingState } from '../../core/models/recording-state.model';
import type { SummaryLanguage } from '../../core/models/summary-language.model';
import type { SummaryTemplate } from '../../core/models/summary-template.model';
import type { TranscriptSegment } from '../../core/models/transcript.model';
import type { ImportProgress } from '../../core/ports/audio-import.port';
import type { SummaryCacheEntry } from './summary-cache.model';
import type { SummarizingKey } from './summarizing-key.model';
import type { SpeakerOp } from './speaker-history.model';
import type { TranscriptOp } from './transcript-history.model';

export interface MeetingsErrorInfo {
  readonly code: MeetingsErrorCode;
  readonly message: string;
}

/**
 * A live recording session re-discovered at boot (or observed via
 * `recording://state`). `elapsedSec` is the running clock the backend reported
 * when the session was queried, so the UI can seed its timer from the true
 * offset rather than `0`.
 */
export interface ActiveRecording {
  readonly meetingId: MeetingId;
  readonly elapsedSec: number;
}

/** Lifecycle of the in-app model download driven by `start_model_download`. */
export type ModelDownloadPhase = 'idle' | 'running' | 'failed' | 'done';

/**
 * Read model of the in-app model download, fed by the `models://progress` /
 * `models://done` events. `artifact`/`index`/`total` are meaningful only
 * while `phase` is `'running'` (or `'failed'`, where `index` names the
 * artifact that failed); `success`/`cancelled`/`message` are meaningful
 * only once a `models://done` event has landed.
 */
export interface ModelDownloadState {
  readonly phase: ModelDownloadPhase;
  /** Script selector of the artifact currently downloading (or failed). */
  readonly artifact: string | null;
  /** Zero-based position of `artifact` in the run's artifact list. */
  readonly index: number;
  /** Total number of artifacts in the run. */
  readonly total: number;
  readonly success: boolean;
  readonly cancelled: boolean;
  readonly message: string | null;
}

/** The store's resting state before the first download run of the session. */
export const IDLE_MODEL_DOWNLOAD: ModelDownloadState = {
  phase: 'idle',
  artifact: null,
  index: 0,
  total: 0,
  success: false,
  cancelled: false,
  message: null,
};

export interface MeetingsStoreConfig {
  MEETINGS: readonly Meeting[];
  SELECTED_MEETING: Meeting;
  RECORDING_STATE: RecordingState;
  /**
   * The live recording session re-discovered at boot via the `recording_state`
   * command (ADR 0011). `null` whenever no session is being restored. Carries
   * the elapsed-seconds baseline so a reloaded webview's timer resumes from the
   * true offset instead of restarting at `00:00`.
   */
  ACTIVE_RECORDING: ActiveRecording | null;
  FINALIZED_SEGMENTS: readonly TranscriptSegment[];
  PARTIAL_TEXT_ME: string;
  PARTIAL_TEXT_OTHERS: string;
  LEVEL: AudioLevel;
  TEMPLATES: readonly SummaryTemplate[];
  MODELS_STATUS: ModelsStatus;
  MODEL_DOWNLOAD: ModelDownloadState;
  SUMMARY_STREAM: string;
  ERROR: MeetingsErrorInfo;
  DEVICES: readonly AudioDevice[];
  SELECTED_DEVICE: AudioDevice | null;
  DEFAULT_DEVICE: AudioDevice | null;
  OUTPUT_DEVICES: readonly AudioDevice[];
  DEFAULT_OUTPUT_DEVICE: AudioDevice | null;
  SUMMARIZING_KEY: SummarizingKey | null;
  STARTING_RECORDING: boolean;
  SYSTEM_AUDIO_STATUS: SystemAudioStatus;
  CAPTURE_SOURCE: CaptureSource;
  SUMMARY_LANGUAGES: readonly SummaryLanguage[];
  SELECTED_SUMMARY_LANGUAGE: string;
  SUMMARY_CACHE: ReadonlyMap<string, SummaryCacheEntry>;
  APP_VERSION: string;
  AUDIO_SOURCES: readonly AudioSource[];
  SELECTED_AUDIO_SOURCE: string;
  EFFECTIVE_SYSTEM_SOURCE: AudioSource | null;
  SPLIT_RATIO: number;
  TRANSCRIPT_COLLAPSED: boolean;
  IMPORTING: boolean;
  IMPORT_PROGRESS: ImportProgress | null;
  FOLDERS: readonly Folder[];
  EXPANDED_FOLDERS: ReadonlySet<FolderId>;
  /** Session-scoped inverse-command stack for speaker ops — see `speaker-history.model.ts`. */
  SPEAKER_HISTORY: readonly SpeakerOp[];
  /** Session-scoped single-slot inverse for the last transcript structural op — see `transcript-history.model.ts`. */
  TRANSCRIPT_UNDO: TranscriptOp | null;
}
