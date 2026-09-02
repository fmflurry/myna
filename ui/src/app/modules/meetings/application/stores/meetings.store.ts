import { Injectable, computed, inject, type InjectionToken, type Signal } from '@angular/core';
import { Store } from 'flurryx';

import type { AudioDevice, AudioLevel } from '../../core/models/audio-device.model';
import type { AudioSource } from '../../core/models/audio-source.model';
import type { CaptureSource, SystemAudioStatus } from '../../core/models/capture-source.model';
import type { Folder, FolderId } from '../../core/models/folder.model';
import type { Meeting, MeetingId } from '../../core/models/meeting.model';
import type { ModelsStatus } from '../../core/models/models-status.model';
import type { MeetingsErrorCode, RecordingState } from '../../core/models/recording-state.model';
import { DEFAULT_SPLIT_RATIO } from '../../core/models/split-layout.model';
import { DEFAULT_SUMMARY_LANGUAGE_CODE, type SummaryLanguage } from '../../core/models/summary-language.model';
import type { Summary } from '../../core/models/summary.model';
import type { SummaryTemplate } from '../../core/models/summary-template.model';
import type { TranscriptSegment } from '../../core/models/transcript.model';
import { AudioImportPort, type ImportProgress } from '../../core/ports/audio-import.port';
import { PreferencesPort } from '../../core/ports/preferences.port';
import { RecorderPort } from '../../core/ports/recorder.port';
import { SummarizerPort } from '../../core/ports/summarizer.port';
import { TranscriberPort } from '../../core/ports/transcriber.port';
import {
  EXPANDED_FOLDERS_PREFERENCE_KEY,
  storeExpandedFolders,
  withFolderAdded,
  withFolderRemoved,
  withFolderUpdated,
  withoutFolderId,
  withToggledFolderId,
} from './expanded-folders-preferences.util';
import { storeSplitRatio, storeTranscriptCollapsed } from './split-layout-preferences.util';
import { applySummaryContentUpdate, subscribeToAudioImportEvents } from './meetings.store.support';
import { IDLE_MODEL_DOWNLOAD, type ActiveRecording, type MeetingsStoreConfig, type ModelDownloadState } from './meetings-store-config.model';
import {
  AUDIO_SOURCE_PREFERENCE_KEY,
  CAPTURE_SOURCE_PREFERENCE_KEY,
  DEFAULT_AUDIO_SOURCE_ID,
  DEFAULT_CAPTURE_SOURCE,
  DEFAULT_MIC_SENTINEL,
  MIC_DEVICE_PREFERENCE_KEY,
  SUMMARY_LANGUAGE_PREFERENCE_KEY,
} from './meetings-store-preferences.util';
import { applySummaryCacheLoading, applySummaryCacheResult, readSummaryCacheEntry, removeSummaryCacheEntry } from './meetings-store-summary-cache.support';
import { mergeFinalizedSegments, seedPersistedPreferences, wireRecorderAndTranscriberEvents } from './meetings-store-wiring.support';
import { summaryCacheKey } from './summary-cache.model';
import type { SummaryCacheEntry, SummaryCacheStatus } from './summary-cache.model';
import type { SummarizingKey } from './summarizing-key.model';
import type { SpeakerOp } from './speaker-history.model';
import type { TranscriptOp } from './transcript-history.model';

export type { SummarizingKey };
export type { SummaryCacheEntry, SummaryCacheStatus };
export { summaryCacheKey };
export { SPLIT_RATIO_PREFERENCE_KEY, TRANSCRIPT_COLLAPSED_PREFERENCE_KEY } from './split-layout-preferences.util';
export { EXPANDED_FOLDERS_PREFERENCE_KEY };
export { PARTIAL_UI_AUDIT_MS } from './meetings-store-wiring.support';
export { IDLE_MODEL_DOWNLOAD, type ActiveRecording, type ModelDownloadState } from './meetings-store-config.model';
export { AUDIO_SOURCE_PREFERENCE_KEY, CAPTURE_SOURCE_PREFERENCE_KEY, MIC_DEVICE_PREFERENCE_KEY, SUMMARY_LANGUAGE_PREFERENCE_KEY } from './meetings-store-preferences.util';

