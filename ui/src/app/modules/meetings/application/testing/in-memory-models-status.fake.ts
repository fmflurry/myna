import { Injectable } from '@angular/core';

import type { ModelsStatus } from '../../core/models/models-status.model';
import { ModelsStatusPort } from '../../core/ports/models-status.port';

const DEFAULT_STATUS: ModelsStatus = {
  parakeet: { present: true, expectedFiles: ['model.onnx'] },
  qwen: { present: true, expectedFiles: ['model.gguf'] },
  silero: { present: true, expectedFiles: ['silero_vad.onnx'] },
  diarization: { present: true, expectedFiles: ['model.int8.onnx', 'nemo_en_titanet_small.onnx'] },
  allPresent: true,
};

/** In-memory ModelsStatusPort implementation for specs and the placeholder providers. */
@Injectable()
export class InMemoryModelsStatusFake extends ModelsStatusPort {
  private modelsStatus: ModelsStatus = DEFAULT_STATUS;

  override async status(): Promise<ModelsStatus> {
    return this.modelsStatus;
  }

  /** Test helper: replace the in-memory models status. */
  seed(status: ModelsStatus): void {
    this.modelsStatus = status;
  }
}
