import { TestBed } from '@angular/core/testing';

import { AudioImportPort } from '../../core/ports/audio-import.port';
import { PreferencesPort } from '../../core/ports/preferences.port';
import { RecorderPort } from '../../core/ports/recorder.port';
import { SummarizerPort } from '../../core/ports/summarizer.port';
import { TranscriberPort } from '../../core/ports/transcriber.port';
import { InMemoryAudioImportFake } from '../testing/in-memory-audio-import.fake';
import { InMemoryPreferencesFake } from '../testing/in-memory-preferences.fake';
import { InMemoryRecorderFake } from '../testing/in-memory-recorder.fake';
import { InMemorySummarizerFake } from '../testing/in-memory-summarizer.fake';
import { InMemoryTranscriberFake } from '../testing/in-memory-transcriber.fake';
import { MIC_DEVICE_PREFERENCE_KEY, MeetingsStore } from './meetings.store';

/**
 * Device-catalog state and mic-selection persistence. Split out of
 * `meetings.store.spec.ts` to keep that file under the project's max-lines
 * limit.
 */
describe('MeetingsStore devices', () => {
  let store: MeetingsStore;
  let preferences: InMemoryPreferencesFake;

  const configureStore = (sharedPreferences?: InMemoryPreferencesFake): void => {
    TestBed.configureTestingModule({
      providers: [
        MeetingsStore,
        InMemoryRecorderFake,
        { provide: RecorderPort, useExisting: InMemoryRecorderFake },
        InMemoryTranscriberFake,
        { provide: TranscriberPort, useExisting: InMemoryTranscriberFake },
        { provide: SummarizerPort, useClass: InMemorySummarizerFake },
        InMemoryAudioImportFake,
        { provide: AudioImportPort, useExisting: InMemoryAudioImportFake },
        sharedPreferences
          ? { provide: PreferencesPort, useValue: sharedPreferences }
          : { provide: PreferencesPort, useClass: InMemoryPreferencesFake },
      ],
    });
  };

  beforeEach(() => {
    configureStore();
    store = TestBed.inject(MeetingsStore);
    preferences = TestBed.inject(PreferencesPort) as InMemoryPreferencesFake;
  });

  it('starts with an empty device list and no selected device', () => {
    expect(store.devices()).toEqual([]);
    expect(store.selectedDevice()).toBeNull();
  });

  it('never mutates the devices signal in place', () => {
    const previous = store.devices();

    store.setDevices([{ name: 'Built-in Microphone' }]);

    expect(store.devices()).not.toBe(previous);
    expect(store.devices()[0]?.name).toBe('Built-in Microphone');
  });

  it('clears the selected device back to null', () => {
    store.setSelectedDevice({ name: 'Headset' });
    expect(store.selectedDevice()?.name).toBe('Headset');

    store.setSelectedDevice(null);

    expect(store.selectedDevice()).toBeNull();
  });

  it('persists the selected mic device name and clears it on the sentinel', () => {
    store.setSelectedDevice({ name: 'Headset' });
    expect(preferences.get(MIC_DEVICE_PREFERENCE_KEY)).toBe('Headset');

    store.setSelectedDevice(null);
    expect(preferences.get(MIC_DEVICE_PREFERENCE_KEY)).toBe('');
  });

  it('reads a persisted mic device name back across a store rebuild', () => {
    store.setSelectedDevice({ name: 'Headset' });
    TestBed.resetTestingModule();
    configureStore(preferences);
    const rebuiltStore = TestBed.inject(MeetingsStore);
    expect(rebuiltStore.selectedDevice()?.name).toBe('Headset');
  });

  it('starts with no output devices, no default input device and no default output device', () => {
    expect(store.outputDevices()).toEqual([]);
    expect(store.defaultDevice()).toBeNull();
    expect(store.defaultOutputDevice()).toBeNull();
  });

  it('reflects the output-device setters', () => {
    store.setOutputDevices([{ name: 'Built-in Output' }, { name: 'USB Speakers' }]);
    store.setDefaultDevice({ name: 'Built-in Microphone' });
    store.setDefaultOutputDevice({ name: 'Built-in Output' });

    expect(store.outputDevices()).toEqual([{ name: 'Built-in Output' }, { name: 'USB Speakers' }]);
    expect(store.defaultDevice()).toEqual({ name: 'Built-in Microphone' });
    expect(store.defaultOutputDevice()).toEqual({ name: 'Built-in Output' });
  });
});
