import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AudioDevice } from '../../core/models/audio-device.model';
import { AppInfoPort } from '../../core/ports/app-info.port';
import { AudioImportPort } from '../../core/ports/audio-import.port';
import { FileDialogPort } from '../../core/ports/file-dialog.port';
import { FolderRepositoryPort } from '../../core/ports/folder-repository.port';
import { MeetingRepositoryPort } from '../../core/ports/meeting-repository.port';
import { ModelsStatusPort } from '../../core/ports/models-status.port';
import { PreferencesPort } from '../../core/ports/preferences.port';
import { RecorderPort } from '../../core/ports/recorder.port';
import { SummarizerPort } from '../../core/ports/summarizer.port';
import { TemplateRepositoryPort } from '../../core/ports/template-repository.port';
import { TranscriberPort } from '../../core/ports/transcriber.port';
import { provideMeetings } from '../../meetings.providers';
import {
  flushMicrotasks,
  installTauriInternalsStub,
  uninstallTauriInternalsStub,
} from '../../infrastructure/tauri/testing/tauri-internals.stub';
import { InMemoryAppInfoFake } from '../testing/in-memory-app-info.fake';
import { InMemoryAudioImportFake } from '../testing/in-memory-audio-import.fake';
import { InMemoryFileDialogFake } from '../testing/in-memory-file-dialog.fake';
import { InMemoryFolderRepositoryFake } from '../testing/in-memory-folder-repository.fake';
import { InMemoryMeetingRepositoryFake } from '../testing/in-memory-meeting-repository.fake';
import { InMemoryModelsStatusFake } from '../testing/in-memory-models-status.fake';
import { InMemoryPreferencesFake } from '../testing/in-memory-preferences.fake';
import { InMemoryRecorderFake } from '../testing/in-memory-recorder.fake';
import { InMemorySummarizerFake } from '../testing/in-memory-summarizer.fake';
import { InMemoryTemplateRepositoryFake } from '../testing/in-memory-template-repository.fake';
import { InMemoryTranscriberFake } from '../testing/in-memory-transcriber.fake';
import { MeetingsStore } from '../stores/meetings.store';
import { DEVICE_POLL_INTERVAL_MS } from './meetings-facade.support';
import { MeetingsFacade } from './meetings.facade';

/**
 * Device polling: cpal exposes no default-device-changed callback (a
 * CoreAudio listener would need `unsafe`, forbidden workspace-wide), so the
 * facade re-runs `loadDevices` on an interval to keep `defaultDevice()` /
 * `devices()` fresh while the app is open. Split out of
 * `meetings.facade.spec.ts` to keep that file under the project's max-lines
 * limit.
 */
