import { Injectable, inject } from '@angular/core';

import type { Meeting, MeetingId } from '../../core/models/meeting.model';
import { MeetingRepositoryPort } from '../../core/ports/meeting-repository.port';

@Injectable()
export class SetSegmentSpeakerUseCase {
  private readonly repository = inject(MeetingRepositoryPort);

  async set(id: MeetingId, index: number, speaker: string): Promise<Meeting> {
    return this.repository.setSegmentSpeaker(id, index, speaker);
  }
}
