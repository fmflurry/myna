import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, type ParamMap } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { afterEach, beforeEach, vi } from 'vitest';

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

/**
 * Manual "Detect speakers" stays available, but a finished mixed/system
 * recording now diarizes itself the moment `stopRecording` resolves — no
 * extra click. Gated on: no error from the stop, the meeting actually has a
 * `track-system.wav` (mic-only recordings can't be diarized; the backend
 * returns NotFound for them), and the diarization models are on disk.
 *
 * Pinned (manually corrected) segments survive the relabel
 * backend-side — see crates/myna-stt/src/relabel.rs:64 — so auto-diarizing
 * right after stop can never clobber manual speaker edits. No UI guard
 * needed for that invariant; this spec just documents it.
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

describe('MeetingsShellPage — auto-diarization after stop', () => {
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

  /** Resolves once the in-flight `stopRecording` call settles, so specs can await the auto-diarize gate before asserting. */
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

  /** Let the stop resolve, then flush the auto-diarize continuation off `await stopRecording()`. */
  const settleStop = async (): Promise<void> => {
    await stopDone;
    await Promise.resolve();
    await Promise.resolve();
  };

  it('diarizes exactly once after a successful stop of a system-track meeting with models present', async () => {
    const fixture = createFixture();

    fixture.componentInstance.onStop();
    await settleStop();

    expect(diarizeMeeting).toHaveBeenCalledTimes(1);
    expect(diarizeMeeting).toHaveBeenCalledWith('m1');
  });

  it('never diarizes a mic-only recording (no system track)', async () => {
    stoppedMeeting = meetingWith(false);
    const fixture = createFixture();

    fixture.componentInstance.onStop();
    await settleStop();

    expect(stopRecording).toHaveBeenCalledTimes(1);
    expect(diarizeMeeting).not.toHaveBeenCalled();
  });

  it('never diarizes when the diarization models are absent', async () => {
    modelsStatus.set(baseModels);
    const fixture = createFixture();

    fixture.componentInstance.onStop();
    await settleStop();

    expect(diarizeMeeting).not.toHaveBeenCalled();
  });

  it('never diarizes when the diarization slot reports not present', async () => {
    modelsStatus.set({ ...baseModels, diarization: { present: false, expectedFiles: [] } });
    const fixture = createFixture();

    fixture.componentInstance.onStop();
    await settleStop();

    expect(diarizeMeeting).not.toHaveBeenCalled();
  });

  it('never diarizes when the stop failed (error slot set)', async () => {
    stopFailure = { code: 'IO', message: 'flush failed' };
    const fixture = createFixture();

    fixture.componentInstance.onStop();
    await settleStop();

    expect(diarizeMeeting).not.toHaveBeenCalled();
  });

  it('a manual "Detect speakers" click during the auto-run never fires a second diarize', async () => {
    let releaseDiarize: (() => void) | undefined;
    diarizeMeeting.mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseDiarize = resolve; }),
    );
    const fixture = createFixture();

    fixture.componentInstance.onStop();
    await vi.waitFor(() => expect(diarizeMeeting).toHaveBeenCalledTimes(1));
    fixture.detectChanges();

    // The pane button mirrors the in-flight state (disabled while `diarizing`).
    const button = fixture.nativeElement.querySelector('.detect-speakers') as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    // And the shell itself is idempotent even if the op is re-triggered directly.
    fixture.componentInstance.onDiarizeRequested();
    expect(diarizeMeeting).toHaveBeenCalledTimes(1);

    releaseDiarize?.();
    await settleStop();
  });
});
