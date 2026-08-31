import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { ALL_SYSTEM_AUDIO_SOURCE_ID } from '../../core/models/audio-source.model';
import { AppInfoPort } from '../../core/ports/app-info.port';
import { FileDialogPort } from '../../core/ports/file-dialog.port';
import { MeetingRepositoryPort } from '../../core/ports/meeting-repository.port';
import { ModelsStatusPort } from '../../core/ports/models-status.port';
import { PreferencesPort } from '../../core/ports/preferences.port';
import { RecorderPort } from '../../core/ports/recorder.port';
import { SummarizerPort } from '../../core/ports/summarizer.port';
import { TemplateRepositoryPort } from '../../core/ports/template-repository.port';
import { TranscriberPort } from '../../core/ports/transcriber.port';
import { AUDIO_SOURCE_PREFERENCE_KEY, MIC_DEVICE_PREFERENCE_KEY } from '../stores/meetings.store';
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
 * Capture-default selection semantics: the mic default-sentinel, stale
 * persisted selections falling back to sane defaults, and the device-less
 * `start_recording` call. Split out of `meetings.facade.spec.ts` to keep
 * that file under the project's max-lines limit.
 */
describe('MeetingsFacade capture defaults', () => {
  const configure = (preferences?: InMemoryPreferencesFake): void => {
    TestBed.configureTestingModule({
      providers: [
        provideMeetings(),
        { provide: MeetingRepositoryPort, useClass: InMemoryMeetingRepositoryFake },
        { provide: RecorderPort, useClass: InMemoryRecorderFake },
        { provide: SummarizerPort, useClass: InMemorySummarizerFake },
        { provide: TranscriberPort, useClass: InMemoryTranscriberFake },
        { provide: TemplateRepositoryPort, useClass: InMemoryTemplateRepositoryFake },
        { provide: ModelsStatusPort, useClass: InMemoryModelsStatusFake },
        { provide: FileDialogPort, useClass: InMemoryFileDialogFake },
        { provide: AppInfoPort, useClass: InMemoryAppInfoFake },
        { provide: PreferencesPort, useValue: preferences ?? new InMemoryPreferencesFake() },
      ],
    });
  };

  it('leaves the mic selection at the default-sentinel when nothing is persisted, and loads output devices', async () => {
    configure();
    const facade = TestBed.inject(MeetingsFacade);
    expect(facade.devices()).toEqual([]);
    expect(facade.selectedDevice()).toBeNull();

    await facade.loadDevices();

    expect(facade.devices().length).toBeGreaterThan(0);
    // Sentinel: start_recording is called WITHOUT a device; the backend
    // resolves the OS default at record time.
    expect(facade.selectedDevice()).toBeNull();
    expect(facade.defaultDevice()?.name).toBe('Built-in Microphone');
    expect(facade.outputDevices().length).toBeGreaterThan(0);
    expect(facade.defaultOutputDevice()?.name).toBe('Built-in Output');
  });

  it('does not override an already-selected device on reload, persisting it via PreferencesPort', async () => {
    configure();
    const facade = TestBed.inject(MeetingsFacade);
    const preferences = TestBed.inject(PreferencesPort) as InMemoryPreferencesFake;
    await facade.loadDevices();
    facade.selectDevice('Built-in Microphone');

    await facade.loadDevices();

    expect(facade.selectedDevice()?.name).toBe('Built-in Microphone');
    expect(preferences.get(MIC_DEVICE_PREFERENCE_KEY)).toBe('Built-in Microphone');
  });

  it('ignores selectDevice for an unknown device name', async () => {
    configure();
    const facade = TestBed.inject(MeetingsFacade);
    await facade.loadDevices();
    const before = facade.selectedDevice();

    facade.selectDevice('Nonexistent Device');

    expect(facade.selectedDevice()).toBe(before);
  });

  it('selectDevice("") clears back to the default-sentinel and persists the clear', async () => {
    configure();
    const facade = TestBed.inject(MeetingsFacade);
    const preferences = TestBed.inject(PreferencesPort) as InMemoryPreferencesFake;
    await facade.loadDevices();
    facade.selectDevice('Built-in Microphone');
    expect(facade.selectedDevice()?.name).toBe('Built-in Microphone');

    facade.selectDevice('');

    expect(facade.selectedDevice()).toBeNull();
    expect(preferences.get(MIC_DEVICE_PREFERENCE_KEY)).toBe('');
  });

  it('falls back to the default-sentinel when the persisted mic device no longer exists', async () => {
    const preferences = new InMemoryPreferencesFake();
    preferences.set(MIC_DEVICE_PREFERENCE_KEY, 'Retired USB Mic');
    configure(preferences);
    const facade = TestBed.inject(MeetingsFacade);

    await facade.loadDevices();

    expect(facade.selectedDevice()).toBeNull();
  });

  it('startRecording omits the device when the mic default-sentinel is selected', async () => {
    configure();
    const facade = TestBed.inject(MeetingsFacade);
    const recorder = TestBed.inject(RecorderPort) as InMemoryRecorderFake;
    await facade.loadDevices(); // nothing persisted → sentinel

    await facade.startRecording('Standup');

    expect(recorder.getLastRequestedDevice()).toBeUndefined();
  });

  it('falls back to the all-output source when the persisted audio-source id is stale', async () => {
    const preferences = new InMemoryPreferencesFake();
    preferences.set(AUDIO_SOURCE_PREFERENCE_KEY, 'app:pid:4242');
    configure(preferences);
    const facade = TestBed.inject(MeetingsFacade);

    await facade.loadAudioSources();

    expect(facade.selectedAudioSource()).toBe(ALL_SYSTEM_AUDIO_SOURCE_ID);
  });

  it('keeps a persisted audio-source id that is still offered by the fresh list', async () => {
    const preferences = new InMemoryPreferencesFake();
    preferences.set(AUDIO_SOURCE_PREFERENCE_KEY, 'app:demo');
    configure(preferences);
    const facade = TestBed.inject(MeetingsFacade);

    await facade.loadAudioSources();

    expect(facade.selectedAudioSource()).toBe('app:demo');
  });

  it('never calls start_recording with a stale device name after validation', async () => {
    const preferences = new InMemoryPreferencesFake();
    preferences.set(MIC_DEVICE_PREFERENCE_KEY, 'Retired USB Mic');
    configure(preferences);
    const facade = TestBed.inject(MeetingsFacade);
    const recorder = TestBed.inject(RecorderPort) as InMemoryRecorderFake;
    const startSpy = vi.spyOn(recorder, 'start');

    await facade.loadDevices();
    await facade.startRecording('Standup');

    expect(startSpy.mock.calls[0]?.[1]).toBeUndefined();
  });
});
