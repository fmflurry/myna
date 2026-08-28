import { TestBed } from '@angular/core/testing';

import { ModelsStatusPort } from '../../core/ports/models-status.port';
import { InMemoryModelsStatusFake } from '../testing/in-memory-models-status.fake';
import { CheckModelsUseCase } from './check-models.usecase';

describe('CheckModelsUseCase', () => {
  let useCase: CheckModelsUseCase;
  let modelsStatus: InMemoryModelsStatusFake;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        CheckModelsUseCase,
        InMemoryModelsStatusFake,
        { provide: ModelsStatusPort, useExisting: InMemoryModelsStatusFake },
      ],
    });
    useCase = TestBed.inject(CheckModelsUseCase);
    modelsStatus = TestBed.inject(InMemoryModelsStatusFake);
  });

  it('reports all models present by default', async () => {
    const status = await useCase.check();

    expect(status.allPresent).toBe(true);
  });

  it('reflects a missing model reported by the port', async () => {
    modelsStatus.seed({
      parakeet: { present: false, expectedFiles: ['model.onnx'] },
      qwen: { present: true, expectedFiles: ['model.gguf'] },
      silero: { present: true, expectedFiles: ['silero_vad.onnx'] },
      allPresent: false,
    });

    const status = await useCase.check();

    expect(status.allPresent).toBe(false);
    expect(status.parakeet.present).toBe(false);
  });
});
