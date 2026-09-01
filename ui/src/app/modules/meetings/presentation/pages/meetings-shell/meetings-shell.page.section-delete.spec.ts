import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter, convertToParamMap, type ParamMap } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { afterEach, beforeEach, vi } from 'vitest';

import { MeetingsFacade } from '../../../application/facades/meetings.facade';
import type { MeetingsErrorInfo } from '../../../application/stores/meetings.store';
import type { TranscriptOp } from '../../../application/stores/transcript-history.model';
import type { SpeakerOp } from '../../../application/stores/speaker-history.model';
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

const meetingId = toMeetingId('m1');

/**
 * End-to-end "Delete section…" + undo affordance: real shell → real pane →
 * real transcript view; only `MeetingsFacade` is stubbed (its undo slot
 * signals included), driven through actual DOM events. Mirrors
 * `meetings-shell.page.speaker-ops.spec.ts`'s wiring.
 */
describe('MeetingsShellPage — section delete + undo', () => {
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
  const importing = signal(false);
  const importProgress = signal<ImportProgress | null>(null);
  const folders = signal<readonly never[]>([]);
  const expandedFolders = signal<ReadonlySet<never>>(new Set());
  const transcriptUndo = signal<TranscriptOp | null>(null);
  const speakerHistory = signal<readonly SpeakerOp[]>([]);

  const noop = async (): Promise<void> => undefined;
  const intro = transcriptSegment({ startSec: 0, endSec: 5, text: 'intro', speaker: 'me' });
  const yeah = transcriptSegment({ startSec: 56, endSec: 58, text: 'Yeah,', speaker: 'others' });
  const long = transcriptSegment({ startSec: 58, endSec: 60, text: 'long.', speaker: 'others' });
  const meetingWith = (segments: readonly TranscriptSegment[]): Meeting => ({
    id: meetingId,
    title: 'Standup',
    createdAt: new Date(),
    durationSec: 60,
    transcript: { segments },
    summaries: [],
    archived: false,
    hasAudio: false,
    hasSystemTrack: false,
    droppedAudioChunks: 0,
  });

  /** Mirrors the real facade contract: drop `indices` from the current transcript and arm ONE compound `{index: min, segments}` undo op. */
  const deleteTranscriptSection = vi.fn(async (id: string, indices: readonly number[]): Promise<void> => {
    void id;
    const segments = selectedMeeting()?.transcript?.segments ?? [];
    const ascending = [...indices].sort((a, b) => a - b);
    const removed = ascending.flatMap((index) => {
      const segment = segments[index];
      return segment === undefined ? [] : [segment];
    });
    const startIndex = ascending.at(0) ?? 0;
    selectedMeeting.set(meetingWith(segments.filter((_, index) => !ascending.includes(index))));
    transcriptUndo.set({ kind: 'delete', meetingId, index: startIndex, segments: removed });
  });
  /** Mirrors `runUndoLastTranscriptOp`: splice the captured segments back at their original index, then clear the slot. */
  const undoLastTranscriptOp = vi.fn(async (): Promise<void> => {
    const op = transcriptUndo();
    const segments = [...(selectedMeeting()?.transcript?.segments ?? [])];
    if (op?.kind === 'delete') {
      segments.splice(op.index, 0, ...op.segments);
      selectedMeeting.set(meetingWith(segments));
    }
    transcriptUndo.set(null);
  });
  const undoLastSpeakerOp = vi.fn(noop);

  const facadeStub = {
    meetings, selectedMeeting, modelsStatus, devices, selectedDevice, recordingState, level,
    finalizedSegments, partialTextMe, partialTextOthers, error, busy, systemAudioStatus, captureSource, templates,
    summaryStream, summarizing, summarizingKey, startingRecording, summaryLanguages, selectedSummaryLanguage,
    summaryCache, appVersion, audioSources, selectedAudioSource, effectiveSystemSource,
    splitRatio, transcriptCollapsed, importing, importProgress, transcriptUndo, speakerHistory,
    deleteTranscriptSection, undoLastTranscriptOp, undoLastSpeakerOp,
    loadMeetings: vi.fn(noop), loadTemplates: vi.fn(noop), checkModels: vi.fn(noop), loadDevices: vi.fn(noop),
    checkSystemAudio: vi.fn(noop), loadSummaryLanguages: vi.fn(noop), loadAppVersion: vi.fn(noop),
    loadAudioSources: vi.fn(noop), loadSummary: vi.fn(noop), openMeeting: vi.fn(noop),
    startRecording: vi.fn(noop), stopRecording: vi.fn(noop), cancelRecording: vi.fn(noop),
    deleteMeeting: vi.fn(noop), renameMeeting: vi.fn(noop), summarizeMeeting: vi.fn(noop),
    cancelSummarization: vi.fn(noop), exportMeeting: vi.fn(noop), selectDevice: vi.fn(),
    selectCaptureSource: vi.fn(), selectAudioSource: vi.fn(), selectSummaryLanguage: vi.fn(),
    requestSystemAudioPermission: vi.fn(noop), editTranscriptSegment: vi.fn(noop),
    setSplitRatio: vi.fn(), setTranscriptCollapsed: vi.fn(), setMeetingArchived: vi.fn(noop),
    folders, expandedFolders, loadFolders: vi.fn(noop), createFolder: vi.fn(noop), renameFolder: vi.fn(noop),
    deleteFolder: vi.fn(noop), toggleFolderExpanded: vi.fn(),
    modelDownload: signal(undefined),
  } as unknown as MeetingsFacade;

  beforeEach(() => {
    deleteTranscriptSection.mockClear();
    undoLastTranscriptOp.mockClear();
    undoLastSpeakerOp.mockClear();
    selectedMeeting.set(undefined);
    transcriptUndo.set(null);
    speakerHistory.set([]);
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

  const menuItem = (fixture: ReturnType<typeof createFixture>, text: string): HTMLButtonElement => {
    const option = Array.from(
      fixture.nativeElement.querySelectorAll('.speaker-menu [role="menuitem"]'),
    ).find((el) => (el as HTMLElement).textContent?.trim() === text);
    if (!option) {
      throw new Error(`Menu item "${text}" not found`);
    }
    return option as HTMLButtonElement;
  };

  const segmentCount = (fixture: ReturnType<typeof createFixture>): number =>
    fixture.nativeElement.querySelectorAll('app-editable-segment').length;

  it('deletes the grouped section through the chip menu with ONE compound facade call carrying the absolute indices', () => {
    selectedMeeting.set(meetingWith([intro, yeah, long]));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fixture = createFixture();

    chips(fixture)[1]!.click();
    fixture.detectChanges();
    menuItem(fixture, 'Delete section…').click();
    fixture.detectChanges();

    expect(deleteTranscriptSection).toHaveBeenCalledWith('m1', [1, 2]);
    expect(segmentCount(fixture)).toBe(1);
  });

  it('does not call the facade when the delete is declined', () => {
    selectedMeeting.set(meetingWith([intro, yeah, long]));
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const fixture = createFixture();

    chips(fixture)[1]!.click();
    fixture.detectChanges();
    menuItem(fixture, 'Delete section…').click();
    fixture.detectChanges();

    expect(deleteTranscriptSection).not.toHaveBeenCalled();
    expect(segmentCount(fixture)).toBe(3);
  });

  it('delete → Undo button appears with the compound label → undo restores every segment', () => {
    selectedMeeting.set(meetingWith([intro, yeah, long]));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fixture = createFixture();

    chips(fixture)[1]!.click();
    fixture.detectChanges();
    menuItem(fixture, 'Delete section…').click();
    fixture.detectChanges();

    const undoButton: HTMLButtonElement = fixture.nativeElement.querySelector('.undo-transcript');
    expect(undoButton).toBeTruthy();
    expect(undoButton.getAttribute('title')).toBe('Undo delete of 2 segments');

    undoButton.click();
    fixture.detectChanges();

    expect(undoLastTranscriptOp).toHaveBeenCalledTimes(1);
    expect(segmentCount(fixture)).toBe(3);
    expect(fixture.nativeElement.querySelector('.undo-transcript')).toBeNull();
  });

  it('per-line delete: the middle line of a section reaches the facade as [4], labels undo singularly, and undo restores that line in place', () => {
    const fourth = transcriptSegment({ startSec: 15, endSec: 20, text: 'quarter one', speaker: 'others:1' });
    const fifth = transcriptSegment({ startSec: 20, endSec: 25, text: 'quarter two', speaker: 'others:1' });
    const sixth = transcriptSegment({ startSec: 25, endSec: 30, text: 'quarter three', speaker: 'others:1' });
    selectedMeeting.set(meetingWith([intro, yeah, long, fourth, fifth, sixth]));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fixture = createFixture();

    const lineButton = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      '[data-line-delete-index="4"]',
    );
    expect(lineButton).toBeTruthy();
    lineButton!.click();
    fixture.detectChanges();

    expect(deleteTranscriptSection).toHaveBeenCalledWith('m1', [4]);
    const undoButton: HTMLButtonElement = fixture.nativeElement.querySelector('.undo-transcript');
    expect(undoButton.getAttribute('title')).toBe('Undo delete of segment 5');

    undoButton.click();
    fixture.detectChanges();

    expect(undoLastTranscriptOp).toHaveBeenCalledTimes(1);
    const renderedTexts = (
      Array.from(fixture.nativeElement.querySelectorAll('app-editable-segment')) as HTMLElement[]
    ).map((el) => el.textContent?.trim() ?? '');
    expect(renderedTexts).toEqual(['intro', 'Yeah,', 'long.', 'quarter one', 'quarter two', 'quarter three']);
  });

  it('shows the speaker Undo button from the speaker-history stack and undoes through the facade', () => {
    selectedMeeting.set(meetingWith([intro]));
    speakerHistory.set([{ kind: 'rename', meetingId, label: 'others:1', previousName: 'Jean' }]);
    const fixture = createFixture();

    const undoButton: HTMLButtonElement = fixture.nativeElement.querySelector('.undo-speaker');
    expect(undoButton).toBeTruthy();
    expect(undoButton.getAttribute('title')).toBe('Undo rename of Jean');

    undoButton.click();
    expect(undoLastSpeakerOp).toHaveBeenCalledTimes(1);
  });

  it('renders no undo affordance when neither slot holds anything', () => {
    selectedMeeting.set(meetingWith([intro, yeah, long]));
    const fixture = createFixture();

    expect(fixture.nativeElement.querySelector('.undo-transcript')).toBeNull();
    expect(fixture.nativeElement.querySelector('.undo-speaker')).toBeNull();
  });

  it('is a no-op when no meeting is selected', () => {
    selectedMeeting.set(undefined);
    const fixture = createFixture();

    fixture.componentInstance.onSectionDeleted({ indices: [1, 2] });

    expect(deleteTranscriptSection).not.toHaveBeenCalled();
  });
});
