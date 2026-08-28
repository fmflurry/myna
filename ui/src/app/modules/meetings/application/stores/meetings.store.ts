import { Injectable, computed, inject, type Signal } from '@angular/core';
import { Store, syncToStore } from 'flurryx';
import { auditTime } from 'rxjs';

import type { AudioDevice, AudioLevel } from '../../core/models/audio-device.model';
import { ALL_SYSTEM_AUDIO_SOURCE_ID, type AudioSource } from '../../core/models/audio-source.model';
import type { CaptureSource, SystemAudioStatus } from '../../core/models/capture-source.model';
import type { Meeting, MeetingId } from '../../core/models/meeting.model';
import type { ModelsStatus } from '../../core/models/models-status.model';
import type { MeetingsErrorCode, RecordingState } from '../../core/models/recording-state.model';
import { DEFAULT_SPLIT_RATIO } from '../../core/models/split-layout.model';
import { DEFAULT_SUMMARY_LANGUAGE_CODE, type SummaryLanguage } from '../../core/models/summary-language.model';
import type { Summary } from '../../core/models/summary.model';
import type { SummaryTemplate } from '../../core/models/summary-template.model';
import type { TranscriptSegment } from '../../core/models/transcript.model';
import { PreferencesPort } from '../../core/ports/preferences.port';
import { RecorderPort } from '../../core/ports/recorder.port';
import { SummarizerPort } from '../../core/ports/summarizer.port';
import { TranscriberPort } from '../../core/ports/transcriber.port';
import { readStoredSplitRatio, readStoredTranscriptCollapsed, storeSplitRatio, storeTranscriptCollapsed } from './split-layout-preferences.util';
import { summaryCacheKey } from './summary-cache.model';
import type { SummaryCacheEntry, SummaryCacheStatus } from './summary-cache.model';
import type { SummarizingKey } from './summarizing-key.model';

export type { SummarizingKey };
export type { SummaryCacheEntry, SummaryCacheStatus };
export { summaryCacheKey };
export { SPLIT_RATIO_PREFERENCE_KEY, TRANSCRIPT_COLLAPSED_PREFERENCE_KEY } from './split-layout-preferences.util';

export interface MeetingsErrorInfo {
  readonly code: MeetingsErrorCode;
  readonly message: string;
}

interface MeetingsStoreConfig {
  MEETINGS: readonly Meeting[];
  SELECTED_MEETING: Meeting;
  RECORDING_STATE: RecordingState;
  FINALIZED_SEGMENTS: readonly TranscriptSegment[];
  PARTIAL_TEXT: string;
  LEVEL: AudioLevel;
  TEMPLATES: readonly SummaryTemplate[];
  MODELS_STATUS: ModelsStatus;
  SUMMARY_STREAM: string;
  ERROR: MeetingsErrorInfo;
  DEVICES: readonly AudioDevice[];
  SELECTED_DEVICE: AudioDevice | null;
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
}

/** localStorage key the selected summary output language is persisted under. */
export const SUMMARY_LANGUAGE_PREFERENCE_KEY = 'meetings.summaryLanguage';

/** localStorage key the selected capture source is persisted under. */
export const CAPTURE_SOURCE_PREFERENCE_KEY = 'meetings.captureSource';

/** localStorage key the selected system-audio source is persisted under. */
export const AUDIO_SOURCE_PREFERENCE_KEY = 'meetings.audioSource';

/** Capture source assumed when nothing has been stored yet: both mic and system audio. */
export const DEFAULT_CAPTURE_SOURCE: CaptureSource = 'mixed';

/** System-audio source assumed when nothing has been stored yet: all system output. */
export const DEFAULT_AUDIO_SOURCE_ID = ALL_SYSTEM_AUDIO_SOURCE_ID;

const VALID_CAPTURE_SOURCES: readonly CaptureSource[] = ['microphone', 'system', 'mixed'];

const isCaptureSource = (value: string | null): value is CaptureSource =>
  value !== null && (VALID_CAPTURE_SOURCES as readonly string[]).includes(value);

/** Underlying flurryx signal slots. Kept module-private; MeetingsStore is the public surface. */
const MeetingsStoreSlots = Store.for<MeetingsStoreConfig>().build();

/**
 * Minimum spacing, in milliseconds, between live partial-transcript
 * updates reaching the UI. `TranscriberPort.partials()` can fire far more
 * often than the UI needs to redraw (each partial re-decode this store
 * receives can trigger a synchronous reflow downstream — see
 * `live-transcript.component.ts`'s scroll effect); auditing here bounds
 * that redraw rate regardless of how bursty the underlying event stream
 * is. Finals are never throttled — only partials, which are inherently
 * provisional.
 */
