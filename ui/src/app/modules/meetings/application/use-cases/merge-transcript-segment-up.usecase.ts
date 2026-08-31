import { Injectable, inject } from '@angular/core';

import type { Meeting, MeetingId } from '../../core/models/meeting.model';
import { MeetingRepositoryPort } from '../../core/ports/meeting-repository.port';

@Injectable()
export class MergeTranscriptSegmentUpUseCase {
  private readonly repository = inject(MeetingRepositoryPort);

  async merge(id: MeetingId, index: number, expectedText: string): Promise<Meeting> {
    return this.repository.mergeTranscriptSegmentUp(id, index, expectedText);
  }
}
