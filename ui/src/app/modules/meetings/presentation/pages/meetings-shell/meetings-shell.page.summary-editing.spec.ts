import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter, convertToParamMap, type ParamMap } from '@angular/router';
import { By } from '@angular/platform-browser';
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
import { MeetingDetailPaneComponent } from '../../components/meeting-detail-pane/meeting-detail-pane.component';
import { MeetingsShellPage } from './meetings-shell.page';

const readyModelsStatus: ModelsStatus = {
  parakeet: { present: true, expectedFiles: [] },
  qwen: { present: true, expectedFiles: [] },
  silero: { present: true, expectedFiles: [] },
  allPresent: true,
};

describe('MeetingsShellPage — summary editing', () => {
  const meetings = signal<readonly Meeting[]>([]);
  const selectedMeeting = signal<Meeting | undefined>(undefined);
  const modelsStatus = signal<ModelsStatus | undefined>(readyModelsStatus);
  const devices = signal<readonly AudioDevice[]>([]);
  const selectedDevice = signal<AudioDevice | null>(null);
  const defaultDevice = signal<AudioDevice | null>(null);
  const outputDevices = signal<readonly AudioDevice[]>([]);
  const defaultOutputDevice = signal<AudioDevice | null>(null);
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

  const noop = async (): Promise<void> => undefined;
  const editSummary = vi.fn(async (id: string, template: string, language: string, markdown: string) => {
    void id;
    void template;
    void language;
    void markdown;
  });

  const facadeStub = {
    meetings, selectedMeeting, modelsStatus, devices, selectedDevice, defaultDevice, outputDevices, defaultOutputDevice, recordingState, level,
    finalizedSegments, partialTextMe, partialTextOthers, error, busy, systemAudioStatus, captureSource, templates,
    summaryStream, summarizing, summarizingKey, startingRecording, summaryLanguages, selectedSummaryLanguage,
    summaryCache, appVersion, audioSources, selectedAudioSource, effectiveSystemSource,
    splitRatio, transcriptCollapsed, importing, importProgress,
    editSummary,
    setSplitRatio: vi.fn(), setTranscriptCollapsed: vi.fn(), setMeetingArchived: vi.fn(noop),
    editTranscriptSegment: vi.fn(noop),
    loadMeetings: vi.fn(noop), loadTemplates: vi.fn(noop), checkModels: vi.fn(noop), loadDevices: vi.fn(noop),
    clearSelection: vi.fn(noop),
    checkSystemAudio: vi.fn(noop), loadSummaryLanguages: vi.fn(noop), loadAppVersion: vi.fn(noop),
    loadAudioSources: vi.fn(noop), loadSummary: vi.fn(noop), openMeeting: vi.fn(noop),
    startRecording: vi.fn(noop), stopRecording: vi.fn(noop), cancelRecording: vi.fn(noop),
    deleteMeeting: vi.fn(noop), renameMeeting: vi.fn(noop), summarizeMeeting: vi.fn(noop),
    cancelSummarization: vi.fn(noop), exportMeeting: vi.fn(noop), selectDevice: vi.fn(),
    selectCaptureSource: vi.fn(), selectAudioSource: vi.fn(), selectSummaryLanguage: vi.fn(),
    requestSystemAudioPermission: vi.fn(noop),
    folders: signal<readonly never[]>([]), expandedFolders: signal<ReadonlySet<never>>(new Set()),
    loadFolders: vi.fn(noop), createFolder: vi.fn(noop), renameFolder: vi.fn(noop),
    deleteFolder: vi.fn(noop), toggleFolderExpanded: vi.fn(),
    modelDownload: signal(undefined),
    speakerHistory: signal([]),
    undoLastSpeakerOp: vi.fn(async () => undefined),
  } as unknown as MeetingsFacade;

  beforeEach(() => {
    editSummary.mockClear();
    const routeParamMap = new BehaviorSubject<ParamMap>(convertToParamMap({}));
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

  it('forwards the pane payload to facade.editSummary', () => {
    const fixture = createFixture();

    fixture.componentInstance.onSummaryEdited({
      meetingId: toMeetingId('m1'),
      template: 'key-points',
      language: 'en',
      markdown: '# Edited',
    });

    expect(editSummary).toHaveBeenCalledWith('m1', 'key-points', 'en', '# Edited');
  });

  it('wires the pane summaryEdited output through the template binding', async () => {
    const fixture = createFixture();

    const pane = fixture.debugElement.query(By.directive(MeetingDetailPaneComponent));
    pane?.componentInstance.summaryEdited.emit({
      meetingId: toMeetingId('m1'),
      template: 'action-items',
      language: 'fr',
      markdown: '# Actions',
    });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(editSummary).toHaveBeenCalledWith('m1', 'action-items', 'fr', '# Actions');
  });
});
