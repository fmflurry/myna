import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter, convertToParamMap, type ParamMap } from '@angular/router';
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
import { transcriptSegment } from '../../../application/testing/transcript-segment.factory';
import { MeetingsShellPage } from './meetings-shell.page';

const readyModelsStatus: ModelsStatus = {
  parakeet: { present: true, expectedFiles: [] },
  qwen: { present: true, expectedFiles: [] },
  silero: { present: true, expectedFiles: [] },
  allPresent: true,
};

/**
 * End-to-end chip-menu speaker ops: real `MeetingsShellPage` renders the real
 * detail pane and the real transcript view; only `MeetingsFacade` is stubbed.
 * Every op is driven through actual DOM events (chip click → menu item /
 * rename input), so a dropped binding at ANY hop of
 * transcript-view → pane → shell → facade fails this spec — which is exactly
 * how the rename path shipped broken.
 */
describe('MeetingsShellPage — speaker chip-menu ops', () => {
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
  const folders = signal<readonly never[]>([]);
  const expandedFolders = signal<ReadonlySet<never>>(new Set());

  const noop = async (): Promise<void> => undefined;
  const renameSpeaker = vi.fn(async (id: string, label: string, name: string): Promise<void> => {
    void id; void label; void name;
  });
  const removeSpeaker = vi.fn(async (id: string, label: string): Promise<void> => {
    void id; void label;
  });
  const setSegmentSpeaker = vi.fn(async (id: string, index: number, speaker: string): Promise<void> => {
    void id; void index; void speaker;
  });
  const setSegmentSpeakers = vi.fn(async (id: string, indices: readonly number[], speaker: string): Promise<void> => {
    void id; void indices; void speaker;
  });

  const facadeStub = {
    settingsRequests: () => EMPTY,
    activeRecording: signal(null),
    resumeActiveRecording: vi.fn(async () => undefined),
    meetings, selectedMeeting, modelsStatus, devices, selectedDevice, recordingState, level,
    finalizedSegments, partialTextMe, partialTextOthers, error, busy, systemAudioStatus, captureSource, templates,
    summaryStream, summarizing, summarizingKey, startingRecording, summaryLanguages, selectedSummaryLanguage,
    summaryCache, appVersion, audioSources, selectedAudioSource, effectiveSystemSource,
    splitRatio, transcriptCollapsed, sidebarWidth, sidebarCollapsed, importing, importProgress,
    renameSpeaker, removeSpeaker, setSegmentSpeaker, setSegmentSpeakers,
    loadMeetings: vi.fn(noop), loadTemplates: vi.fn(noop), checkModels: vi.fn(noop), loadDevices: vi.fn(noop),
    checkSystemAudio: vi.fn(noop), loadSummaryLanguages: vi.fn(noop), loadAppVersion: vi.fn(noop),
    loadSummaryGuidelines: vi.fn(async () => undefined), setSummaryGuidelines: vi.fn(async () => undefined), summaryGuidelines: signal(''), summaryInstructionDraft: () => ({ text: '', includeGeneral: true }), setSummaryInstructionDraft: vi.fn(),
    loadAudioSources: vi.fn(noop), loadSummary: vi.fn(noop), openMeeting: vi.fn(noop), clearSelection: vi.fn(),
    startRecording: vi.fn(noop), stopRecording: vi.fn(noop), cancelRecording: vi.fn(noop),
    deleteMeeting: vi.fn(noop), renameMeeting: vi.fn(noop), summarizeMeeting: vi.fn(noop),
    cancelSummarization: vi.fn(noop), exportMeeting: vi.fn(noop), selectDevice: vi.fn(),
    selectCaptureSource: vi.fn(), selectAudioSource: vi.fn(), selectSummaryLanguage: vi.fn(),
    requestSystemAudioPermission: vi.fn(noop), editTranscriptSegment: vi.fn(noop),
    setSplitRatio: vi.fn(), setTranscriptCollapsed: vi.fn(), setSidebarWidth: vi.fn(), setSidebarCollapsed: vi.fn(), setMeetingArchived: vi.fn(noop),
    folders, expandedFolders, loadFolders: vi.fn(noop), createFolder: vi.fn(noop), renameFolder: vi.fn(noop),
    deleteFolder: vi.fn(noop), toggleFolderExpanded: vi.fn(),
    speakerHistory: signal([]),
transcriptUndo: signal(null),
modelDownload: signal(undefined),
    updates: NOOP_UPDATES_FACADE_STUB,
  } as unknown as MeetingsFacade;

  const meetingWith = (segments: readonly TranscriptSegment[], speakerNames?: Readonly<Record<string, string>>): Meeting => ({
    id: toMeetingId('m1'),
    title: 'Standup',
    createdAt: new Date(),
    durationSec: 60,
    transcript: { segments },
    summaries: [],
    archived: false,
    hasAudio: false,
    hasSystemTrack: false,
    droppedAudioChunks: 0,
    ...(speakerNames ? { speakerNames } : {}),
  });

  beforeEach(() => {
    renameSpeaker.mockClear();
    removeSpeaker.mockClear();
    setSegmentSpeaker.mockClear();
    setSegmentSpeakers.mockClear();
    selectedMeeting.set(undefined);
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

  const chips = (fixture: ReturnType<typeof createFixture>): HTMLButtonElement[] =>
    Array.from(fixture.nativeElement.querySelectorAll('.speaker-chip'));

  const chipTexts = (fixture: ReturnType<typeof createFixture>): string[] =>
    chips(fixture).map((chip) => chip.textContent?.trim() ?? '');

  const menuItem = (fixture: ReturnType<typeof createFixture>, text: string): HTMLButtonElement => {
    const option = Array.from(
      fixture.nativeElement.querySelectorAll('.speaker-menu [role="menuitem"]'),
    ).find((el) => (el as HTMLElement).textContent?.trim() === text);
    if (!option) {
      throw new Error(`Menu item "${text}" not found`);
    }
    return option as HTMLButtonElement;
  };

  it('renames a speaker through the chip menu and re-renders EVERY occurrence with the new name', () => {
    selectedMeeting.set(
      meetingWith([
        transcriptSegment({ startSec: 0, endSec: 5, text: 'first', speaker: 'others:1' }),
        transcriptSegment({ startSec: 5, endSec: 10, text: 'second', speaker: 'others' }),
        transcriptSegment({ startSec: 10, endSec: 15, text: 'third', speaker: 'others:1' }),
      ]),
    );
    const fixture = createFixture();
    expect(chipTexts(fixture)).toEqual(['Others 1', 'Others', 'Others 1']);

    chips(fixture)[0]!.click();
    fixture.detectChanges();
    const input: HTMLInputElement = fixture.nativeElement.querySelector('.rename-row input');
    input.value = 'François';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

    expect(renameSpeaker).toHaveBeenCalledWith('m1', 'others:1', 'François');

    // The facade mirrors the persisted meeting back through the signal — the
    // rename must now show on BOTH `others:1` chips, not just the clicked one.
    selectedMeeting.set(
      meetingWith(
        [
          transcriptSegment({ startSec: 0, endSec: 5, text: 'first', speaker: 'others:1' }),
          transcriptSegment({ startSec: 5, endSec: 10, text: 'second', speaker: 'others' }),
          transcriptSegment({ startSec: 10, endSec: 15, text: 'third', speaker: 'others:1' }),
        ],
        { 'others:1': 'François' },
      ),
    );
    fixture.detectChanges();
    expect(chipTexts(fixture)).toEqual(['François', 'Others', 'François']);
  });

  it('removes a speaker via the confirm-guarded menu item', () => {
    selectedMeeting.set(
      meetingWith([transcriptSegment({ startSec: 0, endSec: 5, text: 'first', speaker: 'others:1' })], {
        'others:1': 'Jean',
      }),
    );
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fixture = createFixture();

    chips(fixture)[0]!.click();
    fixture.detectChanges();
    menuItem(fixture, 'Remove speaker…').click();

    expect(confirmSpy).toHaveBeenCalled();
    expect(removeSpeaker).toHaveBeenCalledWith('m1', 'others:1');
  });

  it('does not call the facade when the removal is declined', () => {
    selectedMeeting.set(
      meetingWith([transcriptSegment({ startSec: 0, endSec: 5, text: 'first', speaker: 'others:1' })]),
    );
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const fixture = createFixture();

    chips(fixture)[0]!.click();
    fixture.detectChanges();
    menuItem(fixture, 'Remove speaker…').click();

    expect(removeSpeaker).not.toHaveBeenCalled();
  });

  it('reassigns a single-segment chip through the menu', () => {
    selectedMeeting.set(
      meetingWith([
        transcriptSegment({ startSec: 0, endSec: 5, text: 'first', speaker: 'others:1' }),
        transcriptSegment({ startSec: 5, endSec: 10, text: 'second', speaker: 'others' }),
      ]),
    );
    const fixture = createFixture();

    chips(fixture)[1]!.click();
    fixture.detectChanges();
    menuItem(fixture, 'Me').click();

    expect(setSegmentSpeaker).toHaveBeenCalledWith('m1', 1, 'me');
  });

  it('reassigns a multi-segment group as one batched call', () => {
    selectedMeeting.set(
      meetingWith([
        transcriptSegment({ startSec: 0, endSec: 5, text: 'first', speaker: 'others:1' }),
        transcriptSegment({ startSec: 5, endSec: 10, text: 'second', speaker: 'others:1' }),
        transcriptSegment({ startSec: 10, endSec: 15, text: 'third', speaker: 'others' }),
      ]),
    );
    const fixture = createFixture();

    chips(fixture)[0]!.click();
    fixture.detectChanges();
    menuItem(fixture, 'Me').click();

    expect(setSegmentSpeakers).toHaveBeenCalledWith('m1', [0, 1], 'me');
    expect(setSegmentSpeaker).not.toHaveBeenCalled();
  });

  it('is a no-op for every speaker op when no meeting is selected', () => {
    selectedMeeting.set(undefined);
    const fixture = createFixture();

    fixture.componentInstance.onSpeakerRenamed({ label: 'others:1', name: 'Jean' });
    fixture.componentInstance.onSpeakerRemoved('others:1');
    fixture.componentInstance.onSegmentSpeakerReassigned({ index: 0, speaker: 'me' });
    fixture.componentInstance.onSegmentGroupSpeakerReassigned({ indices: [0, 1], speaker: 'me' });

    expect(renameSpeaker).not.toHaveBeenCalled();
    expect(removeSpeaker).not.toHaveBeenCalled();
    expect(setSegmentSpeaker).not.toHaveBeenCalled();
    expect(setSegmentSpeakers).not.toHaveBeenCalled();
  });

  /** Flushes the microtask/timeout queue so chained promise continuations settle. */
  const flush = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it('serialises consecutive speaker ops: a rename queued behind an in-flight reassign waits for it to settle', async () => {
    selectedMeeting.set(
      meetingWith([transcriptSegment({ startSec: 0, endSec: 5, text: 'first', speaker: 'unknown' })]),
    );
    let settleReassign: () => void = () => undefined;
    setSegmentSpeaker.mockImplementationOnce(
      () => new Promise<void>((resolve) => { settleReassign = resolve; }),
    );
    const fixture = createFixture();

    // Mirrors `NewSpeakerInput.commit`: the reassign is emitted synchronously
    // THEN the rename keyed on the minted label. Both are unlocked
    // read-modify-writes of meeting.json on the Rust side — they must never
    // overlap, or the rename's write races the reassign's read.
    fixture.componentInstance.onSegmentSpeakerReassigned({ index: 0, speaker: 'others:m1' });
    fixture.componentInstance.onSpeakerRenamed({ label: 'others:m1', name: 'Jean' });

    // An idle queue dispatches immediately, so the reassign is already in flight.
    expect(setSegmentSpeaker).toHaveBeenCalledWith('m1', 0, 'others:m1');
    expect(renameSpeaker).not.toHaveBeenCalled();

    settleReassign();
    await flush();

    expect(renameSpeaker).toHaveBeenCalledWith('m1', 'others:m1', 'Jean');
  });

  it('never wedges the queue: a rejected speaker op still lets the next queued op run', async () => {
    selectedMeeting.set(
      meetingWith([transcriptSegment({ startSec: 0, endSec: 5, text: 'first', speaker: 'unknown' })]),
    );
    setSegmentSpeaker.mockImplementationOnce(() => Promise.reject(new Error('backend down')));
    const fixture = createFixture();

    fixture.componentInstance.onSegmentSpeakerReassigned({ index: 0, speaker: 'others:m1' });
    fixture.componentInstance.onSpeakerRenamed({ label: 'others:m1', name: 'Jean' });

    await flush();

    expect(renameSpeaker).toHaveBeenCalledWith('m1', 'others:m1', 'Jean');
  });
});
