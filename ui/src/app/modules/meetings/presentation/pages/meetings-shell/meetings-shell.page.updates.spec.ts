import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, type ParamMap } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { vi } from 'vitest';

import { MeetingsFacade } from '../../../application/facades/meetings.facade';
import type { MeetingsErrorInfo, ModelDownloadState } from '../../../application/stores/meetings.store';
import { InMemoryUpdatesFake } from '../../../application/testing/in-memory-updates.fake';
import type { AudioDevice, AudioLevel } from '../../../core/models/audio-device.model';
import type { AudioSource } from '../../../core/models/audio-source.model';
import type { CaptureSource, SystemAudioStatus } from '../../../core/models/capture-source.model';
import type { Meeting } from '../../../core/models/meeting.model';
import type { ModelsStatus } from '../../../core/models/models-status.model';
import type { RecordingState } from '../../../core/models/recording-state.model';
import type { SummaryTemplate } from '../../../core/models/summary-template.model';
import type { TranscriptSegment } from '../../../core/models/transcript.model';
import type { UpdateCheck, UpdateConsent } from '../../../core/models/update.model';
import type { ImportProgress } from '../../../core/ports/audio-import.port';
import { flushMicrotasks } from '../../../infrastructure/tauri/testing/tauri-internals.stub';
import { MeetingsShellPage } from './meetings-shell.page';

/**
 * Covers the shell page's launch-time update-check wiring: consent-dialog
 * gating (unset/granted/declined, suppressed while recording), the
 * postponed no-op, and the About > Updates settings toggle — split out of
 * `meetings-shell.page.spec.ts` per this directory's per-feature-file
 * convention (see `meetings-shell.page.model-download.spec.ts` etc.).
 *
 * Uses the REAL `InMemoryUpdatesFake` port (not a hand-rolled spy) behind a
 * hand-rolled `updates` facade stub, so `checkCalls` is the actual port
 * call log — the exact mechanism the brief calls out to make "opt-in" a
 * verifiable fact, not just an implementation claim.
 */
