import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter, convertToParamMap, type ParamMap } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { vi } from 'vitest';

import { MeetingsFacade } from '../../../application/facades/meetings.facade';
import { NOOP_UPDATES_FACADE_STUB } from '../../../application/testing/noop-updates-facade.stub';
import type { MeetingsErrorInfo } from '../../../application/stores/meetings.store';
import type { AudioDevice, AudioLevel } from '../../../core/models/audio-device.model';
import type { AudioSource } from '../../../core/models/audio-source.model';
import type { CaptureSource, SystemAudioStatus } from '../../../core/models/capture-source.model';
import type { Folder, FolderId } from '../../../core/models/folder.model';
import { toFolderId } from '../../../core/models/folder.model';
import type { Meeting, MeetingId } from '../../../core/models/meeting.model';
import { toMeetingId } from '../../../core/models/meeting.model';
import type { ModelsStatus } from '../../../core/models/models-status.model';
import type { RecordingState } from '../../../core/models/recording-state.model';
import type { SummaryTemplate } from '../../../core/models/summary-template.model';
import type { TranscriptSegment } from '../../../core/models/transcript.model';
import type { ImportProgress } from '../../../core/ports/audio-import.port';
import { MeetingsShellPage } from './meetings-shell.page';

const readyModelsStatus: ModelsStatus = {
  parakeet: { present: true, expectedFiles: [] },
  qwen: { present: true, expectedFiles: [] },
  silero: { present: true, expectedFiles: [] },
  allPresent: true,
};

/**
 * RED spec restoring the deleted `MeetingsShellPage — archive forwarding`
 * coverage, extended for the new kebab-menu "move to folder" affordance (see
 * `## THE BUG` in the dispatching brief: drag-and-drop was the ONLY way to
 * archive or file a meeting, which is a total loss of that feature for
 * keyboard-only/screen-reader users).
 *
 * `onMeetingArchiveToggled` / `onMeetingFolderChanged` do not exist yet on
 * `MeetingsShellPage` — the `withArchiveMenu` cast below asserts the
 * INTENDED handler surface without touching production code. The coder
 * implements these as thin delegations to `facade.setMeetingArchived` /
 * `facade.setMeetingFolder` (both already exist and work — see
 * `meetings.facade.archive.spec.ts` / `meetings.facade.folders.spec.ts` —
 * they just have no caller), mirroring the existing `onMeetingRenamed` /
 * `onFolderRenamed` one-liner style in `meetings-shell.page.ts`.
 */
interface MeetingsShellPageWithArchiveMenu {
  onMeetingArchiveToggled(event: { readonly id: MeetingId; readonly archived: boolean }): void;
  onMeetingFolderChanged(event: { readonly id: MeetingId; readonly folderId: FolderId | null }): void;
}
const withArchiveMenu = (instance: MeetingsShellPage): MeetingsShellPage & MeetingsShellPageWithArchiveMenu =>
  instance as MeetingsShellPage & MeetingsShellPageWithArchiveMenu;

describe('MeetingsShellPage — archive + move-to-folder forwarding (kebab menu)', () => {
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
  const folders = signal<readonly Folder[]>([]);
  const expandedFolders = signal<ReadonlySet<FolderId>>(new Set());

  const noop = async (): Promise<void> => undefined;
  const setSplitRatio = vi.fn((ratio: number) => void ratio);
  const setTranscriptCollapsed = vi.fn((collapsed: boolean) => void collapsed);
  const setMeetingArchived = vi.fn(async (id: string, archived: boolean) => {
    void id;
    void archived;
  });
  const setMeetingFolder = vi.fn(async (id: string, folderId: string | null) => {
    void id;
    void folderId;
  });
  const loadFolders = vi.fn(noop);
  const createFolder = vi.fn(async (name: string) => void name);
  const renameFolder = vi.fn(async (id: string, name: string) => {
    void id;
    void name;
  });
  const deleteFolder = vi.fn(async (id: string) => void id);
  const toggleFolderExpanded = vi.fn((id: string) => void id);

  const facadeStub = {
    meetings, selectedMeeting, modelsStatus, devices, selectedDevice, defaultDevice, outputDevices, defaultOutputDevice, recordingState, level,
    finalizedSegments, partialTextMe, partialTextOthers, error, busy, systemAudioStatus, captureSource, templates,
    summaryStream, summarizing, summarizingKey, startingRecording, summaryLanguages, selectedSummaryLanguage,
    summaryCache, appVersion, audioSources, selectedAudioSource, effectiveSystemSource,
    splitRatio, transcriptCollapsed, importing, importProgress, folders, expandedFolders,
    setSplitRatio, setTranscriptCollapsed, setMeetingArchived, setMeetingFolder,
    loadMeetings: vi.fn(noop), loadTemplates: vi.fn(noop), checkModels: vi.fn(noop), loadDevices: vi.fn(noop),
    checkSystemAudio: vi.fn(noop), loadSummaryLanguages: vi.fn(noop), loadAppVersion: vi.fn(noop),
    loadAudioSources: vi.fn(noop), loadSummary: vi.fn(noop), openMeeting: vi.fn(noop),
    startRecording: vi.fn(noop), stopRecording: vi.fn(noop), cancelRecording: vi.fn(noop),
    deleteMeeting: vi.fn(noop), renameMeeting: vi.fn(noop), summarizeMeeting: vi.fn(noop),
    cancelSummarization: vi.fn(noop), exportMeeting: vi.fn(noop), selectDevice: vi.fn(),
    selectCaptureSource: vi.fn(), selectAudioSource: vi.fn(), selectSummaryLanguage: vi.fn(),
    requestSystemAudioPermission: vi.fn(noop),
    loadFolders, createFolder, renameFolder, deleteFolder, toggleFolderExpanded,
    modelDownload: signal(undefined),
    transcriptUndo: signal(null),
    speakerHistory: signal([]),
    undoLastSpeakerOp: vi.fn(async () => undefined),
    updates: NOOP_UPDATES_FACADE_STUB,
  } as unknown as MeetingsFacade;

  beforeEach(() => {
    setMeetingArchived.mockClear();
    setMeetingFolder.mockClear();
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

  it('forwards an archive-toggle request from the kebab menu to facade.setMeetingArchived', () => {
    const fixture = createFixture();

    withArchiveMenu(fixture.componentInstance).onMeetingArchiveToggled({ id: toMeetingId('m1'), archived: true });

    expect(setMeetingArchived).toHaveBeenCalledWith('m1', true);
  });

  it('forwards an unarchive request from the kebab menu to facade.setMeetingArchived', () => {
    const fixture = createFixture();

    withArchiveMenu(fixture.componentInstance).onMeetingArchiveToggled({ id: toMeetingId('m1'), archived: false });

    expect(setMeetingArchived).toHaveBeenCalledWith('m1', false);
  });

  it('forwards a "move to folder" request from the kebab menu to facade.setMeetingFolder', () => {
    const fixture = createFixture();

    withArchiveMenu(fixture.componentInstance).onMeetingFolderChanged({ id: toMeetingId('m1'), folderId: toFolderId('f1') });

    expect(setMeetingFolder).toHaveBeenCalledWith('m1', 'f1');
  });

  it('forwards a "no folder" (top-level) request from the kebab menu to facade.setMeetingFolder with a null folderId', () => {
    const fixture = createFixture();

    withArchiveMenu(fixture.componentInstance).onMeetingFolderChanged({ id: toMeetingId('m1'), folderId: null });

    expect(setMeetingFolder).toHaveBeenCalledWith('m1', null);
  });
});
