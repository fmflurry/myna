import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter, type ParamMap } from '@angular/router';
import { BehaviorSubject, EMPTY } from 'rxjs';
import { vi } from 'vitest';

import { MeetingsFacade } from '../../../application/facades/meetings.facade';
import { NOOP_UPDATES_FACADE_STUB } from '../../../application/testing/noop-updates-facade.stub';
import type { MeetingsErrorInfo } from '../../../application/stores/meetings.store';
import type { AudioDevice, AudioLevel } from '../../../core/models/audio-device.model';
import type { AudioSource } from '../../../core/models/audio-source.model';
import type { CaptureSource, SystemAudioStatus } from '../../../core/models/capture-source.model';
import type { Meeting } from '../../../core/models/meeting.model';
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
 * RED coverage for the clickable Myna logo / "go home" behaviour: the brand
 * mark in the title bar must become a real `<button>` that navigates back to
 * `/meetings` and clears the current selection, even while a recording is
 * in progress. Scaffold copied from `meetings-shell.page.selection.spec.ts`
 * (full facade stub — the shell's template renders real child components,
 * not stubs, so every signal they read must exist).
 */
describe('MeetingsShellPage home navigation (brand button)', () => {
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
  const templates = signal<readonly SummaryTemplate[]>([]);
  const summaryStream = signal('');
  const summarizing = signal(false);
  const summarizingKey = signal<{ template: string; language: string } | null>(null);
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
  const sidebarWidth = signal(224);
  const sidebarCollapsed = signal(false);
  const importing = signal(false);
  const importProgress = signal<ImportProgress | null>(null);

  const loadMeetings = vi.fn(async () => undefined);
  const loadTemplates = vi.fn(async () => undefined);
  const checkModels = vi.fn(async () => undefined);
  const loadDevices = vi.fn(async () => undefined);
  const checkSystemAudio = vi.fn(async () => undefined);
  const loadSummaryLanguages = vi.fn(async () => undefined);
  const loadSummaryGuidelines = vi.fn(async () => undefined);
  const setSummaryGuidelines = vi.fn(async () => undefined);
  const summaryGuidelines = signal("");
  const summaryInstructionDraft = () => ({ text: "", includeGeneral: true });
  const setSummaryInstructionDraft = vi.fn();
  const loadAppVersion = vi.fn(async () => undefined);
  const loadAudioSources = vi.fn(async () => undefined);
  const selectAudioSource = vi.fn((id: string) => {
    void id;
  });
  const loadSummary = vi.fn(async (id: string, template: string, language: string) => {
    void id;
    void template;
    void language;
  });
  const selectSummaryLanguage = vi.fn((code: string) => {
    void code;
  });
  const openMeeting = vi.fn(async (id: string) => {
    void id;
  });
  const startRecording = vi.fn(async (title: string, device?: string) => {
    void title;
    void device;
  });
  const stopRecording = vi.fn(async () => undefined);
  const cancelRecording = vi.fn(async () => undefined);
  const deleteMeeting = vi.fn(async (id: string) => {
    void id;
  });
  const renameMeeting = vi.fn(async (id: string, title: string) => {
    void id;
    void title;
  });
  const summarizeMeeting = vi.fn(async (id: string, template: SummaryTemplate) => {
    void id;
    void template;
  });
  const cancelSummarization = vi.fn(async () => undefined);
  const exportMeeting = vi.fn(async (id: string, format: string, name: string) => {
    void id;
    void format;
    void name;
  });
  const selectDevice = vi.fn((name: string) => {
    void name;
  });
  const selectCaptureSource = vi.fn((source: CaptureSource) => {
    void source;
  });
  const requestSystemAudioPermission = vi.fn(async () => undefined);
  const setSplitRatio = vi.fn((ratio: number) => {
    void ratio;
  });
  const setTranscriptCollapsed = vi.fn((collapsed: boolean) => {
    void collapsed;
  });
  const setSidebarWidth = vi.fn((width: number) => {
    void width;
  });
  const setSidebarCollapsed = vi.fn((collapsed: boolean) => {
    void collapsed;
  });
  /** Being added concurrently on `MeetingsFacade` by another agent — stubbed here per brief. */
  const clearSelection = vi.fn();
  const folders = signal<readonly never[]>([]);
  const expandedFolders = signal<ReadonlySet<never>>(new Set());
  const loadFolders = vi.fn(async () => undefined);
  const createFolder = vi.fn(async (name: string) => void name);
  const renameFolder = vi.fn(async (id: string, name: string) => {
    void id;
    void name;
  });
  const deleteFolder = vi.fn(async (id: string) => void id);
  const toggleFolderExpanded = vi.fn((id: string) => void id);

  const facadeStub = {
    settingsRequests: () => EMPTY,
    activeRecording: signal(null),
    resumeActiveRecording: vi.fn(async () => undefined),
    speakerHistory: signal([]), transcriptUndo: signal(null),
    meetings,
    selectedMeeting,
    modelsStatus,
    devices,
    selectedDevice,
    recordingState,
    level,
    finalizedSegments,
    partialTextMe,
    partialTextOthers,
    error,
    busy,
    systemAudioStatus,
    captureSource,
    templates,
    summaryStream,
    summarizing,
    summarizingKey,
    startingRecording,
    summaryLanguages,
    selectedSummaryLanguage,
    summaryCache,
    appVersion,
    audioSources,
    selectedAudioSource,
    effectiveSystemSource,
    splitRatio,
    transcriptCollapsed,
    sidebarWidth,
    sidebarCollapsed,
    importing,
    importProgress,
    setSplitRatio,
    setTranscriptCollapsed,
    setSidebarWidth,
    setSidebarCollapsed,
    loadMeetings,
    loadTemplates,
    checkModels,
    loadDevices,
    checkSystemAudio,
    loadSummaryLanguages,
    loadSummaryGuidelines, setSummaryGuidelines, summaryGuidelines, summaryInstructionDraft, setSummaryInstructionDraft,
    loadAppVersion,
    loadAudioSources,
    loadSummary,
    openMeeting,
    startRecording,
    stopRecording,
    cancelRecording,
    deleteMeeting,
    renameMeeting,
    summarizeMeeting,
    cancelSummarization,
    exportMeeting,
    selectDevice,
    selectCaptureSource,
    selectAudioSource,
    selectSummaryLanguage,
    requestSystemAudioPermission,
    clearSelection,
    folders,
    expandedFolders,
    loadFolders,
    createFolder,
    renameFolder,
    deleteFolder,
    toggleFolderExpanded,
    modelDownload: signal(undefined),
    updates: NOOP_UPDATES_FACADE_STUB,
  } as unknown as MeetingsFacade;

  let routeParamMap: BehaviorSubject<ParamMap>;

  beforeEach(() => {
    meetings.set([]);
    selectedMeeting.set(undefined);
    modelsStatus.set(readyModelsStatus);
    recordingState.set('idle');
    systemAudioStatus.set({ kind: 'available' });
    summarizing.set(false);
    startingRecording.set(false);
    routeParamMap = new BehaviorSubject<ParamMap>(convertToParamMap({}));
    Object.values({
      loadMeetings,
      loadTemplates,
      checkModels,
      loadDevices,
      checkSystemAudio,
      loadSummaryLanguages,
      loadAppVersion,
      loadAudioSources,
      loadSummary,
      openMeeting,
      startRecording,
      stopRecording,
      cancelRecording,
      deleteMeeting,
      renameMeeting,
      summarizeMeeting,
      cancelSummarization,
      exportMeeting,
      selectDevice,
      selectCaptureSource,
      selectAudioSource,
      selectSummaryLanguage,
      requestSystemAudioPermission,
      clearSelection,
    }).forEach((fn) => fn.mockClear());

    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: MeetingsFacade, useValue: facadeStub },
        {
          provide: ActivatedRoute,
          useValue: { paramMap: routeParamMap },
        },
      ],
    });
  });

  const createFixture = () => {
    const fixture = TestBed.createComponent(MeetingsShellPage);
    fixture.detectChanges();
    return fixture;
  };

  it('renders the brand as a focusable button with an accessible name', () => {
    const fixture = createFixture();

    const brand = fixture.nativeElement.querySelector('button.brand');

    expect(brand).toBeInstanceOf(HTMLButtonElement);
    expect((brand as HTMLButtonElement).type).toBe('button');
    expect((brand as HTMLButtonElement).getAttribute('aria-label')?.trim()).toBeTruthy();
  });

  it('navigates to /meetings when the brand button is clicked', () => {
    const fixture = createFixture();
    const router = TestBed.inject(Router);
    const navigateSpy = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    const brand = fixture.nativeElement.querySelector('button.brand') as HTMLButtonElement;
    brand.click();

    expect(navigateSpy).toHaveBeenCalledWith(['/meetings']);
  });

  it('clears the selected meeting when the route id becomes null', () => {
    routeParamMap.next(convertToParamMap({ id: 'm1' }));
    createFixture();
    expect(openMeeting).toHaveBeenCalledWith('m1');

    routeParamMap.next(convertToParamMap({}));

    expect(clearSelection).toHaveBeenCalled();
    expect(openMeeting).toHaveBeenCalledTimes(1);
  });

  it('navigates home even while a recording is in progress', () => {
    recordingState.set('recording');
    const fixture = createFixture();
    const router = TestBed.inject(Router);
    const navigateSpy = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    const brand = fixture.nativeElement.querySelector('button.brand') as HTMLButtonElement;
    brand.click();
    fixture.detectChanges();

    expect(navigateSpy).toHaveBeenCalledWith(['/meetings']);
    expect(brand.disabled).toBe(false);
  });
});
