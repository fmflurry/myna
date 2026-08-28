import { Injectable, inject } from '@angular/core';

import type { Meeting, MeetingId } from '../../core/models/meeting.model';
import { MeetingRepositoryPort } from '../../core/ports/meeting-repository.port';

@Injectable()
export class OpenMeetingUseCase {
  private readonly repository = inject(MeetingRepositoryPort);

  async open(id: MeetingId): Promise<Meeting> {
    return this.repository.get(id);
  }
}
