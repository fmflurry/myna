import { Injectable, inject } from '@angular/core';

import type { Meeting, MeetingId } from '../../core/models/meeting.model';
import { MeetingRepositoryPort } from '../../core/ports/meeting-repository.port';

@Injectable()
export class DeleteTranscriptSegmentUseCase {
  private readonly repository = inject(MeetingRepositoryPort);

  async delete(id: MeetingId, index: number, expectedText: string): Promise<Meeting> {
    return this.repository.deleteTranscriptSegment(id, index, expectedText);
  }
}
