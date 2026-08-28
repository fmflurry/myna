import { Injectable, inject } from '@angular/core';

import type { ModelsStatus } from '../../core/models/models-status.model';
import { ModelsStatusPort } from '../../core/ports/models-status.port';

@Injectable()
export class CheckModelsUseCase {
  private readonly modelsStatus = inject(ModelsStatusPort);

  async check(): Promise<ModelsStatus> {
    return this.modelsStatus.status();
  }
}
