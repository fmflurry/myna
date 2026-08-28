import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { ALL_SYSTEM_AUDIO_SOURCE_ID } from '../../core/models/audio-source.model';
import { toMeetingId } from '../../core/models/meeting.model';
import { AppInfoPort } from '../../core/ports/app-info.port';
import { FileDialogPort } from '../../core/ports/file-dialog.port';
import { MeetingRepositoryPort } from '../../core/ports/meeting-repository.port';
import { ModelsStatusPort } from '../../core/ports/models-status.port';
import { PreferencesPort } from '../../core/ports/preferences.port';
import { RecorderPort } from '../../core/ports/recorder.port';
import { SummarizerPort } from '../../core/ports/summarizer.port';
import { TemplateRepositoryPort } from '../../core/ports/template-repository.port';
import { TranscriberPort } from '../../core/ports/transcriber.port';
import {
  flushMicrotasks,
  installTauriInternalsStub,
  uninstallTauriInternalsStub,
} from '../../infrastructure/tauri/testing/tauri-internals.stub';
import { provideMeetings } from '../../meetings.providers';
import { InMemoryAppInfoFake } from '../testing/in-memory-app-info.fake';
import { InMemoryFileDialogFake } from '../testing/in-memory-file-dialog.fake';
import { InMemoryMeetingRepositoryFake } from '../testing/in-memory-meeting-repository.fake';
import { InMemoryModelsStatusFake } from '../testing/in-memory-models-status.fake';
import { InMemoryPreferencesFake } from '../testing/in-memory-preferences.fake';
import { InMemoryRecorderFake } from '../testing/in-memory-recorder.fake';
import { InMemorySummarizerFake } from '../testing/in-memory-summarizer.fake';
import { InMemoryTemplateRepositoryFake } from '../testing/in-memory-template-repository.fake';
import { InMemoryTranscriberFake } from '../testing/in-memory-transcriber.fake';
import { MeetingsFacade } from './meetings.facade';

/**
 * `provideMeetings()` binds the real Tauri adapters (correct for the
 * shipped app), so every fake port used below is layered on top via
 * explicit overrides — this spec exercises the facade against fakes,
 * not against a live Tauri runtime.
 */
const FAKE_PORT_OVERRIDES = [
  { provide: MeetingRepositoryPort, useClass: InMemoryMeetingRepositoryFake },
  { provide: RecorderPort, useClass: InMemoryRecorderFake },
  { provide: SummarizerPort, useClass: InMemorySummarizerFake },
  { provide: TranscriberPort, useClass: InMemoryTranscriberFake },
  { provide: TemplateRepositoryPort, useClass: InMemoryTemplateRepositoryFake },
  { provide: ModelsStatusPort, useClass: InMemoryModelsStatusFake },
  { provide: FileDialogPort, useClass: InMemoryFileDialogFake },
  { provide: PreferencesPort, useClass: InMemoryPreferencesFake },
  { provide: AppInfoPort, useClass: InMemoryAppInfoFake },
];