export interface MeetingsErrorInfo {
  readonly code: MeetingsErrorCode;
  readonly message: string;
  /**
   * Which facade operation produced this error (e.g. `'checkModels'`).
   * `guarded()` only clears an error on success when the sources match (or
   * the error carries none), so a rejected boot call's error survives a
   * later unrelated success instead of silently vanishing — the swallowed
   * race that left onboarding stuck on "Checking installed models…".
   * Errors set outside `guarded()` (recording, backend pushes) stay
   * source-less and keep the legacy any-success-clears behavior.
   */
  readonly source?: string;
}

/** Underlying flurryx signal slots. The token itself is module-private; only the injected instance TYPE is shared, with `meetings-store-wiring.support.ts`. */
const MeetingsStoreSlots = Store.for<MeetingsStoreConfig>().build();
type ExtractInjected<T> = T extends InjectionToken<infer V> ? V : never;
export type MeetingsSlots = ExtractInjected<typeof MeetingsStoreSlots>;

/**
 * Bridges RecorderPort / TranscriberPort / SummarizerPort observables into
 * flurryx signal slots, and exposes the read model consumed by MeetingsFacade.
 * Only ever writes NEW objects into slots — never mutates existing state.
 */
@Injectable()
export class MeetingsStore {
  private readonly slots = inject(MeetingsStoreSlots);
  private readonly recorder = inject(RecorderPort);
  private readonly transcriber = inject(TranscriberPort);
  private readonly summarizer = inject(SummarizerPort);
  /** Optional: some specs predate this port; `provideMeetings()` always binds it for real use. */
  private readonly audioImport = inject(AudioImportPort, { optional: true });
  private readonly preferences = inject(PreferencesPort);

