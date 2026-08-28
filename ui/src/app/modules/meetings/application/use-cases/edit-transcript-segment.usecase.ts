import { Injectable, inject } from '@angular/core';

import type { Meeting, MeetingId } from '../../core/models/meeting.model';
import { MeetingRepositoryPort } from '../../core/ports/meeting-repository.port';

@Injectable()
export class EditTranscriptSegmentUseCase {
  private readonly repository = inject(MeetingRepositoryPort);

  async edit(id: MeetingId, index: number, text: string): Promise<Meeting> {
    return this.repository.editTranscriptSegment(id, index, text);
  }
}
