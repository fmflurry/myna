import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, type ParamMap } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { vi } from 'vitest';

import { MeetingsFacade } from '../../../application/facades/meetings.facade';
import { NOOP_UPDATES_FACADE_STUB } from '../../../application/testing/noop-updates-facade.stub';
import type { MeetingsErrorInfo, ModelDownloadState } from '../../../application/stores/meetings.store';
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

/**
 * Covers the shell page's wiring of the in-app model download onto the
 * already-injected `MeetingsFacade`: binding `modelDownload` into the detail
 * pane and forwarding `downloadRequested` / `downloadCancelRequested` to
 * `facade.initializeModels()` / `facade.cancelModelDownload()`. Split out of
 * `meetings-shell.page.spec.ts`, which is already near the project's
 * 400-line cap.
 */
describe('MeetingsShellPage model download', () => {
  const notReadyModelsStatus: ModelsStatus = {
    parakeet: { present: false, expectedFiles: ['encoder.int8.onnx'] },
    qwen: { present: true, expectedFiles: [] },
    silero: { present: true, expectedFiles: [] },
    allPresent: false,
  };

  const meetings = signal<readonly Meeting[]>([]);
  const selectedMeeting = signal<Meeting | undefined>(undefined);
  const modelsStatus = signal<ModelsStatus | undefined>(notReadyModelsStatus);
  const modelDownload = signal<ModelDownloadState | undefined>(undefined);
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
  const importing = signal(false);
  const importProgress = signal<ImportProgress | null>(null);
  const folders = signal<readonly never[]>([]);
  const expandedFolders = signal<ReadonlySet<never>>(new Set());

  const noop = async (): Promise<void> => undefined;
  const initializeModels = vi.fn(noop);
  const cancelModelDownload = vi.fn(noop);

  const facadeStub = {
    activeRecording: signal(null),
    resumeActiveRecording: vi.fn(async () => undefined),
    speakerHistory: signal([]), transcriptUndo: signal(null),
    meetings, selectedMeeting, modelsStatus, modelDownload, devices, selectedDevice, recordingState, level,
    finalizedSegments, partialTextMe, partialTextOthers, error, busy, systemAudioStatus, captureSource, templates,
    summaryStream, summarizing, summarizingKey, startingRecording, summaryLanguages, selectedSummaryLanguage,
    summaryCache, appVersion, audioSources, selectedAudioSource, effectiveSystemSource,
    splitRatio, transcriptCollapsed, importing, importProgress, folders, expandedFolders,
    setSplitRatio: vi.fn(), setTranscriptCollapsed: vi.fn(),
    loadMeetings: vi.fn(noop), loadTemplates: vi.fn(noop), checkModels: vi.fn(noop), loadDevices: vi.fn(noop),
    checkSystemAudio: vi.fn(noop), loadSummaryLanguages: vi.fn(noop), loadAppVersion: vi.fn(noop),
    loadAudioSources: vi.fn(noop), loadSummary: vi.fn(noop), openMeeting: vi.fn(noop),
    startRecording: vi.fn(noop), stopRecording: vi.fn(noop), cancelRecording: vi.fn(noop),
    deleteMeeting: vi.fn(noop), renameMeeting: vi.fn(noop), summarizeMeeting: vi.fn(noop),
    cancelSummarization: vi.fn(noop), exportMeeting: vi.fn(noop), selectDevice: vi.fn(),
    selectCaptureSource: vi.fn(), selectAudioSource: vi.fn(), selectSummaryLanguage: vi.fn(),
    requestSystemAudioPermission: vi.fn(noop),
    loadFolders: vi.fn(noop), createFolder: vi.fn(noop), renameFolder: vi.fn(noop),
    deleteFolder: vi.fn(noop), toggleFolderExpanded: vi.fn(),
    initializeModels,
    cancelModelDownload,
    updates: NOOP_UPDATES_FACADE_STUB,
  } as unknown as MeetingsFacade;

  beforeEach(() => {
    modelsStatus.set(notReadyModelsStatus);
    modelDownload.set(undefined);
    initializeModels.mockClear();
    cancelModelDownload.mockClear();

    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: MeetingsFacade, useValue: facadeStub },
        {
          provide: ActivatedRoute,
          useValue: { paramMap: new BehaviorSubject<ParamMap>(convertToParamMap({})) },
        },
      ],
    });
  });

  const createFixture = () => {
    const fixture = TestBed.createComponent(MeetingsShellPage);
    fixture.detectChanges();
    return fixture;
  };

  it('starts the in-app model download through the facade when requested', () => {
    const fixture = createFixture();

    fixture.componentInstance.startModelDownload();

    expect(initializeModels).toHaveBeenCalledTimes(1);
  });

  it('cancels the in-app model download through the facade when requested', () => {
    const fixture = createFixture();

    fixture.componentInstance.cancelModelDownload();

    expect(cancelModelDownload).toHaveBeenCalledTimes(1);
  });

  it('renders the Download models button from the detail pane when models are missing', () => {
    const fixture = createFixture();

    expect(fixture.nativeElement.querySelector('.start-download')).toBeTruthy();
  });
});
