import { Injectable, inject } from '@angular/core';

import type { Meeting } from '../../core/models/meeting.model';
import { AudioImportPort } from '../../core/ports/audio-import.port';

@Injectable()
export class ImportAudioUseCase {
  private readonly audioImport = inject(AudioImportPort);

  async import(path: string, title?: string): Promise<Meeting> {
    return this.audioImport.importFile(path, title);
  }
}