describe('MeetingsFacade', () => {
  let facade: MeetingsFacade;
  let repository: InMemoryMeetingRepositoryFake;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideMeetings(), ...FAKE_PORT_OVERRIDES],
    });
    facade = TestBed.inject(MeetingsFacade);
    repository = TestBed.inject(MeetingRepositoryPort) as InMemoryMeetingRepositoryFake;
  });

  it('starts with an empty meetings list and no error', () => {
    expect(facade.meetings()).toEqual([]);
    expect(facade.error()).toBeUndefined();
  });

  it('loads meetings from the repository', async () => {
    repository.seed([
      { id: toMeetingId('m-1'), title: 'Standup', createdAt: new Date(), durationSec: 0, summaries: [], archived: false, hasAudio: false },
    ]);

    await facade.loadMeetings();

    expect(facade.meetings().length).toBe(1);
  });

  it('renames a meeting, updating both the meetings list and the selected meeting', async () => {
    const meeting = { id: toMeetingId('m-1'), title: 'Standup', createdAt: new Date(), durationSec: 0, summaries: [], archived: false, hasAudio: false };
    repository.seed([meeting]);
    await facade.loadMeetings();
    await facade.openMeeting(meeting.id);

    await facade.renameMeeting(meeting.id, 'Weekly standup');

    expect(facade.meetings()[0]?.title).toBe('Weekly standup');
    expect(facade.selectedMeeting()?.title).toBe('Weekly standup');
    expect(facade.error()).toBeUndefined();
  });

  it('surfaces an error and leaves the prior title on screen when renaming fails', async () => {
    const meeting = { id: toMeetingId('m-1'), title: 'Standup', createdAt: new Date(), durationSec: 0, summaries: [], archived: false, hasAudio: false };
    repository.seed([meeting]);
    await facade.loadMeetings();
    await facade.openMeeting(meeting.id);

    await facade.renameMeeting(toMeetingId('missing'), 'New name');

    expect(facade.error()?.code).toBe('NOT_FOUND');
    expect(facade.meetings()[0]?.title).toBe('Standup');
    expect(facade.selectedMeeting()?.title).toBe('Standup');
  });

  it('moves a generated summary onto the selected meeting', async () => {
    await facade.startRecording('Planning');
    const selected = facade.selectedMeeting();
    if (!selected) {
      throw new Error('Expected a selected meeting after startRecording.');
    }

    await facade.summarizeMeeting(selected.id, {
      name: 'key-points',
      description: 'Key points',
      prompt: 'Summarize the key points.',
    });

    expect(facade.selectedMeeting()?.summaries.length).toBe(1);
  });

  it('loads devices and defaults the selection when none is chosen yet', async () => {
    expect(facade.devices()).toEqual([]);
    expect(facade.selectedDevice()).toBeNull();

    await facade.loadDevices();

    expect(facade.devices().length).toBeGreaterThan(0);
    expect(facade.selectedDevice()?.name).toBe('Built-in Microphone');
  });

  it('does not override an already-selected device on reload', async () => {
    await facade.loadDevices();
    facade.selectDevice('Built-in Microphone');

    await facade.loadDevices();

    expect(facade.selectedDevice()?.name).toBe('Built-in Microphone');
  });

  it('ignores selectDevice for an unknown device name', async () => {
    await facade.loadDevices();
    const before = facade.selectedDevice();

    facade.selectDevice('Nonexistent Device');

    expect(facade.selectedDevice()).toBe(before);
  });

  it('tracks summarizing as false once summarization settles', async () => {
    expect(facade.summarizing()).toBe(false);

    await facade.summarizeMeeting(toMeetingId('m-1'), {
      name: 'key-points',
      description: 'Key points',
      prompt: 'Summarize the key points.',
    });

    expect(facade.summarizing()).toBe(false);
  });

  it('cancelSummarization clears the summarizing flag without erroring', async () => {
    const result = await facade.cancelSummarization();

    expect(result).toBeUndefined();
    expect(facade.summarizing()).toBe(false);
    expect(facade.error()).toBeUndefined();
  });

  it('exportMeeting exports through the chosen save path', async () => {
    await facade.startRecording('Retro');
    const selected = facade.selectedMeeting();
    if (!selected) {
      throw new Error('Expected a selected meeting after startRecording.');
    }

    await facade.exportMeeting(selected.id, 'markdown', 'Retro');

    expect(facade.error()).toBeUndefined();
  });

  it('exportMeeting is a silent no-op when the save dialog is cancelled', async () => {
    const fileDialog = TestBed.inject(FileDialogPort) as InMemoryFileDialogFake;
    fileDialog.seed(null);
    await facade.startRecording('Retro');
    const selected = facade.selectedMeeting();
    if (!selected) {
      throw new Error('Expected a selected meeting after startRecording.');
    }

    await facade.exportMeeting(selected.id, 'markdown', 'Retro');

    expect(facade.error()).toBeUndefined();
  });

  it('defaults captureSource to mixed (both mic and system) and has no system audio status yet', () => {
    expect(facade.captureSource()).toBe('mixed');
    expect(facade.systemAudioStatus()).toBeUndefined();
  });

  it('selectCaptureSource updates the store signal', () => {
    facade.selectCaptureSource('mixed');

    expect(facade.captureSource()).toBe('mixed');
  });

  it('checkSystemAudio loads the current status from the recorder port', async () => {
    const recorder = TestBed.inject(RecorderPort) as InMemoryRecorderFake;
    recorder.setSystemAudioStatus({ kind: 'permission_denied', restartRequired: true });

    await facade.checkSystemAudio();

    expect(facade.systemAudioStatus()).toEqual({ kind: 'permission_denied', restartRequired: true });
  });

  it('requestSystemAudioPermission updates the status from the recorder port', async () => {
    const recorder = TestBed.inject(RecorderPort) as InMemoryRecorderFake;
    recorder.setSystemAudioStatus({ kind: 'available' });

    await facade.requestSystemAudioPermission();

    expect(facade.systemAudioStatus()).toEqual({ kind: 'available' });
  });

  it('startRecording forwards the selected capture source to the use case', async () => {
    const recorder = TestBed.inject(RecorderPort) as InMemoryRecorderFake;
    facade.selectCaptureSource('system');

    await facade.startRecording('Standup');

    expect(recorder.getLastRequestedSource()).toBe('system');
  });

  it('defaults audioSources to empty and selectedAudioSource to the all-output source', () => {
    expect(facade.audioSources()).toEqual([]);
    expect(facade.selectedAudioSource()).toBe(ALL_SYSTEM_AUDIO_SOURCE_ID);
    expect(facade.effectiveSystemSource()).toBeNull();
  });

  it('loads audio sources from the recorder port, not a hardcoded list', async () => {
    const recorder = TestBed.inject(RecorderPort) as InMemoryRecorderFake;
    const seeded = [
      { id: ALL_SYSTEM_AUDIO_SOURCE_ID, name: 'All system audio' },
      { id: 'app:teams', name: 'Teams' },
    ];
    recorder.setAudioSources(seeded);
    await facade.loadAudioSources();
    expect(facade.audioSources()).toEqual(seeded);
  });

  it('selectAudioSource updates the store signal', () => {
    facade.selectAudioSource('app:teams');
    expect(facade.selectedAudioSource()).toBe('app:teams');
  });

  it('startRecording forwards the selected audio source id to the use case', async () => {
    const recorder = TestBed.inject(RecorderPort) as InMemoryRecorderFake;
    facade.selectAudioSource('app:teams');
    await facade.startRecording('Standup');
    expect(recorder.getLastRequestedSystemSource()).toBe('app:teams');
  });

  it('reflects the effective system source once recorder reports a fallback', async () => {
    const recorder = TestBed.inject(RecorderPort) as InMemoryRecorderFake;
    facade.selectCaptureSource('mixed');
    facade.selectAudioSource('app:vanished');

    await facade.startRecording('Standup');

    expect(recorder.getLastRequestedSystemSource()).toBe('app:vanished');
    expect(facade.effectiveSystemSource()).toEqual({ id: ALL_SYSTEM_AUDIO_SOURCE_ID, name: 'All system audio' });
  });

  it('defaults selectedSummaryLanguage to en and starts with no summary languages', () => {
    expect(facade.summaryLanguages()).toEqual([]);
    expect(facade.selectedSummaryLanguage()).toBe('en');
  });

  it('loads summary languages from the port, not a hardcoded list', async () => {
    const summarizer = TestBed.inject(SummarizerPort) as InMemorySummarizerFake;
    summarizer.seedLanguages([{ code: 'de', label: 'German' }]);

    await facade.loadSummaryLanguages();

    expect(facade.summaryLanguages()).toEqual([{ code: 'de', label: 'German' }]);
  });

  it('selectSummaryLanguage updates the selection and persists it via PreferencesPort', () => {
    const preferences = TestBed.inject(PreferencesPort) as InMemoryPreferencesFake;

    facade.selectSummaryLanguage('fr');

    expect(facade.selectedSummaryLanguage()).toBe('fr');
    expect(preferences.get('meetings.summaryLanguage')).toBe('fr');
  });

  it('summarizeMeeting forwards the selected summary language to the summarizer', async () => {
    await facade.startRecording('Planning');
    const selected = facade.selectedMeeting();
    if (!selected) {
      throw new Error('Expected a selected meeting after startRecording.');
    }
    facade.selectSummaryLanguage('fr');

    await facade.summarizeMeeting(selected.id, {
      name: 'key-points',
      description: 'Key points',
      prompt: 'Summarize the key points.',
    });

    expect(facade.selectedMeeting()?.summaries.at(-1)?.language).toBe('fr');
  });

  it('loadSummary fetches and caches a persisted summary that has no markdown yet (the restart regression)', async () => {
    const summarizer = TestBed.inject(SummarizerPort) as InMemorySummarizerFake;
    const meetingId = toMeetingId('m-1');
    const createdAt = new Date();
    summarizer.seedSummary(meetingId, { template: 'key-points', markdown: '# Key points', createdAt, language: 'en' });
    expect(facade.summaryCache().size).toBe(0);

    await facade.loadSummary(meetingId, 'key-points', 'en');

    expect(facade.summaryCache().get(`${meetingId}::key-points::en`)).toEqual({
      status: 'loaded',
      summary: { template: 'key-points', markdown: '# Key points', createdAt, language: 'en' },
    });
  });

  it('loadSummary caches a null resolution as the empty state, never as an error', async () => {
    await facade.loadSummary(toMeetingId('m-1'), 'key-points', 'en');

    expect(facade.summaryCache().get('m-1::key-points::en')).toEqual({ status: 'empty' });
    expect(facade.error()).toBeUndefined();
  });

  it('loadSummary is a no-op once the (meeting, template, language) triple already has a cache entry', async () => {
    const summarizer = TestBed.inject(SummarizerPort) as InMemorySummarizerFake;
    const getSummarySpy = vi.spyOn(summarizer, 'getSummary');
    const meetingId = toMeetingId('m-1');

    await facade.loadSummary(meetingId, 'key-points', 'en');
    await facade.loadSummary(meetingId, 'key-points', 'en');

    expect(getSummarySpy).toHaveBeenCalledTimes(1);
  });

  it('loadAppVersion reads the version from AppInfoPort', async () => {
    const appInfo = TestBed.inject(AppInfoPort) as InMemoryAppInfoFake;
    appInfo.seedVersion('0.5.0');

    await facade.loadAppVersion();

    expect(facade.appVersion()).toBe('0.5.0');
  });
});

