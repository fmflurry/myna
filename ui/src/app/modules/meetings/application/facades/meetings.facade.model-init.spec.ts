import { TestBed } from '@angular/core/testing';

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
 * Model-download facade behavior. `ModelInitializerPort` is deliberately
 * left bound to the real `TauriModelInitializerAdapter` (from
 * `provideMeetings()`) so the `models://progress` / `models://done` events
 * flow through the real IPC seam, driven by the `__TAURI_INTERNALS__` stub;
 * every other port is faked. The stub MUST be installed before the facade
 * is injected — its constructor subscribes to the event streams.
 */
describe('MeetingsFacade model download', () => {
  let facade: MeetingsFacade;
  let stub: ReturnType<typeof installTauriInternalsStub>;
  let commands: string[];

  const missingStatus = {
    parakeet: { present: false, expectedFiles: ['encoder.int8.onnx'] },
    qwen: { present: false, expectedFiles: ['model.gguf'] },
    silero: { present: true, expectedFiles: ['silero_vad.onnx'] },
    allPresent: false,
  };
  const completeStatus = {
    parakeet: { present: true, expectedFiles: ['encoder.int8.onnx'] },
    qwen: { present: true, expectedFiles: ['model.gguf'] },
    silero: { present: true, expectedFiles: ['silero_vad.onnx'] },
    allPresent: true,
  };

  beforeEach(async () => {
    commands = [];
    stub = installTauriInternalsStub((cmd) => {
      commands.push(cmd);
      if (cmd === 'start_model_download' || cmd === 'cancel_model_download') {
        return undefined;
      }
      throw new Error(`unexpected command '${cmd}'`);
    });

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
        { provide: PreferencesPort, useClass: InMemoryPreferencesFake },
        { provide: AppInfoPort, useClass: InMemoryAppInfoFake },
      ],
    });
    facade = TestBed.inject(MeetingsFacade);
    // Let the constructor's `models://progress` / `models://done` listen()
    // promises resolve so the stub can route emitted events to them.
    await flushMicrotasks();
  });

  afterEach(() => uninstallTauriInternalsStub());

  it('initializeModels() invokes start_model_download and flips the slice to running', async () => {
    await facade.initializeModels();

    expect(commands).toContain('start_model_download');
    expect(facade.modelDownload().phase).toBe('running');
    expect(facade.error()).toBeUndefined();
  });

  it('a models://progress event moves the slice to running with the artifact about to download', async () => {
    await facade.initializeModels();

    stub.emit('models://progress', { artifact: 'qwen', index: 1, total: 2 });

    expect(facade.modelDownload()).toEqual({
      phase: 'running',
      artifact: 'qwen',
      index: 1,
      total: 2,
      success: false,
      cancelled: false,
      message: null,
    });
  });

  it('a models://done success event lands phase done and re-checks models so allPresent flips', async () => {
    const modelsStatus = TestBed.inject(ModelsStatusPort) as InMemoryModelsStatusFake;
    modelsStatus.seed(missingStatus);
    await facade.checkModels();
    expect(facade.modelsStatus()?.allPresent).toBe(false);
    modelsStatus.seed(completeStatus);

    await facade.initializeModels();
    stub.emit('models://done', { success: true, cancelled: false, message: null });
    await flushMicrotasks();

    expect(facade.modelDownload().phase).toBe('done');
    expect(facade.modelDownload().success).toBe(true);
    expect(facade.modelsStatus()?.allPresent).toBe(true);
  });

  it('a models://done failure event lands phase failed with the backend message', async () => {
    await facade.initializeModels();

    stub.emit('models://done', { success: false, cancelled: false, message: 'download failed: disk full' });

    expect(facade.modelDownload().phase).toBe('failed');
    expect(facade.modelDownload().cancelled).toBe(false);
    expect(facade.modelDownload().message).toBe('download failed: disk full');
  });

  it('a cancelled models://done event lands phase failed with the cancelled flag', async () => {
    await facade.initializeModels();

    stub.emit('models://done', { success: false, cancelled: true, message: null });

    expect(facade.modelDownload().phase).toBe('failed');
    expect(facade.modelDownload().cancelled).toBe(true);
    expect(facade.modelDownload().message).toBeNull();
  });

  it('cancelModelDownload() delegates to cancel_model_download without surfacing an error', async () => {
    await facade.cancelModelDownload();

    expect(commands).toContain('cancel_model_download');
    expect(facade.error()).toBeUndefined();
  });
});
