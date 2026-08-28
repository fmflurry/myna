import { Injectable, inject } from '@angular/core';

import { AudioImportPort } from '../../core/ports/audio-import.port';

@Injectable()
export class CancelImportUseCase {
  private readonly audioImport = inject(AudioImportPort);

  async cancel(): Promise<void> {
    await this.audioImport.cancel();
  }
}
