import { Injectable, inject } from '@angular/core';

import type { Meeting, MeetingId } from '../../core/models/meeting.model';
import { MeetingRepositoryPort } from '../../core/ports/meeting-repository.port';

@Injectable()
export class RemoveSpeakerUseCase {
  private readonly repository = inject(MeetingRepositoryPort);

  async remove(id: MeetingId, label: string): Promise<Meeting> {
    return this.repository.removeSpeaker(id, label);
  }
}
