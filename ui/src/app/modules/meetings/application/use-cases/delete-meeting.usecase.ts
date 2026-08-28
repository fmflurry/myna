import { Injectable, inject } from '@angular/core';

import type { MeetingId } from '../../core/models/meeting.model';
import { MeetingRepositoryPort } from '../../core/ports/meeting-repository.port';

@Injectable()
export class DeleteMeetingUseCase {
  private readonly repository = inject(MeetingRepositoryPort);

  async delete(id: MeetingId): Promise<void> {
    return this.repository.delete(id);
  }
}