describe('MeetingsShellPage update checks', () => {
  let updatesPort: InMemoryUpdatesFake;

  const consent = signal<UpdateConsent>('unset');
  const lastCheck = signal<UpdateCheck | undefined>(undefined);
  const checking = signal(false);
  const dismissedVersion = signal<string | null>(null);

  const updatesFacadeStub = {
    consent,
    lastCheck,
    checking,
    dismissedVersion,
    loadConsent: async (): Promise<void> => {
      consent.set(await updatesPort.consent());
    },
    grantConsent: async (): Promise<void> => {
      await updatesPort.setConsent('granted');
      consent.set('granted');
    },
    declineConsent: async (): Promise<void> => {
      await updatesPort.setConsent('declined');
      consent.set('declined');
    },
    checkForUpdate: async (manual: boolean): Promise<void> => {
      checking.set(true);
      try {
        lastCheck.set(await updatesPort.check(manual));
      } finally {
        checking.set(false);
      }
    },
    dismissBanner: vi.fn(),
  };

  const meetings = signal<readonly Meeting[]>([]);
  const selectedMeeting = signal<Meeting | undefined>(undefined);
  const modelsStatus = signal<ModelsStatus | undefined>(undefined);
  const modelDownload = signal<ModelDownloadState | undefined>(undefined);
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

  const facadeStub = {
    activeRecording: signal(null),
    resumeActiveRecording: vi.fn(async () => undefined),
    speakerHistory: signal([]), transcriptUndo: signal(null),
    meetings, selectedMeeting, modelsStatus, modelDownload, devices, selectedDevice, recordingState, level,
    finalizedSegments, partialTextMe, partialTextOthers, error, busy, systemAudioStatus, captureSource, templates,
    summaryStream, summarizing, summarizingKey, startingRecording, summaryLanguages, selectedSummaryLanguage,
    summaryCache, appVersion, audioSources, selectedAudioSource, effectiveSystemSource,
    splitRatio, transcriptCollapsed, importing, importProgress, folders, expandedFolders,
    setSplitRatio: vi.fn(), setTranscriptCollapsed: vi.fn(),
    loadMeetings: vi.fn(noop), loadTemplates: vi.fn(noop), checkModels: vi.fn(noop), loadDevices: vi.fn(noop),
    checkSystemAudio: vi.fn(noop), loadSummaryLanguages: vi.fn(noop), loadAppVersion: vi.fn(noop),
    loadAudioSources: vi.fn(noop), loadSummary: vi.fn(noop), openMeeting: vi.fn(noop),
    startRecording: vi.fn(noop), stopRecording: vi.fn(noop), cancelRecording: vi.fn(noop),
    deleteMeeting: vi.fn(noop), renameMeeting: vi.fn(noop), summarizeMeeting: vi.fn(noop),
    cancelSummarization: vi.fn(noop), exportMeeting: vi.fn(noop), selectDevice: vi.fn(),
    selectCaptureSource: vi.fn(), selectAudioSource: vi.fn(), selectSummaryLanguage: vi.fn(),
    requestSystemAudioPermission: vi.fn(noop),
    loadFolders: vi.fn(noop), createFolder: vi.fn(noop), renameFolder: vi.fn(noop),
    deleteFolder: vi.fn(noop), toggleFolderExpanded: vi.fn(), clearSelection: vi.fn(),
    updates: updatesFacadeStub,
  } as unknown as MeetingsFacade;

  beforeEach(() => {
    updatesPort = new InMemoryUpdatesFake();
    consent.set('unset');
    lastCheck.set(undefined);
    checking.set(false);
    dismissedVersion.set(null);
    recordingState.set('idle');

    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: MeetingsFacade, useValue: facadeStub },
        {
          provide: ActivatedRoute,
          useValue: { paramMap: new BehaviorSubject<ParamMap>(convertToParamMap({})) },
        },
      ],
    });
  });

  const createFixture = async () => {
    const fixture = TestBed.createComponent(MeetingsShellPage);
    fixture.detectChanges();
    await flushMicrotasks();
    fixture.detectChanges();
    return fixture;
  };

  it('never calls check() on launch when consent is unset', async () => {
    updatesPort.seedConsent('unset');

    await createFixture();

    expect(updatesPort.checkCalls).toEqual([]);
  });

  it('never calls check() on launch when consent is declined', async () => {
    updatesPort.seedConsent('declined');

    await createFixture();

    expect(updatesPort.checkCalls).toEqual([]);
  });

  it('calls check(false) on launch when consent is already granted', async () => {
    updatesPort.seedConsent('granted');

    await createFixture();

    expect(updatesPort.checkCalls).toEqual([false]);
  });

  it('shows the consent dialog when consent is unset and no recording is in progress', async () => {
    updatesPort.seedConsent('unset');

    const fixture = await createFixture();

    expect(fixture.nativeElement.querySelector('app-update-consent-dialog')).toBeTruthy();
  });

  it('does not show the consent dialog when consent is granted', async () => {
    updatesPort.seedConsent('granted');

    const fixture = await createFixture();

    expect(fixture.nativeElement.querySelector('app-update-consent-dialog')).toBeNull();
  });

  it('does not show the consent dialog when consent is declined', async () => {
    updatesPort.seedConsent('declined');

    const fixture = await createFixture();

    expect(fixture.nativeElement.querySelector('app-update-consent-dialog')).toBeNull();
  });

  it('suppresses the consent dialog while a recording is in progress, even with unset consent', async () => {
    updatesPort.seedConsent('unset');
    recordingState.set('recording');

    const fixture = await createFixture();

    expect(fixture.nativeElement.querySelector('app-update-consent-dialog')).toBeNull();
  });

  it('postponing the consent dialog (×) issues zero setConsent calls', async () => {
    updatesPort.seedConsent('unset');
    const setConsentSpy = vi.spyOn(updatesPort, 'setConsent');
    const fixture = await createFixture();

    fixture.nativeElement.querySelector('app-update-consent-dialog .close').click();

    expect(setConsentSpy).not.toHaveBeenCalled();
  });

  it('unchecking the About > Updates auto-check toggle emits declined and issues zero (additional) checks', async () => {
    updatesPort.seedConsent('granted');
    const fixture = await createFixture();
    // The launch-time check already ran once, from the seeded 'granted' consent.
    expect(updatesPort.checkCalls).toEqual([false]);

    fixture.componentInstance.toggleAbout();
    fixture.detectChanges();
    const checkbox: HTMLInputElement = fixture.nativeElement.querySelector('.auto-check input');
    expect(checkbox.checked).toBe(true);

    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change'));
    await flushMicrotasks();
    fixture.detectChanges();

    expect(consent()).toBe('declined');
    expect(updatesPort.checkCalls).toEqual([false]);
  });
});
