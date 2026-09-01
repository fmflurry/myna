import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter, convertToParamMap, type ParamMap } from '@angular/router';
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
import { transcriptSegment } from '../../../application/testing/transcript-segment.factory';
import { MeetingsShellPage } from './meetings-shell.page';

const readyModelsStatus: ModelsStatus = {
  parakeet: { present: true, expectedFiles: [] },
  qwen: { present: true, expectedFiles: [] },
  silero: { present: true, expectedFiles: [] },
  allPresent: true,
};

/**
 * End-to-end selection-toolbar wiring: real shell → real detail pane → real
 * transcript view, only the `MeetingsFacade` stubbed. A REAL jsdom text
 * selection across three segments drives the toolbar open, and the picked
 * speaker is clicked with a full `mousedown → mouseup → click` sequence — so
 * a dropped binding at ANY hop (transcript-view → pane → shell → facade) or
 * a picker item detached mid-click fails here, which is exactly how the
 * rename path once shipped broken.
 */
describe('MeetingsShellPage — selection toolbar wiring', () => {
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

  const noop = async (): Promise<void> => undefined;
  const setSegmentSpeakers = vi.fn(async (id: string, indices: readonly number[], speaker: string): Promise<void> => {
    void id; void indices; void speaker;
  });
  const setSegmentSpeaker = vi.fn(async (id: string, index: number, speaker: string): Promise<void> => {
    void id; void index; void speaker;
  });

  const facadeStub = {
    meetings, selectedMeeting, modelsStatus, devices, selectedDevice, recordingState, level,
    finalizedSegments, partialTextMe, partialTextOthers, error, busy, systemAudioStatus, captureSource, templates,
    summaryStream, summarizing, summarizingKey, startingRecording, summaryLanguages, selectedSummaryLanguage,
    summaryCache, appVersion, audioSources, selectedAudioSource, effectiveSystemSource,
    splitRatio, transcriptCollapsed, importing, importProgress,
    setSegmentSpeakers, setSegmentSpeaker,
    renameSpeaker: vi.fn(noop), removeSpeaker: vi.fn(noop), loadMeetings: vi.fn(noop), loadTemplates: vi.fn(noop),
    checkModels: vi.fn(noop), loadDevices: vi.fn(noop), checkSystemAudio: vi.fn(noop), loadSummaryLanguages: vi.fn(noop),
    loadAppVersion: vi.fn(noop), loadAudioSources: vi.fn(noop), loadSummary: vi.fn(noop), openMeeting: vi.fn(noop),
    startRecording: vi.fn(noop), stopRecording: vi.fn(noop), cancelRecording: vi.fn(noop),
    deleteMeeting: vi.fn(noop), renameMeeting: vi.fn(noop), summarizeMeeting: vi.fn(noop),
    cancelSummarization: vi.fn(noop), exportMeeting: vi.fn(noop), selectDevice: vi.fn(),
    selectCaptureSource: vi.fn(), selectAudioSource: vi.fn(), selectSummaryLanguage: vi.fn(),
    requestSystemAudioPermission: vi.fn(noop), editTranscriptSegment: vi.fn(noop),
    setSplitRatio: vi.fn(), setTranscriptCollapsed: vi.fn(), setMeetingArchived: vi.fn(noop),
    folders, expandedFolders, loadFolders: vi.fn(noop), createFolder: vi.fn(noop), renameFolder: vi.fn(noop),
    deleteFolder: vi.fn(noop), toggleFolderExpanded: vi.fn(),
    speakerHistory: signal([]),
    transcriptUndo: signal(null),
    modelDownload: signal(undefined),
  } as unknown as MeetingsFacade;

  beforeEach(() => {
    setSegmentSpeakers.mockClear();
    setSegmentSpeaker.mockClear();
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
    window.getSelection()?.removeAllRanges();
    vi.restoreAllMocks();
  });

  const meetingWith = (segments: readonly TranscriptSegment[]): Meeting => ({
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
  });

  const createFixture = () => {
    const fixture = TestBed.createComponent(MeetingsShellPage);
    fixture.detectChanges();
    document.body.appendChild(fixture.nativeElement);
    return fixture;
  };

  const fullClick = (el: HTMLElement): void => {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  };

  it('routes a real text selection through the rendered chain into ONE batched setSegmentSpeakers call', () => {
    selectedMeeting.set(
      meetingWith([
        transcriptSegment({ startSec: 0, endSec: 5, text: 'first line', speaker: 'others:1' }),
        transcriptSegment({ startSec: 5, endSec: 10, text: 'second line', speaker: 'others' }),
        transcriptSegment({ startSec: 10, endSec: 15, text: 'third line', speaker: 'others:2' }),
      ]),
    );
    const fixture = createFixture();

    const hosts = Array.from(fixture.nativeElement.querySelectorAll('[data-segment-index]')) as HTMLElement[];
    expect(hosts.length).toBe(3);
    const range = document.createRange();
    const startText = document.createTreeWalker(hosts[0]!, NodeFilter.SHOW_TEXT).nextNode() as Text;
    const endText = document.createTreeWalker(hosts[2]!, NodeFilter.SHOW_TEXT).nextNode() as Text;
    range.setStart(startText, 0);
    range.setEnd(endText, endText.data.length);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    fixture.detectChanges();

    const trigger = fixture.nativeElement.querySelector('.selection-trigger') as HTMLButtonElement | null;
    expect(trigger).not.toBeNull();
    fullClick(trigger!);
    fixture.detectChanges();
    const meItem = (
      Array.from(fixture.nativeElement.querySelectorAll('.selection-menu .speaker-menu [role="menuitem"]')) as HTMLButtonElement[]
    ).find((el) => el.textContent?.trim() === 'Me');
    expect(meItem).toBeDefined();
    fullClick(meItem!);

    expect(setSegmentSpeakers).toHaveBeenCalledTimes(1);
    expect(setSegmentSpeakers).toHaveBeenCalledWith('m1', [0, 1, 2], 'me');
    expect(setSegmentSpeaker).not.toHaveBeenCalled();
    fixture.nativeElement.remove();
  });

  it('is a no-op without a selected meeting', () => {
    selectedMeeting.set(undefined);
    const fixture = createFixture();

    fixture.componentInstance.onSelectionSpeakerAssigned({ indices: [0, 1], speaker: 'me' });

    expect(setSegmentSpeakers).not.toHaveBeenCalled();
    fixture.nativeElement.remove();
  });
});
