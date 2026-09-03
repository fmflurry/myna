import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, type ParamMap } from '@angular/router';
import { BehaviorSubject, EMPTY } from 'rxjs';
import { afterEach, beforeEach, vi } from 'vitest';

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
import { MeetingsShellPage } from './meetings-shell.page';

/**
 * Diarization is MANUAL-ONLY per ADR 0009: the single entry point is the
 * detail pane's "Detect speakers" button, which routes through
 * `onDiarizeRequested()` → `facade.diarizeMeeting(id)`. Stopping a recording
 * must NEVER trigger speaker detection on its own — not even for a
 * mixed/system recording whose diarization models are on disk. The retired
 * auto-run gate (`shouldAutoDiarizeAfterStop` / `runStopRecording`'s
 * continuation) is what assertion (a) below pins shut: it fails against code
 * that still auto-diarizes after `stopRecording` resolves.
 *
 * The manual path keeps its own in-flight guard (`diarizing`): re-triggering
 * while a run is pending must not fire a second `diarizeMeeting`, and the
 * pane button mirrors that state (disabled while `diarizing`).
 */

const baseModels: ModelsStatus = {
  parakeet: { present: true, expectedFiles: [] },
  qwen: { present: true, expectedFiles: [] },
  silero: { present: true, expectedFiles: [] },
  allPresent: true,
};

const diarizationReadyModels: ModelsStatus = {
  ...baseModels,
  diarization: { present: true, expectedFiles: [] },
};