  readonly meetings: Signal<readonly Meeting[]> = computed(() => this.slots.get('MEETINGS')().data ?? []);
  readonly selectedMeeting: Signal<Meeting | undefined> = computed(() => this.slots.get('SELECTED_MEETING')().data);
  readonly recordingState: Signal<RecordingState> = computed(() => this.slots.get('RECORDING_STATE')().data ?? 'idle');
  /** Live session re-discovered at boot via `recording_state` (ADR 0011); `null` once the session goes idle. Carries the elapsed baseline the shell's timer seeds from. */
  readonly activeRecording: Signal<ActiveRecording | null> = computed(() => this.slots.get('ACTIVE_RECORDING')().data ?? null);
  /** Finalized segments only ever append; the partial is transient and clears once a final arrives (see `finals()` below). */
  readonly finalizedSegments: Signal<readonly TranscriptSegment[]> = computed(() => this.slots.get('FINALIZED_SEGMENTS')().data ?? []);
  /** Live partial text spoken by the local participant ("me"). Last-value-wins, bounded to one slot. */
  readonly partialTextMe: Signal<string> = computed(() => this.slots.get('PARTIAL_TEXT_ME')().data ?? '');
  /** Live partial text spoken by any other participant. Sub-identities (e.g. `others:2`) collapse into this single slot until diarization ships. */
  readonly partialTextOthers: Signal<string> = computed(() => this.slots.get('PARTIAL_TEXT_OTHERS')().data ?? '');
  readonly level: Signal<AudioLevel | undefined> = computed(() => this.slots.get('LEVEL')().data);
  readonly templates: Signal<readonly SummaryTemplate[]> = computed(() => this.slots.get('TEMPLATES')().data ?? []);
  readonly modelsStatus: Signal<ModelsStatus | undefined> = computed(() => this.slots.get('MODELS_STATUS')().data);
  readonly summaryStream: Signal<string> = computed(() => this.slots.get('SUMMARY_STREAM')().data ?? '');
  readonly error: Signal<MeetingsErrorInfo | undefined> = computed(() => this.slots.get('ERROR')().data);
  readonly busy: Signal<boolean> = computed(() => this.recordingState() !== 'idle');
  readonly devices: Signal<readonly AudioDevice[]> = computed(() => this.slots.get('DEVICES')().data ?? []);
  readonly selectedDevice: Signal<AudioDevice | null> = computed(() => this.slots.get('SELECTED_DEVICE')().data ?? null);
  readonly summarizingKey: Signal<SummarizingKey | null> = computed(() => this.slots.get('SUMMARIZING_KEY')().data ?? null);
  /** True while ANYTHING is generating; scope to ONE tab via `summarizingKey` instead. */
  readonly summarizing: Signal<boolean> = computed(() => this.summarizingKey() !== null);
  /** True while the STT model loads after a Record click, before `recordingState` leaves `'idle'`. */
  readonly startingRecording: Signal<boolean> = computed(() => this.slots.get('STARTING_RECORDING')().data ?? false);
  readonly systemAudioStatus: Signal<SystemAudioStatus | undefined> = computed(() => this.slots.get('SYSTEM_AUDIO_STATUS')().data);
  /** The source the user has selected for the NEXT recording. Defaults to both mic and system audio. */
  readonly captureSource: Signal<CaptureSource> = computed(() => this.slots.get('CAPTURE_SOURCE')().data ?? DEFAULT_CAPTURE_SOURCE);
  readonly summaryLanguages: Signal<readonly SummaryLanguage[]> = computed(() => this.slots.get('SUMMARY_LANGUAGES')().data ?? []);
  /**
   * The language the NEXT summary generation should use. Seeded once from
   * `PreferencesPort` at construction time so it survives a store rebuild
   * (e.g. app relaunch, or a fresh injector in tests sharing the same
   * preferences backend) — never re-read on every access.
   */
  readonly selectedSummaryLanguage: Signal<string> = computed(() => this.slots.get('SELECTED_SUMMARY_LANGUAGE')().data ?? DEFAULT_SUMMARY_LANGUAGE_CODE);
  /** Per-(meeting, template, language) load state for persisted summaries fetched via `get_summary`. */
  readonly summaryCache: Signal<ReadonlyMap<string, SummaryCacheEntry>> = computed(() => this.slots.get('SUMMARY_CACHE')().data ?? new Map());
  readonly appVersion: Signal<string | undefined> = computed(() => this.slots.get('APP_VERSION')().data);
  readonly audioSources: Signal<readonly AudioSource[]> = computed(() => this.slots.get('AUDIO_SOURCES')().data ?? []);
  /** The system-audio source the user has selected for the NEXT recording. Defaults to all system output. */
  readonly selectedAudioSource: Signal<string> = computed(() => this.slots.get('SELECTED_AUDIO_SOURCE')().data ?? DEFAULT_AUDIO_SOURCE_ID);
  /** The system-audio source ACTUALLY in effect (post-fallback), per `recording://state`. */
  readonly effectiveSystemSource: Signal<AudioSource | null> = computed(() => this.slots.get('EFFECTIVE_SYSTEM_SOURCE')().data ?? null);
  /** Fraction of the two-column workspace the transcript column occupies. Seeded from `PreferencesPort`. */
  readonly splitRatio: Signal<number> = computed(() => this.slots.get('SPLIT_RATIO')().data ?? DEFAULT_SPLIT_RATIO);
  /** Whether the transcript column is collapsed to its reopen rail. Seeded from `PreferencesPort`. */
  readonly transcriptCollapsed: Signal<boolean> = computed(() => this.slots.get('TRANSCRIPT_COLLAPSED')().data ?? false);
  /** True while an audio import or re-transcribe is running. */
  readonly importing: Signal<boolean> = computed(() => this.slots.get('IMPORTING')().data ?? false);
  /** Latest `import://progress` event for the in-flight import/re-transcribe, or `null` once none is running. */
  readonly importProgress: Signal<ImportProgress | null> = computed(() => this.slots.get('IMPORT_PROGRESS')().data ?? null);
  readonly folders: Signal<readonly Folder[]> = computed(() => this.slots.get('FOLDERS')().data ?? []);
  /** Ids of folders expanded in the sidebar tree. Seeded from `PreferencesPort` so it survives a store rebuild. */
  readonly expandedFolders: Signal<ReadonlySet<FolderId>> = computed(() => this.slots.get('EXPANDED_FOLDERS')().data ?? new Set());
  /** Session-scoped undo stack for speaker ops. Cleared whenever selection changes — see `setSelectedMeeting`. */
  readonly speakerHistory: Signal<readonly SpeakerOp[]> = computed(() => this.slots.get('SPEAKER_HISTORY')().data ?? []);
  /** Single-slot inverse for the last transcript structural op. Cleared whenever selection changes — see `setSelectedMeeting`. */
  readonly transcriptUndo: Signal<TranscriptOp | null> = computed(() => this.slots.get('TRANSCRIPT_UNDO')().data ?? null);
  /** Lifecycle of the in-app model download; never `null` so consumers can read `.phase` unguarded. */
  readonly modelDownload: Signal<ModelDownloadState> = computed(() => this.slots.get('MODEL_DOWNLOAD')().data ?? IDLE_MODEL_DOWNLOAD);
  readonly outputDevices: Signal<readonly AudioDevice[]> = computed(() => this.slots.get('OUTPUT_DEVICES')().data ?? []);
  readonly defaultDevice: Signal<AudioDevice | null> = computed(() => this.slots.get('DEFAULT_DEVICE')().data ?? null);
  readonly defaultOutputDevice: Signal<AudioDevice | null> = computed(() => this.slots.get('DEFAULT_OUTPUT_DEVICE')().data ?? null);

