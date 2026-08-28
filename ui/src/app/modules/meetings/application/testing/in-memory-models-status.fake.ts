import { Injectable } from '@angular/core';

import type { ModelsStatus } from '../../core/models/models-status.model';
import { ModelsStatusPort } from '../../core/ports/models-status.port';

const DEFAULT_STATUS: ModelsStatus = {
  parakeet: { present: true, expectedFiles: ['model.onnx'] },
  qwen: { present: true, expectedFiles: ['model.gguf'] },
  silero: { present: true, expectedFiles: ['silero_vad.onnx'] },
  allPresent: true,
};

/** In-memory ModelsStatusPort implementation for specs and the placeholder providers. */
@Injectable()
export class InMemoryModelsStatusFake extends ModelsStatusPort {
  private modelsStatus: ModelsStatus = DEFAULT_STATUS;

  override async status(): Promise<ModelsStatus> {
    return this.modelsStatus;
  }

  override async downloadCommand(): Promise<string> {
    return 'hf download csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8';
  }

  /** Test helper: replace the in-memory models status. */
  seed(status: ModelsStatus): void {
    this.modelsStatus = status;
  }
}