describe('MeetingsFacade against a real Tauri adapter rejection', () => {
  afterEach(() => uninstallTauriInternalsStub());

  it('surfaces the Rust error code through the facade without losing it at the IPC seam', async () => {
    installTauriInternalsStub((cmd) => {
      if (cmd === 'list_meetings') {
        throw { code: 'MODELS_MISSING', message: 'required model is not downloaded' };
      }
      throw new Error(`unexpected command '${cmd}'`);
    });

    // Only the repository port is left bound to the real TauriMeetingRepositoryAdapter
    // (from provideMeetings()); every other port is faked so the rest of the
    // facade's dependencies don't need a live Tauri runtime.
    TestBed.configureTestingModule({
      providers: [
        provideMeetings(),
        { provide: RecorderPort, useClass: InMemoryRecorderFake },
        { provide: SummarizerPort, useClass: InMemorySummarizerFake },
        { provide: TranscriberPort, useClass: InMemoryTranscriberFake },
        { provide: TemplateRepositoryPort, useClass: InMemoryTemplateRepositoryFake },
        { provide: ModelsStatusPort, useClass: InMemoryModelsStatusFake },
        { provide: FileDialogPort, useClass: InMemoryFileDialogFake },
        { provide: PreferencesPort, useClass: InMemoryPreferencesFake },
      ],
    });
    const realAdapterFacade = TestBed.inject(MeetingsFacade);

    await realAdapterFacade.loadMeetings();
    await flushMicrotasks();

    expect(realAdapterFacade.error()?.code).toBe('MODELS_MISSING');
    expect(realAdapterFacade.error()?.message).toBe('required model is not downloaded');
  });
});
