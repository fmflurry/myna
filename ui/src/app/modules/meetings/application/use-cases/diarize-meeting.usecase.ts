import { Injectable, inject } from '@angular/core';

import type { Meeting, MeetingId } from '../../core/models/meeting.model';
import { AudioImportPort } from '../../core/ports/audio-import.port';

/**
 * User-triggered speaker detection over an already-recorded meeting's
 * system-audio track (`track-system.wav`) — see `diarize_meeting`. Manual
 * only: never invoked automatically (not from `stop_recording`, not from
 * any other use case).
 */
@Injectable()
export class DiarizeMeetingUseCase {
  private readonly audioImport = inject(AudioImportPort);

  async diarize(id: MeetingId): Promise<Meeting> {
    return this.audioImport.diarize(id);
  }
}
