import { Injectable, inject } from '@angular/core';

import type { Meeting, MeetingId } from '../../core/models/meeting.model';
import { MeetingRepositoryPort } from '../../core/ports/meeting-repository.port';

@Injectable()
export class SetMeetingArchivedUseCase {
  private readonly repository = inject(MeetingRepositoryPort);

  async set(id: MeetingId, archived: boolean): Promise<Meeting> {
    return this.repository.setArchived(id, archived);
  }
}