  constructor() {
    seedPersistedPreferences(this.slots, this.preferences);
    wireRecorderAndTranscriberEvents(this.slots, this.recorder, this.transcriber, this.summarizer);
    subscribeToAudioImportEvents(this, this.audioImport ?? undefined);
  }

  setMeetings(meetings: readonly Meeting[]): void {
    this.slots.update('MEETINGS', { data: meetings, status: 'Success', isLoading: false });
  }

  /** Selects `meeting` AND clears both undo histories — they're scoped to the previously-selected meeting. `updateMeeting` must NOT clear them: every speaker mutation funnels through it. */
  setSelectedMeeting(meeting: Meeting): void {
    this.slots.update('SELECTED_MEETING', { data: meeting, status: 'Success', isLoading: false });
    this.setSpeakerHistory([]);
    this.setTranscriptUndo(null);
  }

  /** Replaces `meeting` within `MEETINGS` (matched by id) and mirrors it onto `SELECTED_MEETING` if selected; never mutates in place. */
  updateMeeting(meeting: Meeting): void {
    const meetings = this.slots.get('MEETINGS')().data ?? [];
    this.slots.update('MEETINGS', {
      data: meetings.map((existing) => (existing.id === meeting.id ? meeting : existing)),
      status: 'Success',
      isLoading: false,
    });
    if (this.slots.get('SELECTED_MEETING')().data?.id === meeting.id) {
      this.slots.update('SELECTED_MEETING', { data: meeting, status: 'Success', isLoading: false });
    }
  }

  /** Upserts `meeting` at the front of `MEETINGS` (dropping any existing entry with its id first); never mutates in place. */
  addMeeting(meeting: Meeting): void {
    const rest = (this.slots.get('MEETINGS')().data ?? []).filter((existing) => existing.id !== meeting.id);
    this.slots.update('MEETINGS', { data: [meeting, ...rest], status: 'Success', isLoading: false });
  }

  clearSelectedMeeting(): void {
    this.slots.clear('SELECTED_MEETING');
  }

  /** Removes `id` from `MEETINGS`; also clears `SELECTED_MEETING` if it currently points at `id` — never touches a different selection. */
  removeMeeting(id: MeetingId): void {
    const meetings = (this.slots.get('MEETINGS')().data ?? []).filter((existing) => existing.id !== id);
    this.slots.update('MEETINGS', { data: meetings, status: 'Success', isLoading: false });
    if (this.slots.get('SELECTED_MEETING')().data?.id === id) this.clearSelectedMeeting();
  }

  setTemplates(templates: readonly SummaryTemplate[]): void {
    this.slots.update('TEMPLATES', { data: templates, status: 'Success', isLoading: false });
  }

  setModelsStatus(status: ModelsStatus): void {
    this.slots.update('MODELS_STATUS', { data: status, status: 'Success', isLoading: false });
  }

  setError(error: MeetingsErrorInfo): void {
    this.slots.update('ERROR', { data: error, status: 'Error', isLoading: false });
  }

  clearError(): void {
    this.slots.clear('ERROR');
  }

  resetLiveTranscript(): void {
    this.slots.update('FINALIZED_SEGMENTS', { data: [], status: 'Success', isLoading: false });
    this.slots.update('PARTIAL_TEXT_ME', { data: '', status: 'Success', isLoading: false });
    this.slots.update('PARTIAL_TEXT_OTHERS', { data: '', status: 'Success', isLoading: false });
  }

  // Command-fed write path for the ADR 0011 boot resume: mirror the
  // `recording_state` snapshot without waiting for a `recording://state` event,
  // replay the durability journal (deduped against live-stream arrivals), and
  // retire the slot on idle — a restored baseline must never leak into the
  // NEXT recording's timer.
  setRecordingState(state: RecordingState): void { this.slots.update('RECORDING_STATE', { data: state, status: 'Success', isLoading: false }); }
  setActiveRecording(active: ActiveRecording | null): void { this.slots.update('ACTIVE_RECORDING', { data: active, status: 'Success', isLoading: false }); }
  clearActiveRecording(): void { this.slots.update('ACTIVE_RECORDING', { data: null, status: 'Success', isLoading: false }); }
  seedFinalizedSegments(segments: readonly TranscriptSegment[]): void { this.slots.update('FINALIZED_SEGMENTS', { data: mergeFinalizedSegments(this.finalizedSegments(), segments), status: 'Success', isLoading: false }); }

