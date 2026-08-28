import { Injectable, inject } from '@angular/core';

import type { Meeting, MeetingId } from '../../core/models/meeting.model';
import { AudioImportPort } from '../../core/ports/audio-import.port';

@Injectable()
export class RetranscribeMeetingUseCase {
  private readonly audioImport = inject(AudioImportPort);

  async retranscribe(id: MeetingId, path?: string): Promise<Meeting> {
    return this.audioImport.retranscribe(id, path);
  }
}