export const PARTIAL_UI_AUDIT_MS = 100;

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
  private readonly preferences = inject(PreferencesPort);

  readonly meetings: Signal<readonly Meeting[]> = computed(() => this.slots.get('MEETINGS')().data ?? []);
  readonly selectedMeeting: Signal<Meeting | undefined> = computed(() => this.slots.get('SELECTED_MEETING')().data);
  readonly recordingState: Signal<RecordingState> = computed(() => this.slots.get('RECORDING_STATE')().data ?? 'idle');
  /** Finalized segments only ever append; the partial is transient and clears once a final arrives (see `finals()` below). */
  readonly finalizedSegments: Signal<readonly TranscriptSegment[]> = computed(() => this.slots.get('FINALIZED_SEGMENTS')().data ?? []);
  readonly partialText: Signal<string> = computed(() => this.slots.get('PARTIAL_TEXT')().data ?? '');
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

  constructor() {
    const storedLanguage = this.preferences.get(SUMMARY_LANGUAGE_PREFERENCE_KEY);
    this.slots.update('SELECTED_SUMMARY_LANGUAGE', {
      data: storedLanguage ?? DEFAULT_SUMMARY_LANGUAGE_CODE,
      status: 'Success',
      isLoading: false,
    });

    const storedCaptureSource = this.preferences.get(CAPTURE_SOURCE_PREFERENCE_KEY);
    this.slots.update('CAPTURE_SOURCE', {
      data: isCaptureSource(storedCaptureSource) ? storedCaptureSource : DEFAULT_CAPTURE_SOURCE,
      status: 'Success',
      isLoading: false,
    });
    const storedAudioSource = this.preferences.get(AUDIO_SOURCE_PREFERENCE_KEY);
    this.slots.update('SELECTED_AUDIO_SOURCE', {
      data: storedAudioSource ?? DEFAULT_AUDIO_SOURCE_ID,
      status: 'Success',
      isLoading: false,
    });

    this.slots.update('SPLIT_RATIO', { data: readStoredSplitRatio(this.preferences), status: 'Success', isLoading: false });
    this.slots.update('TRANSCRIPT_COLLAPSED', { data: readStoredTranscriptCollapsed(this.preferences), status: 'Success', isLoading: false });

    this.recorder
      .stateChanges()
      .pipe(syncToStore(this.slots, 'RECORDING_STATE', { completeOnFirstEmission: false }))
      .subscribe();

    this.recorder
      .effectiveSystemSourceChanges()
      .pipe(syncToStore(this.slots, 'EFFECTIVE_SYSTEM_SOURCE', { completeOnFirstEmission: false }))
      .subscribe();

    this.recorder
      .levels()
      .pipe(syncToStore(this.slots, 'LEVEL', { completeOnFirstEmission: false }))
      .subscribe();

    this.transcriber
      .partials()
      .pipe(auditTime(PARTIAL_UI_AUDIT_MS))
      .subscribe((partial) => {
        this.slots.update('PARTIAL_TEXT', { data: partial.text, status: 'Success', isLoading: false });
      });

    this.transcriber.finals().subscribe((final) => {
      const current = this.slots.get('FINALIZED_SEGMENTS')().data ?? [];
      this.slots.update('FINALIZED_SEGMENTS', {
        data: [...current, final.segment],
        status: 'Success',
        isLoading: false,
      });
      this.slots.update('PARTIAL_TEXT', { data: '', status: 'Success', isLoading: false });
    });

    this.summarizer.tokens().subscribe((token) => {
      // No `language` on the wire; `Busy`-guarded concurrency means template alone disambiguates.
      const activeKey = this.slots.get('SUMMARIZING_KEY')().data;
      if (activeKey?.template !== token.template) {
        return;
      }
      const current = this.slots.get('SUMMARY_STREAM')().data ?? '';
      this.slots.update('SUMMARY_STREAM', {
        data: current + token.token,
        status: 'Success',
        isLoading: false,
      });
    });

    this.summarizer.done().subscribe((summary) => {
      this.slots.update('SUMMARY_STREAM', {
        data: summary.markdown,
        status: 'Success',
        isLoading: false,
      });
    });
  }

  setMeetings(meetings: readonly Meeting[]): void {
    this.slots.update('MEETINGS', { data: meetings, status: 'Success', isLoading: false });
  }

  setSelectedMeeting(meeting: Meeting): void {
    this.slots.update('SELECTED_MEETING', { data: meeting, status: 'Success', isLoading: false });
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
    this.slots.update('PARTIAL_TEXT', { data: '', status: 'Success', isLoading: false });
  }

  resetSummaryStream(): void {
    this.slots.update('SUMMARY_STREAM', { data: '', status: 'Success', isLoading: false });
  }

  setDevices(devices: readonly AudioDevice[]): void {
    this.slots.update('DEVICES', { data: devices, status: 'Success', isLoading: false });
  }

  setSelectedDevice(device: AudioDevice | null): void {
    this.slots.update('SELECTED_DEVICE', { data: device, status: 'Success', isLoading: false });
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

  setAudioSources(sources: readonly AudioSource[]): void {
    this.slots.update('AUDIO_SOURCES', { data: sources, status: 'Success', isLoading: false });
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
    return this.summaryCache().get(summaryCacheKey(meetingId, template, language));
  }

  setSummaryCacheLoading(meetingId: MeetingId, template: string, language: string): void {
    const next = new Map(this.summaryCache());
    next.set(summaryCacheKey(meetingId, template, language), { status: 'loading' });
    this.slots.update('SUMMARY_CACHE', { data: next, status: 'Success', isLoading: false });
  }

  /** `summary === null` records the deliberate `'empty'` outcome — never treated as an error. */
  setSummaryCacheResult(meetingId: MeetingId, template: string, language: string, summary: Summary | null): void {
    const next = new Map(this.summaryCache());
    next.set(
      summaryCacheKey(meetingId, template, language),
      summary ? { status: 'loaded', summary } : { status: 'empty' },
    );
    this.slots.update('SUMMARY_CACHE', { data: next, status: 'Success', isLoading: false });
  }

  /** Removes a cache entry (e.g. after a failed fetch) so the next tab visit retries instead of getting stuck. */
  clearSummaryCacheEntry(meetingId: MeetingId, template: string, language: string): void {
    const next = new Map(this.summaryCache());
    next.delete(summaryCacheKey(meetingId, template, language));
    this.slots.update('SUMMARY_CACHE', { data: next, status: 'Success', isLoading: false });
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
}