  resetSummaryStream(): void {
    this.slots.update('SUMMARY_STREAM', { data: '', status: 'Success', isLoading: false });
  }

  setDevices(devices: readonly AudioDevice[]): void {
    this.slots.update('DEVICES', { data: devices, status: 'Success', isLoading: false });
  }

  /** Updates the selection AND persists it via `PreferencesPort`. Clearing to `null` persists the empty-string sentinel — NOT `null` — so `seedPersistedPreferences` distinguishes "explicitly cleared" from "never set". */
  setSelectedDevice(device: AudioDevice | null): void {
    this.preferences.set(MIC_DEVICE_PREFERENCE_KEY, device?.name ?? DEFAULT_MIC_SENTINEL);
    this.slots.update('SELECTED_DEVICE', { data: device, status: 'Success', isLoading: false });
  }

  setOutputDevices(devices: readonly AudioDevice[]): void {
    this.slots.update('OUTPUT_DEVICES', { data: devices, status: 'Success', isLoading: false });
  }

  setDefaultDevice(device: AudioDevice | null): void {
    this.slots.update('DEFAULT_DEVICE', { data: device, status: 'Success', isLoading: false });
  }

  setDefaultOutputDevice(device: AudioDevice | null): void {
    this.slots.update('DEFAULT_OUTPUT_DEVICE', { data: device, status: 'Success', isLoading: false });
  }

  /** Overwrites the speaker-op undo stack; callers pass `[]` to clear (e.g. after a failed delete/merge, the surviving op is dropped). */
  setSpeakerHistory(history: readonly SpeakerOp[]): void {
    this.slots.update('SPEAKER_HISTORY', { data: history, status: 'Success', isLoading: false });
  }

  /** Sets (or clears, via `null`) the single-slot transcript structural-op inverse. */
  setTranscriptUndo(op: TranscriptOp | null): void {
    this.slots.update('TRANSCRIPT_UNDO', { data: op, status: 'Success', isLoading: false });
  }

  setModelDownload(state: ModelDownloadState): void {
    this.slots.update('MODEL_DOWNLOAD', { data: state, status: 'Success', isLoading: false });
  }

  /** Records (or clears, via `null`) the identity of the (template, language) pair currently generating. */
  setSummarizingKey(key: SummarizingKey | null): void {
    this.slots.update('SUMMARIZING_KEY', { data: key, status: 'Success', isLoading: false });
  }

  setStartingRecording(value: boolean): void {
    this.slots.update('STARTING_RECORDING', { data: value, status: 'Success', isLoading: false });
  }

  setSystemAudioStatus(status: SystemAudioStatus): void {
    this.slots.update('SYSTEM_AUDIO_STATUS', { data: status, status: 'Success', isLoading: false });
  }

  /** Updates the selection AND persists it via `PreferencesPort`, so it survives a store rebuild. */
  setCaptureSource(source: CaptureSource): void {
    this.preferences.set(CAPTURE_SOURCE_PREFERENCE_KEY, source);
    this.slots.update('CAPTURE_SOURCE', { data: source, status: 'Success', isLoading: false });
  }

  /** Replaces the offered sources AND falls back a stale persisted/current selection (one no longer present in `sources`) to `DEFAULT_AUDIO_SOURCE_ID`; a still-valid selection is left untouched. */
  setAudioSources(sources: readonly AudioSource[]): void {
    this.slots.update('AUDIO_SOURCES', { data: sources, status: 'Success', isLoading: false });
    const current = this.selectedAudioSource();
    if (!sources.some((source) => source.id === current)) {
      this.setSelectedAudioSource(DEFAULT_AUDIO_SOURCE_ID);
    }
  }

  /** Updates the selection AND persists it via `PreferencesPort`, so it survives a store rebuild. */
  setSelectedAudioSource(id: string): void {
    this.preferences.set(AUDIO_SOURCE_PREFERENCE_KEY, id);
    this.slots.update('SELECTED_AUDIO_SOURCE', { data: id, status: 'Success', isLoading: false });
  }

