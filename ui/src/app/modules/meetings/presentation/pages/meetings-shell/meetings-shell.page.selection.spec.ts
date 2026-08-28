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
import { RecordControlComponent } from '../../components/record-control/record-control.component';
import { MeetingsShellPage } from './meetings-shell.page';

const readyModelsStatus: ModelsStatus = {
  parakeet: { present: true, expectedFiles: [] },
  qwen: { present: true, expectedFiles: [] },
  silero: { present: true, expectedFiles: [] },
  allPresent: true,
};

/**
 * Regression coverage for the "selecting a meeting in the sidebar works
 * once, then the detail pane never updates again" bug. Root cause: `''` and
 * `meeting/:id` share `MeetingsShellPage`, and Angular's default route
 * reuse strategy keeps ONE instance alive across `meeting/:id` ->
 * `meeting/:id` navigations (only the param differs) — `ngOnInit`'s
 * one-time `route.snapshot.paramMap` read never re-ran, so a second
 * selection was silently dropped forever. The fix subscribes to the
 * reactive `route.paramMap` instead. Also covers the busy-guard resuming
 * cleanly once a recording finishes.
 */
describe('MeetingsShellPage route-selection reactivity', () => {
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

  it(
    'opens the newly selected meeting when the route id param changes, without recreating the component',
    () => {
      // Pre-fix, this test failed: `openMeeting` was called once with 'm1'
      // and never again after `routeParamMap.next(...'m2')`, because
      // `ngOnInit` only read `route.snapshot.paramMap` once and the reused
      // component instance never re-ran it.
      routeParamMap.next(convertToParamMap({ id: 'm1' }));
      createFixture();
      expect(openMeeting).toHaveBeenCalledWith('m1');

      routeParamMap.next(convertToParamMap({ id: 'm2' }));

      expect(openMeeting).toHaveBeenCalledWith('m2');
      expect(openMeeting).toHaveBeenCalledTimes(2);
    },
  );

  it('re-opens a previously selected meeting when navigating A -> B -> A', () => {
    routeParamMap.next(convertToParamMap({ id: 'm1' }));
    createFixture();

    routeParamMap.next(convertToParamMap({ id: 'm2' }));
    routeParamMap.next(convertToParamMap({ id: 'm1' }));

    expect(openMeeting.mock.calls.map((call) => call[0])).toEqual(['m1', 'm2', 'm1']);
  });

  it('does not re-open the same meeting twice for a duplicate route emission', () => {
    routeParamMap.next(convertToParamMap({ id: 'm1' }));
    createFixture();

    routeParamMap.next(convertToParamMap({ id: 'm1' }));

    expect(openMeeting).toHaveBeenCalledTimes(1);
  });

  it('navigates to a selection made immediately after a recording finishes', () => {
    recordingState.set('recording');
    const fixture = createFixture();
    const router = TestBed.inject(Router);
    const navigateSpy = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    fixture.componentInstance.onMeetingSelected(toMeetingId('m1'));
    expect(navigateSpy).not.toHaveBeenCalled();

    recordingState.set('idle');
    fixture.componentInstance.onMeetingSelected(toMeetingId('m1'));

    expect(navigateSpy).toHaveBeenCalledWith(['/meetings/meeting', 'm1']);
  });

  it('falls back to an unknown (not unavailable) system-audio status before checkSystemAudio resolves', () => {
    systemAudioStatus.set(undefined);
    const fixture = createFixture();

    const recordControl = fixture.debugElement.query(By.directive(RecordControlComponent))
      .componentInstance as RecordControlComponent;
    expect(recordControl.systemAudioStatus()).toEqual({ kind: 'unknown' });
  });
});
