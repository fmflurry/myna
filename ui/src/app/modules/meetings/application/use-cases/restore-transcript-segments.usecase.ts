import { Injectable, inject } from '@angular/core';

import type { Meeting, MeetingId } from '../../core/models/meeting.model';
import type { TranscriptSegment } from '../../core/models/transcript.model';
import { MeetingRepositoryPort } from '../../core/ports/meeting-repository.port';

@Injectable()
export class RestoreTranscriptSegmentsUseCase {
  private readonly repository = inject(MeetingRepositoryPort);

  async restore(
    id: MeetingId,
    index: number,
    removeCount: number,
    segments: readonly TranscriptSegment[],
  ): Promise<Meeting> {
    return this.repository.restoreTranscriptSegments(id, index, removeCount, segments);
  }
}
