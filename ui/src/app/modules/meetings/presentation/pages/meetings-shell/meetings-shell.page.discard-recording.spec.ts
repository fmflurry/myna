import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
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
import { MeetingSidebarComponent } from '../../components/meeting-sidebar/meeting-sidebar.component';
import { MeetingsShellPage } from './meetings-shell.page';

const readyModelsStatus: ModelsStatus = {
  parakeet: { present: true, expectedFiles: [] },
  qwen: { present: true, expectedFiles: [] },
  silero: { present: true, expectedFiles: [] },
  allPresent: true,
};

/**
 * Coverage for deleting the meeting currently being recorded: the delete
 * must route through `cancelRecording()` (which stops the session and wipes
 * the meeting dir, including audio.wav) rather than `deleteMeeting()`, since
 * there is no finished recording session on disk to stop first. During a
 * recording the recording meeting IS the selected meeting (`startRecording`
 * sets it, and the busy-guard blocks selection from changing), so
 * `facade.busy()` + `selectedMeeting()?.id` identifies it.
 */
describe('MeetingsShellPage discard-in-progress-recording routing', () => {
  const meetings = signal<readonly Meeting[]>([]);
  const selectedMeeting = signal<Meeting | undefined>(undefined);
  const modelsStatus = signal<ModelsStatus | undefined>(readyModelsStatus);
  const devices = signal<readonly AudioDevice[]>([]);
  const selectedDevice = signal<AudioDevice | null>(null);
  const recordingState = signal<RecordingState>('idle');
  const level = signal<AudioLevel | undefined>(undefined);
  const finalizedSegments = signal<readonly TranscriptSegment[]>([]);
  const partialText = signal('');
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

  const loadMeetings = vi.fn(async () => undefined);
  const loadTemplates = vi.fn(async () => undefined);
  const checkModels = vi.fn(async () => undefined);
  const loadDevices = vi.fn(async () => undefined);
  const checkSystemAudio = vi.fn(async () => undefined);
  const loadSummaryLanguages = vi.fn(async () => undefined);
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

  const facadeStub = {
    meetings,
    selectedMeeting,
    modelsStatus,
    devices,
    selectedDevice,
    recordingState,
    level,
    finalizedSegments,
    partialText,
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
    setSplitRatio,
    setTranscriptCollapsed,
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

  const inProgressMeeting: Meeting = {
    id: toMeetingId('m1'),
    title: 'Standup',
    createdAt: new Date(2026, 7, 27, 14, 2),
    durationSec: 0,
    summaries: [],
    archived: false,
    hasAudio: false,
  };

  it('routes deletion of the in-progress meeting through cancelRecording, not deleteMeeting', () => {
    recordingState.set('recording');
    selectedMeeting.set(inProgressMeeting);
    const fixture = createFixture();
    const router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);

    fixture.componentInstance.onMeetingDeleted(toMeetingId('m1'));

    expect(cancelRecording).toHaveBeenCalledTimes(1);
    expect(deleteMeeting).not.toHaveBeenCalled();
  });

  it('navigates home after discarding the in-progress meeting', async () => {
    recordingState.set('recording');
    selectedMeeting.set(inProgressMeeting);
    const fixture = createFixture();
    const router = TestBed.inject(Router);
    const navigateSpy = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    fixture.componentInstance.onMeetingDeleted(toMeetingId('m1'));
    await Promise.resolve();
    await Promise.resolve();

    expect(navigateSpy).toHaveBeenCalledWith(['/meetings']);
  });

  it('still uses deleteMeeting for a non-recording meeting during a recording', () => {
    recordingState.set('recording');
    selectedMeeting.set(inProgressMeeting);
    const fixture = createFixture();
    const router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);

    fixture.componentInstance.onMeetingDeleted(toMeetingId('m2'));

    expect(deleteMeeting).toHaveBeenCalledWith('m2');
    expect(cancelRecording).not.toHaveBeenCalled();
  });

  it('passes the recording meeting id down to the sidebar', () => {
    // Black-box via the DOM (not a direct property read) so this test fails
    // at RUNTIME once `recordingMeetingId` exists but is wired wrong, not at
    // TS-compile time for the whole spec bundle: `[recordingMeetingId]` is a
    // template binding on `app-meeting-sidebar` the coder must add in
    // meetings-shell.page.html, forwarded from a page-level computed.
    const otherMeeting: Meeting = {
      id: toMeetingId('m2'),
      title: 'Client review',
      createdAt: new Date(2026, 7, 27, 11, 30),
      durationSec: 3480,
      summaries: [],
      archived: false,
      hasAudio: false,
    };
    meetings.set([inProgressMeeting, otherMeeting]);
    selectedMeeting.set(inProgressMeeting);
    recordingState.set('recording');
    const fixture = createFixture();

    const sidebar = fixture.debugElement.query(By.directive(MeetingSidebarComponent)).nativeElement as HTMLElement;
    const rows: HTMLElement[] = Array.from(sidebar.querySelectorAll('app-meeting-list-item'));
    expect(rows.length).toBe(2);

    (rows[0]!.querySelector('.delete') as HTMLElement).click();
    fixture.detectChanges();
    expect(rows[0]!.querySelector('.confirm-label')!.textContent).toBe(
      'Stop and discard this recording? The audio and transcript will be deleted.',
    );
    (rows[0]!.querySelector('.confirm-no') as HTMLElement).click();
    fixture.detectChanges();

    (rows[1]!.querySelector('.delete') as HTMLElement).click();
    fixture.detectChanges();
    expect(rows[1]!.querySelector('.confirm-label')!.textContent).toBe('Delete?');
  });
});
