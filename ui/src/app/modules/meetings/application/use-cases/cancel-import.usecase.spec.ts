import { TestBed } from '@angular/core/testing';

import { AudioImportPort } from '../../core/ports/audio-import.port';
import { InMemoryAudioImportFake } from '../testing/in-memory-audio-import.fake';
import { CancelImportUseCase } from './cancel-import.usecase';

describe('CancelImportUseCase', () => {
  let useCase: CancelImportUseCase;
  let audioImport: InMemoryAudioImportFake;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        CancelImportUseCase,
        InMemoryAudioImportFake,
        { provide: AudioImportPort, useExisting: InMemoryAudioImportFake },
      ],
    });
    useCase = TestBed.inject(CancelImportUseCase);
    audioImport = TestBed.inject(InMemoryAudioImportFake);
  });

  it('delegates to the audio import port cancel()', async () => {
    await useCase.cancel();

    expect(audioImport.getCancelCallCount()).toBe(1);
  });

  it('propagates a rejection from the port', async () => {
    audioImport.seedError(new Error('nothing to cancel'));

    let caught: unknown;
    try {
      await useCase.cancel();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
  });
});
