import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, convertToParamMap, provideRouter, type ParamMap } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MeetingsFacade } from '../../../application/facades/meetings.facade';
import type { ActiveRecording } from '../../../application/stores/meetings.store';
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
import { transcriptSegment } from '../../../application/testing/transcript-segment.factory';
import { MeetingSidebarComponent } from '../../components/meeting-sidebar/meeting-sidebar.component';
import { MeetingsShellPage } from './meetings-shell.page';

const readyModelsStatus: ModelsStatus = {
  parakeet: { present: true, expectedFiles: [] },
  qwen: { present: true, expectedFiles: [] },
  silero: { present: true, expectedFiles: [] },
  allPresent: true,
};

/**
 * ADR 0011 Phase 2, page level: after a webview reload mid-meeting, boot must
 * re-attach the shell to the live session — Stop branch visible, timer seeded
 * from the backend's elapsed clock (not 00:00), journaled finals rendered.
 * The facade is stubbed here to pin the page's OWN responsibilities (call
 * resume on init; seed the timer from ACTIVE_RECORDING; prefer the slot for
 * the sidebar's recording marker). The end-to-end wiring is the routed
 * integration spec's job.
 */
describe('MeetingsShellPage boot resume (ADR 0011)', () => {
  const meetings = signal<readonly Meeting[]>([]);
  const selectedMeeting = signal<Meeting | undefined>(undefined);
  const modelsStatus = signal<ModelsStatus | undefined>(readyModelsStatus);
  const devices = signal<readonly AudioDevice[]>([]);
  const selectedDevice = signal<AudioDevice | null>(null);
  const recordingState = signal<RecordingState>('idle');
  const activeRecording = signal<ActiveRecording | null>(null);
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
  const folders = signal<readonly never[]>([]);
  const expandedFolders = signal<ReadonlySet<never>>(new Set());

  const resumed = vi.fn(async () => undefined);
  const noop = (): undefined => undefined;

  /** Mirrors `runResumeActiveRecording`: the store writes land after the query resolves. */
  const stubLiveSessionAtBoot = (meeting: Meeting, elapsedSec: number, segments: readonly TranscriptSegment[]): void => {
    resumed.mockImplementation(async () => {
      selectedMeeting.set(meeting);
      meetings.set([meeting]);
      finalizedSegments.set(segments);
      activeRecording.set({ meetingId: meeting.id, elapsedSec });
      recordingState.set('recording');
    });
  };

  const facadeStub = {
    meetings, selectedMeeting, modelsStatus, devices, selectedDevice, recordingState, activeRecording, level,
    finalizedSegments, partialTextMe, partialTextOthers, error, busy, systemAudioStatus, captureSource, templates,
    summaryStream, summarizing, summarizingKey, startingRecording, summaryLanguages, selectedSummaryLanguage,
    summaryCache, appVersion, audioSources, selectedAudioSource, effectiveSystemSource,
    splitRatio, transcriptCollapsed, importing, importProgress: signal(null),
    folders, expandedFolders, speakerHistory: signal([]), transcriptUndo: signal(null),
    modelDownload: signal(undefined),
    resumeActiveRecording: resumed,
    loadMeetings: vi.fn(noop), loadTemplates: vi.fn(noop), checkModels: vi.fn(noop), loadDevices: vi.fn(noop),
    checkSystemAudio: vi.fn(noop), loadSummaryLanguages: vi.fn(noop), loadAppVersion: vi.fn(noop),
    loadAudioSources: vi.fn(noop), loadFolders: vi.fn(noop), loadSummary: vi.fn(noop), openMeeting: vi.fn(noop),
    startRecording: vi.fn(noop), stopRecording: vi.fn(noop), cancelRecording: vi.fn(noop),
    clearSelection: vi.fn(noop), clearError: vi.fn(noop),
    updates: NOOP_UPDATES_FACADE_STUB,
  } as unknown as MeetingsFacade;

  let routeParamMap: BehaviorSubject<ParamMap>;

  const recordingMeeting: Meeting = {
    id: toMeetingId('m-live'),
    title: 'Standup',
    createdAt: new Date(),
    durationSec: 0,
    summaries: [],
    archived: false,
    hasAudio: false,
    hasSystemTrack: false,
    droppedAudioChunks: 0,
  };

  beforeEach(() => {
    meetings.set([]);
    selectedMeeting.set(undefined);
    recordingState.set('idle');
    activeRecording.set(null);
    finalizedSegments.set([]);
    resumed.mockImplementation(async () => undefined);
    routeParamMap = new BehaviorSubject<ParamMap>(convertToParamMap({}));
    vi.useFakeTimers();
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

  /** Drains the resume promise chain (each `await` is one microtask hop). */
  const settleResume = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(0);
  };

  it('re-attaches on boot: calls resumeActiveRecording exactly once', async () => {
    createFixture();
    await settleResume();

    expect(resumed).toHaveBeenCalledTimes(1);
  });

  it('renders the Stop branch after boot with a live session', async () => {
    stubLiveSessionAtBoot(recordingMeeting, 125, []);

    const fixture = createFixture();
    await settleResume();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('button.stop')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('button.record')).toBeNull();
  });

  it('seeds the elapsed label from ACTIVE_RECORDING instead of 00:00', async () => {
    stubLiveSessionAtBoot(recordingMeeting, 125, []);

    const fixture = createFixture();
    await settleResume();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.timer').textContent.trim()).toBe('02:05');
  });

  it('keeps ticking from the seeded baseline', async () => {
    stubLiveSessionAtBoot(recordingMeeting, 125, []);

    const fixture = createFixture();
    await settleResume();
    fixture.detectChanges();

    await vi.advanceTimersByTimeAsync(3000);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.timer').textContent.trim()).toBe('02:08');
  });

  it('a live-started (non-resumed) recording still begins at 00:00', async () => {
    // No resume write happens — exactly what a fresh start looks like: state
    // flips via events with ACTIVE_RECORDING null, so the baseline is 0.
    recordingState.set('recording');

    const fixture = createFixture();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.timer').textContent.trim()).toBe('00:00');
  });

  it('marks the RESTORED session as the recording meeting, not the route-selected one', async () => {
    const otherMeeting: Meeting = { ...recordingMeeting, id: toMeetingId('m-other'), title: 'Planning' };
    stubLiveSessionAtBoot(recordingMeeting, 125, []);
    // Route points at a DIFFERENT meeting; the restored slot must win.
    routeParamMap.next(convertToParamMap({ id: 'm-other' }));
    selectedMeeting.set(otherMeeting);

    const fixture = createFixture();
    await settleResume();
    fixture.detectChanges();

    const sidebar = fixture.debugElement.query(By.directive(MeetingSidebarComponent));
    // `recordingMeetingId` is a signal input — read it by invoking the getter.
    const sidebarView = sidebar.componentInstance as { recordingMeetingId: () => string | undefined };
    expect(sidebarView.recordingMeetingId()).toBe(toMeetingId('m-live'));
  });

  it('renders the journaled finals in the live transcript after boot', async () => {
    stubLiveSessionAtBoot(recordingMeeting, 125, [
      transcriptSegment({ startSec: 0, endSec: 5, text: 'Welcome everyone.', speaker: 'me' }),
      transcriptSegment({ startSec: 6, endSec: 11, text: 'Hi there.', speaker: 'others' }),
    ]);

    const fixture = createFixture();
    await settleResume();
    fixture.detectChanges();

    const texts = Array.from(
      fixture.nativeElement.querySelectorAll('app-live-transcript .final .text') as NodeListOf<Element>,
    ).map((node: Element) => node.textContent?.trim());
    expect(texts).toEqual(['Welcome everyone.', 'Hi there.']);
  });
});
