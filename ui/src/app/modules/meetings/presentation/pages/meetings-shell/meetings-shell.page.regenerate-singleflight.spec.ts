import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, type ParamMap } from '@angular/router';
import { By } from '@angular/platform-browser';
import { BehaviorSubject, EMPTY } from 'rxjs';
import { vi } from 'vitest';

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
import { MeetingDetailPaneComponent } from '../../components/meeting-detail-pane/meeting-detail-pane.component';
import { MeetingsShellPage } from './meetings-shell.page';
import { closeSidebarOnEscape } from './meetings-shell.page.sidebar-narrow.support';

const readyModelsStatus: ModelsStatus = {
  parakeet: { present: true, expectedFiles: [] },
  qwen: { present: true, expectedFiles: [] },
  silero: { present: true, expectedFiles: [] },
  allPresent: true,
};

/**
 * Single-flight regression for Regenerate: one click on the detail pane's
 * Regenerate button must issue exactly one `summarizeMeeting` call, and a
 * second `summarize()` while `summarizing()` is true must be dropped before
 * it can hit Rust's `summary_busy` guard (state.rs) and surface a BUSY error.
 * Clicks the real DOM button (not the pane output directly) so a duplicate
 * emit in `regenerateSummary()` fails this spec.
 */
describe('MeetingsShellPage regenerate single-flight', () => {
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
  const templates = signal<readonly SummaryTemplate[]>([
    { name: 'key-points', description: 'Key points', prompt: 'p' },
  ]);
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

  const meeting: Meeting = {
    id: toMeetingId('m1'),
    title: 'Standup',
    createdAt: new Date(),
    durationSec: 60,
    summaries: [
      { template: 'key-points', markdown: '# Old', createdAt: new Date(), language: 'en', stale: false },
    ],
    archived: false,
    hasAudio: false,
    hasSystemTrack: false,
    droppedAudioChunks: 0,
  };

  const noop = async (): Promise<void> => undefined;
  const loadMeetings = vi.fn(noop);
  const loadTemplates = vi.fn(noop);
  const checkModels = vi.fn(noop);
  const loadDevices = vi.fn(noop);
  const checkSystemAudio = vi.fn(noop);
  const loadSummaryLanguages = vi.fn(noop);
  const loadSummaryGuidelines = vi.fn(async () => undefined);
  const setSummaryGuidelines = vi.fn(async () => undefined);
  const summaryGuidelines = signal('');
  const summaryInstructionDraft = () => ({ text: '', includeGeneral: true });
  const setSummaryInstructionDraft = vi.fn();
  const loadAppVersion = vi.fn(noop);
  const loadAudioSources = vi.fn(noop);
  const loadSummary = vi.fn(noop);
  const openMeeting = vi.fn(noop);
  const startRecording = vi.fn(noop);
  const stopRecording = vi.fn(noop);
  const cancelRecording = vi.fn(noop);
  const deleteMeeting = vi.fn(noop);
  const renameMeeting = vi.fn(noop);
  const summarizeMeeting = vi.fn(async (id: string, template: SummaryTemplate) => {
    void id;
    void template;
  });
  const cancelSummarization = vi.fn(noop);
  const exportMeeting = vi.fn(noop);
  const selectDevice = vi.fn();
  const selectCaptureSource = vi.fn();
  const selectAudioSource = vi.fn();
  const selectSummaryLanguage = vi.fn();
  const requestSystemAudioPermission = vi.fn(noop);
  const setSplitRatio = vi.fn();
  const setTranscriptCollapsed = vi.fn();
  const setSidebarWidth = vi.fn();
  const setSidebarCollapsed = vi.fn();
  const folders = signal<readonly never[]>([]);
  const expandedFolders = signal<ReadonlySet<never>>(new Set());
  const loadFolders = vi.fn(noop);
  const createFolder = vi.fn(noop);
  const renameFolder = vi.fn(noop);
  const deleteFolder = vi.fn(noop);
  const toggleFolderExpanded = vi.fn();

  const facadeStub = {
    settingsRequests: () => EMPTY,
    activeRecording: signal(null),
    resumeActiveRecording: vi.fn(async () => undefined),
    clearSelection: vi.fn(),
    meetings, selectedMeeting, modelsStatus, devices, selectedDevice, recordingState, level,
    finalizedSegments, partialTextMe, partialTextOthers, error, busy, systemAudioStatus, captureSource, templates,
    clearError: vi.fn(),
    summaryStream, summarizing, summarizingKey, startingRecording, summaryLanguages, selectedSummaryLanguage,
    summaryCache, appVersion, audioSources, selectedAudioSource, effectiveSystemSource,
    splitRatio, transcriptCollapsed, sidebarWidth, sidebarCollapsed, importing, importProgress, setSplitRatio, setTranscriptCollapsed, setSidebarWidth, setSidebarCollapsed,
    loadMeetings, loadTemplates, checkModels, loadDevices, checkSystemAudio, loadSummaryLanguages,
    loadSummaryGuidelines, setSummaryGuidelines, summaryGuidelines, summaryInstructionDraft, setSummaryInstructionDraft,
    loadAppVersion, loadAudioSources, loadSummary, openMeeting, startRecording, stopRecording,
    cancelRecording, deleteMeeting, renameMeeting, summarizeMeeting, cancelSummarization,
    exportMeeting, selectDevice, selectCaptureSource, selectAudioSource, selectSummaryLanguage,
    requestSystemAudioPermission,
    folders, expandedFolders, loadFolders, createFolder, renameFolder, deleteFolder, toggleFolderExpanded,
    speakerHistory: signal([]),
    transcriptUndo: signal(null),
    modelDownload: signal(undefined),
    updates: NOOP_UPDATES_FACADE_STUB,
  } as unknown as MeetingsFacade;

  let routeParamMap: BehaviorSubject<ParamMap>;

  beforeEach(() => {
    selectedMeeting.set(meeting);
    recordingState.set('idle');
    summarizing.set(false);
    summarizingKey.set(null);
    error.set(undefined);
    summarizeMeeting.mockClear();
    routeParamMap = new BehaviorSubject<ParamMap>(convertToParamMap({}));

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

  it('two-step Regenerate opens the dialog then confirms exactly one summarizeMeeting and no error', () => {
    const fixture = createFixture();

    const pane = fixture.debugElement.query(By.directive(MeetingDetailPaneComponent));
    pane.componentInstance.selectTab('key-points');
    fixture.detectChanges();

    const button: HTMLButtonElement = fixture.nativeElement.querySelector('.regenerate-button');
    expect(button).toBeTruthy();
    expect(button.disabled).toBe(false);
    button.click();
    fixture.detectChanges();

    expect(summarizeMeeting).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('.regenerate-confirm')).toBeNull();
    const dialog: HTMLElement | null = fixture.nativeElement.querySelector(
      'app-regenerate-instructions-dialog [role="dialog"]',
    );
    expect(dialog).toBeTruthy();
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(
      fixture.nativeElement.querySelector('app-regenerate-instructions-dialog .hint')?.textContent,
    ).toContain('Regenerate');

    const confirmButton: HTMLButtonElement = fixture.nativeElement.querySelector(
      'app-regenerate-instructions-dialog .confirm',
    );
    expect(confirmButton).toBeTruthy();
    expect(confirmButton.disabled).toBe(false);
    confirmButton.click();
    fixture.detectChanges();

    expect(summarizeMeeting).toHaveBeenCalledTimes(1);
    expect(summarizeMeeting).toHaveBeenCalledWith('m1', { name: 'key-points', description: 'Key points', prompt: 'p' });
    expect(error()).toBeUndefined();
    expect(fixture.nativeElement.querySelector('app-regenerate-instructions-dialog [role="dialog"]')).toBeNull();
  });

  it('Esc closes the dialog with zero summarizeMeeting and returns focus to Regenerate', () => {
    const fixture = createFixture();

    const pane = fixture.debugElement.query(By.directive(MeetingDetailPaneComponent));
    pane.componentInstance.selectTab('key-points');
    fixture.detectChanges();

    (fixture.nativeElement.querySelector('.regenerate-button') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-regenerate-instructions-dialog [role="dialog"]')).toBeTruthy();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();

    expect(summarizeMeeting).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('app-regenerate-instructions-dialog [role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(fixture.nativeElement.querySelector('.regenerate-button'));
  });

  it('backdrop and Cancel close the dialog with zero summarizeMeeting and focus return', () => {
    const fixture = createFixture();

    const pane = fixture.debugElement.query(By.directive(MeetingDetailPaneComponent));
    pane.componentInstance.selectTab('key-points');
    fixture.detectChanges();

    (fixture.nativeElement.querySelector('.regenerate-button') as HTMLButtonElement).click();
    fixture.detectChanges();
    (fixture.nativeElement.querySelector(
      'app-regenerate-instructions-dialog .regenerate-instructions-backdrop',
    ) as HTMLElement).click();
    fixture.detectChanges();
    expect(summarizeMeeting).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('app-regenerate-instructions-dialog [role="dialog"]')).toBeNull();

    (fixture.nativeElement.querySelector('.regenerate-button') as HTMLButtonElement).click();
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('app-regenerate-instructions-dialog .cancel') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(summarizeMeeting).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('app-regenerate-instructions-dialog [role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(fixture.nativeElement.querySelector('.regenerate-button'));
  });

  it('narrow-sidebar Esc guard defers to the open dialog modal ancestor', () => {
    const fixture = createFixture();

    const pane = fixture.debugElement.query(By.directive(MeetingDetailPaneComponent));
    pane.componentInstance.selectTab('key-points');
    fixture.detectChanges();

    (fixture.nativeElement.querySelector('.regenerate-button') as HTMLButtonElement).click();
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector(
      'app-regenerate-instructions-dialog [role="dialog"]',
    ) as HTMLElement;
    expect(dialog).toBeTruthy();

    const previousWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true });
    try {
      const insideDialog = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
      Object.defineProperty(insideDialog, 'target', { value: dialog });
      expect(closeSidebarOnEscape(facadeStub, insideDialog)).toBe(false);
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: previousWidth, configurable: true });
    }
  });

  it('drops a re-entrant summarize() while summarizing() is true', () => {
    const fixture = createFixture();

    summarizing.set(true);
    summarizingKey.set({ template: 'key-points', language: 'en' });
    fixture.detectChanges();

    fixture.componentInstance.summarize('key-points');

    expect(summarizeMeeting).not.toHaveBeenCalled();
    expect(error()).toBeUndefined();
  });
});
