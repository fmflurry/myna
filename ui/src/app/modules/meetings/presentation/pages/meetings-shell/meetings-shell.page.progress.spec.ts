import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter, type ParamMap } from '@angular/router';
import { BehaviorSubject, EMPTY } from 'rxjs';
import { vi } from 'vitest';
import { By } from '@angular/platform-browser';

import { MeetingsFacade } from '../../../application/facades/meetings.facade';
import { NOOP_UPDATES_FACADE_STUB } from '../../../application/testing/noop-updates-facade.stub';
import type { MeetingsErrorInfo } from '../../../application/stores/meetings.store';
import type { AudioDevice, AudioLevel } from '../../../core/models/audio-device.model';
import type { AudioSource } from '../../../core/models/audio-source.model';
import type { CaptureSource, SystemAudioStatus } from '../../../core/models/capture-source.model';
import type { Meeting } from '../../../core/models/meeting.model';
import { toMeetingId } from '../../../core/models/meeting.model';
import type { ModelsStatus } from '../../../core/models/models-status.model';
import type { RecordingState } from '../../../core/models/recording-state.model';
import type { SummaryTemplate } from '../../../core/models/summary-template.model';
import type { TranscriptSegment } from '../../../core/models/transcript.model';
import type { ImportProgress } from '../../../core/ports/audio-import.port';
import { RecordControlComponent } from '../../components/record-control/record-control.component';
import { MeetingsShellPage } from './meetings-shell.page';

// --- Stop-phase contract (defined by these tests; production code must grow to match) ---
type StopPhase =
  | 'stopping-capture'
  | 'finalizing-transcript'
  | 'saving'
  | 'discarding'
  | 'recovering'
  | 'completed'
  | 'failed';

type RecordingHealthCategory = 'wav-write' | 'journal' | 'decode-drop' | 'tap-rebuild' | 'disk';
type RecordingHealthSeverity = 'warning' | 'error' | 'fatal';

interface RecordingHealthEvent {
  readonly category: RecordingHealthCategory;
  readonly severity: RecordingHealthSeverity;
  readonly message: string;
}

/** The record-control inputs the shell must wire once they exist. */
interface StopPhaseControlSurface {
  stopPhase?(): StopPhase | null;
  recordingHealth?(): RecordingHealthEvent | null;
}

const readyModelsStatus: ModelsStatus = {
  parakeet: { present: true, expectedFiles: [] },
  qwen: { present: true, expectedFiles: [] },
  silero: { present: true, expectedFiles: [] },
  allPresent: true,
};

/**
 * Regression coverage for "the whole app freezes while a summary generates"
 * (see the task brief): a progress indicator must render, Cancel must stay
 * reachable, and sidebar selection / tab switching must keep working while
 * `summarizing()` is true. Split into its own file — with its own facade
 * stub — to keep `meetings-shell.page.spec.ts` under the project's
 * max-lines limit (same pattern as `meetings-shell.page.selection.spec.ts`).
 */
