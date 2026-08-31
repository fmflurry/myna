import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';

import type {
  ModelDownloadDone,
  ModelDownloadProgress,
} from '../../core/ports/model-initializer.port';
import { ModelInitializerPort } from '../../core/ports/model-initializer.port';

/**
 * Starts and cancels the in-app model download. `start()` resolves once the
 * backend run is spawned; per-artifact progress and the terminal outcome
 * arrive exclusively through the `models://progress` / `models://done`
 * event streams exposed here, which the facade subscribes to.
 */
@Injectable()
export class InitializeModelsUseCase {
  private readonly initializer = inject(ModelInitializerPort);

  async start(): Promise<void> {
    return this.initializer.start();
  }

  async startDiarization(): Promise<void> {
    return this.initializer.startDiarization();
  }

  async cancel(): Promise<void> {
    return this.initializer.cancel();
  }

  progress(): Observable<ModelDownloadProgress> {
    return this.initializer.progress();
  }

  done(): Observable<ModelDownloadDone> {
    return this.initializer.done();
  }
}