  setSummaryLanguages(languages: readonly SummaryLanguage[]): void {
    this.slots.update('SUMMARY_LANGUAGES', { data: languages, status: 'Success', isLoading: false });
  }

  /** Updates the selection AND persists it via `PreferencesPort`, so it survives a store rebuild. */
  setSelectedSummaryLanguage(code: string): void {
    this.preferences.set(SUMMARY_LANGUAGE_PREFERENCE_KEY, code);
    this.slots.update('SELECTED_SUMMARY_LANGUAGE', { data: code, status: 'Success', isLoading: false });
  }

  getSummaryCacheEntry(meetingId: MeetingId, template: string, language: string): SummaryCacheEntry | undefined {
    return readSummaryCacheEntry(this.slots, meetingId, template, language);
  }

  setSummaryCacheLoading(meetingId: MeetingId, template: string, language: string): void {
    applySummaryCacheLoading(this.slots, meetingId, template, language);
  }

  setSummaryCacheResult(meetingId: MeetingId, template: string, language: string, summary: Summary | null): void {
    applySummaryCacheResult(this.slots, meetingId, template, language, summary);
  }

  clearSummaryCacheEntry(meetingId: MeetingId, template: string, language: string): void {
    removeSummaryCacheEntry(this.slots, meetingId, template, language);
  }

  /** Lands an edited summary in BOTH read paths the detail pane uses; see `applySummaryContentUpdate`. */
  updateSummaryContent(meetingId: MeetingId, template: string, language: string, summary: Summary): void {
    applySummaryContentUpdate(this, meetingId, template, language, summary);
  }

  setAppVersion(version: string): void {
    this.slots.update('APP_VERSION', { data: version, status: 'Success', isLoading: false });
  }

  /** Clamps, persists (via `PreferencesPort`), and applies a new transcript/summary split ratio. */
  setSplitRatio(ratio: number): void {
    const clamped = storeSplitRatio(this.preferences, ratio);
    this.slots.update('SPLIT_RATIO', { data: clamped, status: 'Success', isLoading: false });
  }

  /** Persists (via `PreferencesPort`) and applies the transcript-collapsed flag. */
  setTranscriptCollapsed(collapsed: boolean): void {
    storeTranscriptCollapsed(this.preferences, collapsed);
    this.slots.update('TRANSCRIPT_COLLAPSED', { data: collapsed, status: 'Success', isLoading: false });
  }

  setImporting(value: boolean): void {
    this.slots.update('IMPORTING', { data: value, status: 'Success', isLoading: false });
  }

  setImportProgress(progress: ImportProgress | null): void {
    this.slots.update('IMPORT_PROGRESS', { data: progress, status: 'Success', isLoading: false });
  }

  /** Clears both import slots; call once an import/re-transcribe settles (success, failure, or cancel). */
  resetImport(): void {
    this.slots.update('IMPORTING', { data: false, status: 'Success', isLoading: false });
    this.slots.update('IMPORT_PROGRESS', { data: null, status: 'Success', isLoading: false });
  }

  setFolders(folders: readonly Folder[]): void {
    this.slots.update('FOLDERS', { data: folders, status: 'Success', isLoading: false });
  }

  addFolder(folder: Folder): void {
    this.slots.update('FOLDERS', { data: withFolderAdded(this.folders(), folder), status: 'Success', isLoading: false });
  }

  updateFolder(folder: Folder): void {
    this.slots.update('FOLDERS', { data: withFolderUpdated(this.folders(), folder), status: 'Success', isLoading: false });
  }

  /** Removes `id` from `FOLDERS`; also strips it from `EXPANDED_FOLDERS`, persisting the change. */
  removeFolder(id: FolderId): void {
    this.slots.update('FOLDERS', { data: withFolderRemoved(this.folders(), id), status: 'Success', isLoading: false });
    this.persistExpandedFolders(withoutFolderId(this.expandedFolders(), id));
  }

  /** Toggles `id`'s membership in `EXPANDED_FOLDERS`, persisting the result via `PreferencesPort`. */
  toggleFolderExpanded(id: FolderId): void {
    this.persistExpandedFolders(withToggledFolderId(this.expandedFolders(), id));
  }

  private persistExpandedFolders(next: ReadonlySet<FolderId>): void {
    storeExpandedFolders(this.preferences, next);
    this.slots.update('EXPANDED_FOLDERS', { data: next, status: 'Success', isLoading: false });
  }
}