describe('MeetingsShellPage non-blocking summarization', () => {
  const meetings = signal<readonly Meeting[]>([]);
  const selectedMeeting = signal<Meeting | undefined>(undefined);
  const modelsStatus = signal<ModelsStatus | undefined>(readyModelsStatus);
  const devices = signal<readonly AudioDevice[]>([]);
  const selectedDevice = signal<AudioDevice | null>(null);
  const recordingState = signal<RecordingState>('idle');
  const level = signal<AudioLevel | undefined>(undefined);
  const finalizedSegments = signal<readonly TranscriptSegment[]>([]);
  const partialTextMe = signal('');
  const partialTextOthers = signal('');
  const error = signal<MeetingsErrorInfo | undefined>(undefined);
  const busy = computed(() => recordingState() !== 'idle');
  const systemAudioStatus = signal<SystemAudioStatus | undefined>({ kind: 'available' });
  const captureSource = signal<CaptureSource>('microphone');
  const templates = signal<readonly SummaryTemplate[]>([
    { name: 'key-points', description: 'Key points', prompt: 'p' },
  ]);
  const summaryStream = signal('');
  const summarizing = signal(true);
  const summarizingKey = signal<{ template: string; language: string } | null>({
    template: 'key-points',
    language: 'en',
  });
  const startingRecording = signal(false);
  const stopPhase = signal<StopPhase | null>(null);
  const recordingHealth = signal<RecordingHealthEvent | null>(null);
  const summaryLanguages = signal<readonly { code: string; label: string }[]>([]);
  const selectedSummaryLanguage = signal('en');
  const summaryCache = signal<ReadonlyMap<string, { status: string }>>(new Map());
  const appVersion = signal<string | undefined>(undefined);
  const audioSources = signal<readonly AudioSource[]>([]);
  const selectedAudioSource = signal('system:all');
  const effectiveSystemSource = signal<AudioSource | null>(null);
  const splitRatio = signal(0.4);
  const transcriptCollapsed = signal(false);
  const sidebarWidth = signal(224);
  const sidebarCollapsed = signal(false);
  const importing = signal(false);
  const importProgress = signal<ImportProgress | null>(null);

  const meeting: Meeting = {
    id: toMeetingId('m1'),
    title: 'Standup',
    createdAt: new Date(),
    durationSec: 60,
    summaries: [],
    archived: false,
    hasAudio: false, hasSystemTrack: false,
    droppedAudioChunks: 0,
  };

  const noop = async (): Promise<void> => undefined;
  const loadMeetings = vi.fn(noop);
  const loadTemplates = vi.fn(noop);
  const checkModels = vi.fn(noop);
  const loadDevices = vi.fn(noop);
  const checkSystemAudio = vi.fn(noop);
  const loadSummaryLanguages = vi.fn(noop);
  const loadSummaryGuidelines = vi.fn(async () => undefined);
  const setSummaryGuidelines = vi.fn(async () => undefined);
  const summaryGuidelines = signal("");
  const summaryInstructionDraft = () => ({ text: "", includeGeneral: true });
  const setSummaryInstructionDraft = vi.fn();
  const loadAppVersion = vi.fn(noop);
  const loadAudioSources = vi.fn(noop);
  const loadSummary = vi.fn(noop);
  const openMeeting = vi.fn(noop);
  const startRecording = vi.fn(noop);
  const stopRecording = vi.fn(noop);
  const cancelRecording = vi.fn(noop);
  const deleteMeeting = vi.fn(noop);
  const renameMeeting = vi.fn(noop);
  const summarizeMeeting = vi.fn(noop);
  const cancelSummarization = vi.fn(noop);
  const exportMeeting = vi.fn(noop);
  const selectDevice = vi.fn();
  const selectCaptureSource = vi.fn();
  const selectAudioSource = vi.fn();
  const selectSummaryLanguage = vi.fn();
  const requestSystemAudioPermission = vi.fn(noop);
  const setSplitRatio = vi.fn();
  const setTranscriptCollapsed = vi.fn();
  const setSidebarWidth = vi.fn();
  const setSidebarCollapsed = vi.fn();
  const folders = signal<readonly never[]>([]);
  const expandedFolders = signal<ReadonlySet<never>>(new Set());
  const loadFolders = vi.fn(noop);
  const createFolder = vi.fn(noop);
  const renameFolder = vi.fn(noop);
  const deleteFolder = vi.fn(noop);
  const toggleFolderExpanded = vi.fn();

  const facadeStub = {
    settingsRequests: () => EMPTY,
    activeRecording: signal(null),
    resumeActiveRecording: vi.fn(async () => undefined),
    meetings, selectedMeeting, modelsStatus, devices, selectedDevice, recordingState, level,
    finalizedSegments, partialTextMe, partialTextOthers, error, busy, systemAudioStatus, captureSource, templates,
    clearSelection: vi.fn(),
    summaryStream, summarizing, summarizingKey, startingRecording, stopPhase, recordingHealth, summaryLanguages, selectedSummaryLanguage,
    summaryCache, appVersion, audioSources, selectedAudioSource, effectiveSystemSource,
    splitRatio, transcriptCollapsed, sidebarWidth, sidebarCollapsed, importing, importProgress, setSplitRatio, setTranscriptCollapsed, setSidebarWidth, setSidebarCollapsed,
    loadMeetings, loadTemplates, checkModels, loadDevices, checkSystemAudio, loadSummaryLanguages,
    loadSummaryGuidelines, setSummaryGuidelines, summaryGuidelines, summaryInstructionDraft, setSummaryInstructionDraft,
    loadAppVersion, loadAudioSources, loadSummary, openMeeting, startRecording, stopRecording,
    cancelRecording, deleteMeeting, renameMeeting, summarizeMeeting, cancelSummarization,
    exportMeeting, selectDevice, selectCaptureSource, selectAudioSource, selectSummaryLanguage,
    requestSystemAudioPermission,
    folders, expandedFolders, loadFolders, createFolder, renameFolder, deleteFolder, toggleFolderExpanded,
    speakerHistory: signal([]),
transcriptUndo: signal(null),
modelDownload: signal(undefined),
    updates: NOOP_UPDATES_FACADE_STUB,
  } as unknown as MeetingsFacade;

  let routeParamMap: BehaviorSubject<ParamMap>;

  beforeEach(() => {
    selectedMeeting.set(meeting);
    recordingState.set('idle');
    systemAudioStatus.set({ kind: 'available' });
    stopPhase.set(null);
    recordingHealth.set(null);
    summarizing.set(true);
    summarizingKey.set({ template: 'key-points', language: 'en' });
    routeParamMap = new BehaviorSubject<ParamMap>(convertToParamMap({}));

    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: MeetingsFacade, useValue: facadeStub },
        { provide: ActivatedRoute, useValue: { paramMap: routeParamMap } },
      ],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const createFixture = () => {
    const fixture = TestBed.createComponent(MeetingsShellPage);
    fixture.detectChanges();
    return fixture;
  };

  const selectKeyPointsTab = (fixture: ReturnType<typeof createFixture>): void => {
    const tabs: HTMLButtonElement[] = Array.from(fixture.nativeElement.querySelectorAll('.tab'));
    const keyPointsTab = tabs.find((tab) => !tab.textContent?.includes('Transcript'));
    keyPointsTab?.click();
    fixture.detectChanges();
  };

  it('renders an accessible, non-modal progress indicator while summarizing', () => {
    const fixture = createFixture();
    selectKeyPointsTab(fixture);

    const status = fixture.nativeElement.querySelector('app-summary-panel .status');
    expect(status).toBeTruthy();
    expect(status.getAttribute('role')).toBe('status');
    expect(fixture.nativeElement.querySelector('.modal-backdrop')).toBeNull();
  });

  it('keeps the Cancel action visible and working while summarizing', () => {
    const fixture = createFixture();
    selectKeyPointsTab(fixture);

    const cancelButton: HTMLButtonElement = fixture.nativeElement.querySelector('app-summary-panel .cancel');
    expect(cancelButton).toBeTruthy();
    cancelButton.click();

    expect(cancelSummarization).toHaveBeenCalledTimes(1);
  });

  it('still lets the user select a different meeting in the sidebar while a summary generates', () => {
    const fixture = createFixture();
    const router = TestBed.inject(Router);
    const navigateSpy = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    fixture.componentInstance.onMeetingSelected(toMeetingId('m2'));

    expect(navigateSpy).toHaveBeenCalledWith(['/meetings/meeting', 'm2']);
  });

  it('still lets the user switch tabs (e.g. back to the transcript) while a summary generates', () => {
    const fixture = createFixture();
    selectKeyPointsTab(fixture);
    expect(fixture.nativeElement.querySelector('app-summary-panel')).toBeTruthy();

    const tabs: HTMLButtonElement[] = Array.from(fixture.nativeElement.querySelectorAll('.tab'));
    const transcriptTab = tabs.find((tab) => tab.textContent?.includes('Transcript'));
    transcriptTab?.click();
    fixture.detectChanges();

    expect(transcriptTab?.classList.contains('active')).toBe(true);
    expect(fixture.nativeElement.querySelector('app-transcript-view')).toBeTruthy();
  });

  // --- Stop-phase wiring: the shell is the only place that touches the
  // facade; the record control must receive the current stop phase and the
  // latest recording health event so it can render phase-specific text,
  // watchdog escalation, and severity-appropriate live regions. ---

  it('forwards the facade stop phase to the record control', () => {
    recordingState.set('stopping');
    stopPhase.set('finalizing-transcript');
    const fixture = createFixture();

    const control = fixture.debugElement.query(By.directive(RecordControlComponent))
      .componentInstance as RecordControlComponent & StopPhaseControlSurface;
    expect(control.stopPhase?.()).toBe('finalizing-transcript');
  });

  it('forwards the latest facade recording health event to the record control', () => {
    const health: RecordingHealthEvent = {
      category: 'wav-write',
      severity: 'warning',
      message: 'WAV flush delayed',
    };
    recordingHealth.set(health);
    const fixture = createFixture();

    const control = fixture.debugElement.query(By.directive(RecordControlComponent))
      .componentInstance as RecordControlComponent & StopPhaseControlSurface;
    expect(control.recordingHealth?.()).toEqual(health);
  });

  it('stops the elapsed timer when the recording leaves the recording state', () => {
    vi.useFakeTimers();
    recordingState.set('recording');
    const fixture = createFixture();
    fixture.detectChanges();

    vi.advanceTimersByTime(3_000);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.timer')?.textContent).toBe('00:03');

    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    // The stop ack parks the UI on 'stopping'...
    recordingState.set('stopping');
    fixture.detectChanges();
    expect(clearSpy).toHaveBeenCalled();

    // ...and the completed event takes it to idle without reviving the timer.
    clearSpy.mockClear();
    recordingState.set('idle');
    fixture.detectChanges();
    vi.advanceTimersByTime(5_000);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.timer')).toBeNull();
    clearSpy.mockRestore();
  });

  it('clears the elapsed interval when the shell is destroyed mid-stop', () => {
    vi.useFakeTimers();
    recordingState.set('recording');
    const fixture = createFixture();
    fixture.detectChanges();

    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    fixture.destroy();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();

    // Destroying must leave no pending interval that could keep ticking.
    vi.advanceTimersByTime(10_000);
  });
});