describe('MeetingsShellPage — manual-only diarization (ADR 0009)', () => {
  const meetings = signal<readonly Meeting[]>([]);
  const selectedMeeting = signal<Meeting | undefined>(undefined);
  const modelsStatus = signal<ModelsStatus | undefined>(diarizationReadyModels);
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
  const captureSource = signal<CaptureSource>('mixed');
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
  const diarizeMeeting = vi.fn(async (id: string): Promise<void> => {
    void id;
  });

  const meetingWith = (hasSystemTrack: boolean): Meeting => ({
    id: toMeetingId('m1'),
    title: 'Standup',
    createdAt: new Date(),
    durationSec: 60,
    transcript: { segments: [] },
    summaries: [],
    archived: false,
    hasAudio: true,
    hasSystemTrack,
    droppedAudioChunks: 0,
  });

  let stopFailure: MeetingsErrorInfo | undefined;
  let stoppedMeeting: Meeting = meetingWith(true);

  /** Resolves once the in-flight `stopRecording` call settles, so specs can await the stop before asserting. */
  let stopDone: Promise<void> = Promise.resolve();
  const stopRecording = vi.fn((): Promise<void> => {
    stopDone = (async (): Promise<void> => {
      recordingState.set('idle');
      error.set(stopFailure);
      if (stopFailure === undefined) {
        selectedMeeting.set(stoppedMeeting);
        meetings.set([stoppedMeeting]);
      }
    })();
    return stopDone;
  });

  const facadeStub = {
    settingsRequests: () => EMPTY,
    activeRecording: signal(null),
    resumeActiveRecording: vi.fn(async () => undefined),
    meetings, selectedMeeting, modelsStatus, devices, selectedDevice, recordingState, level,
    finalizedSegments, partialTextMe, partialTextOthers, error, busy, systemAudioStatus, captureSource, templates,
    summaryStream, summarizing, summarizingKey, startingRecording, summaryLanguages, selectedSummaryLanguage,
    summaryCache, appVersion, audioSources, selectedAudioSource, effectiveSystemSource,
    splitRatio, transcriptCollapsed, importing, importProgress, folders, expandedFolders,
    diarizeMeeting, stopRecording,
    loadMeetings: vi.fn(noop), loadTemplates: vi.fn(noop), checkModels: vi.fn(noop), loadDevices: vi.fn(noop),
    checkSystemAudio: vi.fn(noop), loadSummaryLanguages: vi.fn(noop), loadAppVersion: vi.fn(noop),
    loadAudioSources: vi.fn(noop), loadSummary: vi.fn(noop), openMeeting: vi.fn(noop),
    startRecording: vi.fn(noop), cancelRecording: vi.fn(noop), clearSelection: vi.fn(),
    deleteMeeting: vi.fn(noop), renameMeeting: vi.fn(noop), summarizeMeeting: vi.fn(noop),
    cancelSummarization: vi.fn(noop), exportMeeting: vi.fn(noop), selectDevice: vi.fn(),
    selectCaptureSource: vi.fn(), selectAudioSource: vi.fn(), selectSummaryLanguage: vi.fn(),
    requestSystemAudioPermission: vi.fn(noop), editTranscriptSegment: vi.fn(noop),
    setSplitRatio: vi.fn(), setTranscriptCollapsed: vi.fn(), setMeetingArchived: vi.fn(noop),
    loadFolders: vi.fn(noop), createFolder: vi.fn(noop), renameFolder: vi.fn(noop),
    deleteFolder: vi.fn(noop), toggleFolderExpanded: vi.fn(),
    speakerHistory: signal([]),
    transcriptUndo: signal(null),
    modelDownload: signal(undefined),
    updates: NOOP_UPDATES_FACADE_STUB,
  } as unknown as MeetingsFacade;

  beforeEach(() => {
    diarizeMeeting.mockClear();
    stopRecording.mockClear();
    stopFailure = undefined;
    stoppedMeeting = meetingWith(true);
    modelsStatus.set(diarizationReadyModels);
    selectedMeeting.set(undefined);
    meetings.set([]);
    recordingState.set('idle');
    error.set(undefined);
    const routeParamMap = new BehaviorSubject<ParamMap>(convertToParamMap({}));
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: MeetingsFacade, useValue: facadeStub },
        { provide: ActivatedRoute, useValue: { paramMap: routeParamMap } },
      ],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const createFixture = () => {
    const fixture = TestBed.createComponent(MeetingsShellPage);
    fixture.detectChanges();
    return fixture;
  };

  /** Let the stop resolve, then flush any continuation chained off `await stopRecording()`. */
  const settleStop = async (): Promise<void> => {
    await stopDone;
    await Promise.resolve();
    await Promise.resolve();
  };

  // (a) THE manual-only pin: a stop that WOULD have satisfied every former
  // auto-diarize precondition (clean stop, system track, models on disk)
  // must still leave diarization untouched. Fails against the auto-run gate.
  it('never diarizes after onStop, even for a system-track meeting with diarization models present', async () => {
    const fixture = createFixture();

    fixture.componentInstance.onStop();
    await settleStop();

    expect(stopRecording).toHaveBeenCalledTimes(1);
    expect(diarizeMeeting).not.toHaveBeenCalled();
  });

  // (b) The manual button path is the one and only trigger.
  it('diarizes the selected meeting exactly once via onDiarizeRequested', async () => {
    selectedMeeting.set(meetingWith(true));
    const fixture = createFixture();

    fixture.componentInstance.onDiarizeRequested();
    await settleStop();

    expect(diarizeMeeting).toHaveBeenCalledTimes(1);
    expect(diarizeMeeting).toHaveBeenCalledWith('m1');
  });

  // (c) Re-entry guard on the manual path: while a run is in flight, a second
  // trigger is dropped AND the pane button mirrors the busy state.
  it('ignores a second onDiarizeRequested while one is in flight and disables the Detect speakers button', async () => {
    let releaseDiarize: (() => void) | undefined;
    diarizeMeeting.mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseDiarize = resolve; }),
    );
    selectedMeeting.set(meetingWith(true));
    const fixture = createFixture();

    fixture.componentInstance.onDiarizeRequested();
    fixture.componentInstance.onDiarizeRequested();

    expect(diarizeMeeting).toHaveBeenCalledTimes(1);

    // The pane button mirrors the in-flight state (disabled while `diarizing`).
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector('.detect-speakers') as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    releaseDiarize?.();
    await settleStop();
  });

  // (d) The retired gate's exclusions stay excluded — and more strongly: no
  // onStop ever diarizes, whatever the meeting looks like.
  it('never diarizes after a stop of a mic-only recording (no system track)', async () => {
    stoppedMeeting = meetingWith(false);
    const fixture = createFixture();

    fixture.componentInstance.onStop();
    await settleStop();

    expect(stopRecording).toHaveBeenCalledTimes(1);
    expect(diarizeMeeting).not.toHaveBeenCalled();
  });

  it('never diarizes after a stop when the diarization models are absent', async () => {
    modelsStatus.set(baseModels);
    const fixture = createFixture();

    fixture.componentInstance.onStop();
    await settleStop();

    expect(stopRecording).toHaveBeenCalledTimes(1);
    expect(diarizeMeeting).not.toHaveBeenCalled();
  });
});
