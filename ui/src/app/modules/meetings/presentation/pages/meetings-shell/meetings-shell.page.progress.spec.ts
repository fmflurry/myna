import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter, type ParamMap } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { vi } from 'vitest';

import { MeetingsFacade } from '../../../application/facades/meetings.facade';
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
import { MeetingsShellPage } from './meetings-shell.page';

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
  const summaryLanguages = signal<readonly { code: string; label: string }[]>([]);
  const selectedSummaryLanguage = signal('en');
  const summaryCache = signal<ReadonlyMap<string, { status: string }>>(new Map());
  const appVersion = signal<string | undefined>(undefined);
  const audioSources = signal<readonly AudioSource[]>([]);
  const selectedAudioSource = signal('system:all');
  const effectiveSystemSource = signal<AudioSource | null>(null);
  const splitRatio = signal(0.4);
  const transcriptCollapsed = signal(false);
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
  const folders = signal<readonly never[]>([]);
  const expandedFolders = signal<ReadonlySet<never>>(new Set());
  const loadFolders = vi.fn(noop);
  const createFolder = vi.fn(noop);
  const renameFolder = vi.fn(noop);
  const deleteFolder = vi.fn(noop);
  const toggleFolderExpanded = vi.fn();

  const facadeStub = {
    meetings, selectedMeeting, modelsStatus, devices, selectedDevice, recordingState, level,
    finalizedSegments, partialTextMe, partialTextOthers, error, busy, systemAudioStatus, captureSource, templates,
    summaryStream, summarizing, summarizingKey, startingRecording, summaryLanguages, selectedSummaryLanguage,
    summaryCache, appVersion, audioSources, selectedAudioSource, effectiveSystemSource,
    splitRatio, transcriptCollapsed, importing, importProgress, setSplitRatio, setTranscriptCollapsed,
    loadMeetings, loadTemplates, checkModels, loadDevices, checkSystemAudio, loadSummaryLanguages,
    loadAppVersion, loadAudioSources, loadSummary, openMeeting, startRecording, stopRecording,
    cancelRecording, deleteMeeting, renameMeeting, summarizeMeeting, cancelSummarization,
    exportMeeting, selectDevice, selectCaptureSource, selectAudioSource, selectSummaryLanguage,
    requestSystemAudioPermission,
    folders, expandedFolders, loadFolders, createFolder, renameFolder, deleteFolder, toggleFolderExpanded,
    speakerHistory: signal([]),
transcriptUndo: signal(null),
modelDownload: signal(undefined),
  } as unknown as MeetingsFacade;

  let routeParamMap: BehaviorSubject<ParamMap>;

  beforeEach(() => {
    selectedMeeting.set(meeting);
    recordingState.set('idle');
    systemAudioStatus.set({ kind: 'available' });
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
});
