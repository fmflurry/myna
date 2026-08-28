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
import { MeetingsShellPage } from './meetings-shell.page';

const readyModelsStatus: ModelsStatus = {
  parakeet: { present: true, expectedFiles: [] },
  qwen: { present: true, expectedFiles: [] },
  silero: { present: true, expectedFiles: [] },
  allPresent: true,
};

describe('MeetingsShellPage', () => {
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
  const setSplitRatio = vi.fn((ratio: number) => void ratio);
  const setTranscriptCollapsed = vi.fn((collapsed: boolean) => void collapsed);

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
    routeParamMap = new BehaviorSubject<ParamMap>(convertToParamMap({}));
    Object.values({
      loadMeetings, loadTemplates, checkModels, loadDevices, checkSystemAudio,
      loadSummaryLanguages, loadAppVersion, loadAudioSources, loadSummary, openMeeting,
      startRecording, stopRecording, cancelRecording, deleteMeeting, renameMeeting,
      summarizeMeeting, cancelSummarization, exportMeeting, selectDevice, selectCaptureSource,
      selectAudioSource, selectSummaryLanguage, requestSystemAudioPermission,
      setSplitRatio, setTranscriptCollapsed,
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

  it('loads meetings, templates, models, devices, system-audio status, summary languages, the app version and audio sources on init', () => {
    createFixture();

    expect(loadMeetings).toHaveBeenCalledTimes(1);
    expect(loadTemplates).toHaveBeenCalledTimes(1);
    expect(checkModels).toHaveBeenCalledTimes(1);
    expect(loadDevices).toHaveBeenCalledTimes(1);
    expect(checkSystemAudio).toHaveBeenCalledTimes(1);
    expect(loadSummaryLanguages).toHaveBeenCalledTimes(1);
    expect(loadAppVersion).toHaveBeenCalledTimes(1);
    expect(loadAudioSources).toHaveBeenCalledTimes(1);
  });

  it('forwards an audio-source selection to the facade', () => {
    const fixture = createFixture();

    fixture.componentInstance.onAudioSourceSelected('app:teams');

    expect(selectAudioSource).toHaveBeenCalledWith('app:teams');
  });

  // Split-workspace layout forwarding (splitRatio/transcriptCollapsed) is
  // covered in `meetings-shell.page.split-layout.spec.ts` to keep this file
  // under the project's max-lines limit.

  it('forwards a summary-load request from the detail pane to the facade', () => {
    const fixture = createFixture();

    fixture.componentInstance.onSummaryLoadRequested({
      meetingId: toMeetingId('m1'),
      template: 'key-points',
      language: 'en',
    });

    expect(loadSummary).toHaveBeenCalledWith('m1', 'key-points', 'en');
  });

  it('forwards a summary-language-picker selection to the facade', () => {
    const fixture = createFixture();

    fixture.componentInstance.onSummaryLanguageSelected('fr');

    expect(selectSummaryLanguage).toHaveBeenCalledWith('fr');
  });

  it('opens the meeting from the route id param when present', () => {
    routeParamMap.next(convertToParamMap({ id: 'm42' }));
    createFixture();

    expect(openMeeting).toHaveBeenCalledWith('m42');
  });

  // Route-param reactivity regressions (a second sidebar selection stopped
  // updating the detail pane) and the busy-guard resume behavior are covered
  // in `meetings-shell.page.selection.spec.ts` to keep this file under the
  // project's max-lines limit.

  it('renders the brand logo and the always-visible record control', () => {
    const fixture = createFixture();

    const brand = fixture.nativeElement.querySelector('.brand');
    expect(brand.getAttribute('type')).toBe('button');
    expect(brand.getAttribute('aria-label')).toBe('Myna — go to meetings');
    expect(fixture.nativeElement.querySelector('app-record-control')).toBeTruthy();
  });

  it('renders the sidebar and detail pane as a two-pane layout', () => {
    const fixture = createFixture();

    expect(fixture.nativeElement.querySelector('app-meeting-sidebar')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('app-meeting-detail-pane')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.workspace')).toBeTruthy();
  });

  it('toggles the attribution modal from the About icon button', () => {
    const fixture = createFixture();
    expect(fixture.nativeElement.querySelector('app-attribution')).toBeNull();

    fixture.nativeElement.querySelector('.about-trigger').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-attribution')).toBeTruthy();
  });

  it('has no meeting-title input in the top bar, and can still start a recording with no title supplied', () => {
    const fixture = createFixture();

    expect(fixture.nativeElement.querySelector('.title-input')).toBeNull();

    fixture.componentInstance.onRecord();

    expect(startRecording).toHaveBeenCalledWith('', undefined);
  });

  it('navigates to the meeting route when a sidebar selection is made while idle', () => {
    const fixture = createFixture();
    const router = TestBed.inject(Router);
    const navigateSpy = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    fixture.componentInstance.onMeetingSelected(toMeetingId('m1'));

    expect(navigateSpy).toHaveBeenCalledWith(['/meetings/meeting', 'm1']);
  });

  it('ignores a sidebar selection while a recording is in progress', () => {
    recordingState.set('recording');
    const fixture = createFixture();
    const router = TestBed.inject(Router);
    const navigateSpy = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    fixture.componentInstance.onMeetingSelected(toMeetingId('m1'));

    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('deletes a meeting through the facade', () => {
    const fixture = createFixture();
    const router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);

    fixture.componentInstance.onMeetingDeleted(toMeetingId('m1'));

    expect(deleteMeeting).toHaveBeenCalledWith('m1');
  });

  it('renames the selected meeting through the facade', () => {
    const meeting: Meeting = {
      id: toMeetingId('m1'),
      title: 'Standup',
      createdAt: new Date(),
      durationSec: 60,
      summaries: [], archived: false,
      hasAudio: false,
    };
    selectedMeeting.set(meeting);
    const fixture = createFixture();

    fixture.componentInstance.onMeetingRenamed('Weekly standup');

    expect(renameMeeting).toHaveBeenCalledWith('m1', 'Weekly standup');
  });

  it('does nothing when a rename is requested with no meeting selected', () => {
    const fixture = createFixture();

    fixture.componentInstance.onMeetingRenamed('Weekly standup');

    expect(renameMeeting).not.toHaveBeenCalled();
  });

  it('starts, stops and cancels recording through the facade', () => {
    const fixture = createFixture();

    fixture.componentInstance.onRecord();
    fixture.componentInstance.onStop();
    fixture.componentInstance.onCancel();

    expect(startRecording).toHaveBeenCalledTimes(1);
    expect(stopRecording).toHaveBeenCalledTimes(1);
    expect(cancelRecording).toHaveBeenCalledTimes(1);
  });

  it('summarizes the selected meeting with the matching template object', () => {
    const meeting: Meeting = {
      id: toMeetingId('m1'),
      title: 'Standup',
      createdAt: new Date(),
      durationSec: 60,
      summaries: [], archived: false,
      hasAudio: false,
    };
    selectedMeeting.set(meeting);
    templates.set([{ name: 'key-points', description: '', prompt: '' }]);
    const fixture = createFixture();

    fixture.componentInstance.summarize('key-points');

    expect(summarizeMeeting).toHaveBeenCalledWith('m1', { name: 'key-points', description: '', prompt: '' });
  });

  // Non-blocking-summarization regressions live in `meetings-shell.page.progress.spec.ts`.
  it('exports the selected meeting with the chosen format', () => {
    const meeting: Meeting = {
      id: toMeetingId('m1'),
      title: 'Standup',
      createdAt: new Date(),
      durationSec: 60,
      summaries: [], archived: false,
      hasAudio: false,
    };
    selectedMeeting.set(meeting);
    const fixture = createFixture();

    fixture.componentInstance.exportMeeting('json');

    expect(exportMeeting).toHaveBeenCalledTimes(1);
    const call = exportMeeting.mock.calls[0];
    expect(call?.[0]).toBe('m1');
    expect(call?.[1]).toBe('json');
    expect(call?.[2]).toContain('Standup');
  });
});