describe('MeetingsFacade device polling', () => {
  const configure = (): void => {
    TestBed.configureTestingModule({
      providers: [
        provideMeetings(),
        { provide: MeetingRepositoryPort, useClass: InMemoryMeetingRepositoryFake },
        { provide: FolderRepositoryPort, useClass: InMemoryFolderRepositoryFake },
        { provide: RecorderPort, useClass: InMemoryRecorderFake },
        { provide: SummarizerPort, useClass: InMemorySummarizerFake },
        { provide: TranscriberPort, useClass: InMemoryTranscriberFake },
        { provide: TemplateRepositoryPort, useClass: InMemoryTemplateRepositoryFake },
        { provide: ModelsStatusPort, useClass: InMemoryModelsStatusFake },
        { provide: FileDialogPort, useClass: InMemoryFileDialogFake },
        { provide: AppInfoPort, useClass: InMemoryAppInfoFake },
        { provide: AudioImportPort, useClass: InMemoryAudioImportFake },
        { provide: PreferencesPort, useValue: new InMemoryPreferencesFake() },
      ],
    });
  };

  // The facade constructor now also subscribes to the model-download event
  // streams, which hit the REAL Tauri events adapter (no port to fake) —
  // stub the internals so those listens resolve harmlessly.
  beforeEach(() => {
    installTauriInternalsStub(() => undefined);
  });

  afterEach(async () => {
    // Restore REAL timers before flushing: `flushMicrotasks` resolves via
    // `setTimeout`, which would never fire under the fake timers the test
    // installed — hanging this hook past its 10s timeout.
    vi.useRealTimers();
    await flushMicrotasks();
    uninstallTauriInternalsStub();
  });

  it('re-lists devices after the poll interval and picks up a changed OS default', async () => {
    vi.useFakeTimers();
    configure();
    const facade = TestBed.inject(MeetingsFacade);
    const recorder = TestBed.inject(RecorderPort) as InMemoryRecorderFake;
    await facade.loadDevices();
    expect(facade.defaultDevice()?.name).toBe('Built-in Microphone');

    // The OS default changes while the app is open; no backend event exists,
    // so only the poll can notice.
    const devices: readonly AudioDevice[] = [{ name: 'USB Headset' }, { name: 'Built-in Microphone' }];
    vi.spyOn(recorder, 'listDevices').mockResolvedValue(devices);
    vi.spyOn(recorder, 'defaultDevice').mockResolvedValue({ name: 'USB Headset' });

    await vi.advanceTimersByTimeAsync(DEVICE_POLL_INTERVAL_MS);

    expect(facade.defaultDevice()?.name).toBe('USB Headset');
    expect(facade.devices()).toEqual(devices);
  });

  it('skips a tick while the previous device load is still in flight', async () => {
    vi.useFakeTimers();
    configure();
    const facade = TestBed.inject(MeetingsFacade);
    const recorder = TestBed.inject(RecorderPort) as InMemoryRecorderFake;
    await facade.loadDevices();

    let releaseFirst!: () => void;
    const gated = new Promise<readonly AudioDevice[]>((resolve) => {
      releaseFirst = () => resolve([{ name: 'USB Headset' }]);
    });
    const listSpy = vi
      .spyOn(recorder, 'listDevices')
      .mockReturnValueOnce(gated)
      .mockReturnValue(Promise.resolve([{ name: 'Built-in Microphone' }] satisfies readonly AudioDevice[]));

    await vi.advanceTimersByTimeAsync(DEVICE_POLL_INTERVAL_MS);
    expect(listSpy).toHaveBeenCalledTimes(1); // tick 1 started, gated mid-flight

    await vi.advanceTimersByTimeAsync(DEVICE_POLL_INTERVAL_MS);
    expect(listSpy).toHaveBeenCalledTimes(1); // tick 2 skipped: previous load in flight

    releaseFirst();
    await vi.advanceTimersByTimeAsync(0); // flush tick 1's completion, clear the in-flight flag
    await vi.advanceTimersByTimeAsync(DEVICE_POLL_INTERVAL_MS);
    expect(listSpy).toHaveBeenCalledTimes(2); // tick 3 runs again
  });

  it('does not poll any input, output, or default device source while recording or stopping', async () => {
    vi.useFakeTimers();
    configure();
    TestBed.inject(MeetingsFacade);
    const recorder = TestBed.inject(RecorderPort) as InMemoryRecorderFake;
    const store = TestBed.inject(MeetingsStore);
    const inputDevices = vi.spyOn(recorder, 'listDevices');
    const inputDefault = vi.spyOn(recorder, 'defaultDevice');
    const outputDevices = vi.spyOn(recorder, 'listOutputDevices');
    const outputDefault = vi.spyOn(recorder, 'defaultOutputDevice');

    store.setRecordingState('recording');
    await vi.advanceTimersByTimeAsync(60_000);
    store.setRecordingState('stopping');
    await vi.advanceTimersByTimeAsync(60_000);

    expect(inputDevices).not.toHaveBeenCalled();
    expect(inputDefault).not.toHaveBeenCalled();
    expect(outputDevices).not.toHaveBeenCalled();
    expect(outputDefault).not.toHaveBeenCalled();
  });

  it('refreshes devices immediately when recording returns to idle', async () => {
    vi.useFakeTimers();
    configure();
    TestBed.inject(MeetingsFacade);
    const recorder = TestBed.inject(RecorderPort) as InMemoryRecorderFake;
    const store = TestBed.inject(MeetingsStore);
    const inputDevices = vi.spyOn(recorder, 'listDevices');
    const inputDefault = vi.spyOn(recorder, 'defaultDevice');
    const outputDevices = vi.spyOn(recorder, 'listOutputDevices');
    const outputDefault = vi.spyOn(recorder, 'defaultOutputDevice');

    store.setRecordingState('recording');
    store.setRecordingState('idle');
    await vi.advanceTimersByTimeAsync(0);

    expect(inputDevices).toHaveBeenCalledTimes(1);
    expect(inputDefault).toHaveBeenCalledTimes(1);
    expect(outputDevices).toHaveBeenCalledTimes(1);
    expect(outputDefault).toHaveBeenCalledTimes(1);
  });

  it('backs off idle polling after failures, caps retries at one minute, and resets to five seconds after success', async () => {
    vi.useFakeTimers();
    configure();
    TestBed.inject(MeetingsFacade);
    const recorder = TestBed.inject(RecorderPort) as InMemoryRecorderFake;
    const listDevices = vi
      .spyOn(recorder, 'listDevices')
      .mockRejectedValueOnce(new Error('first failure'))
      .mockRejectedValueOnce(new Error('second failure'))
      .mockRejectedValueOnce(new Error('third failure'))
      .mockResolvedValue([{ name: 'Built-in Microphone' }]);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(listDevices).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(listDevices).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(listDevices).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(listDevices).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(listDevices).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(listDevices).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(listDevices).toHaveBeenCalledTimes(5);
  });

  it('cancels a pending poll when its injector is destroyed', async () => {
    vi.useFakeTimers();
    configure();
    TestBed.inject(MeetingsFacade);
    const recorder = TestBed.inject(RecorderPort) as InMemoryRecorderFake;
    const listDevices = vi.spyOn(recorder, 'listDevices');

    TestBed.resetTestingModule();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(listDevices).not.toHaveBeenCalled();
  });

  it('allows an explicit device refresh while recording or stopping', async () => {
    vi.useFakeTimers();
    configure();
    const facade = TestBed.inject(MeetingsFacade);
    const recorder = TestBed.inject(RecorderPort) as InMemoryRecorderFake;
    const store = TestBed.inject(MeetingsStore);
    const listDevices = vi.spyOn(recorder, 'listDevices');

    store.setRecordingState('recording');
    await facade.loadDevices();
    store.setRecordingState('stopping');
    await facade.loadDevices();

    expect(listDevices).toHaveBeenCalledTimes(2);
  });
});
