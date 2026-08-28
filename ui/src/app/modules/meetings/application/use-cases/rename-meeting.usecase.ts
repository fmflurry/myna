import { Injectable, inject } from '@angular/core';

import type { Meeting, MeetingId } from '../../core/models/meeting.model';
import { MeetingRepositoryPort } from '../../core/ports/meeting-repository.port';

@Injectable()
export class RenameMeetingUseCase {
  private readonly repository = inject(MeetingRepositoryPort);

  async rename(id: MeetingId, title: string): Promise<Meeting> {
    return this.repository.rename(id, title);
  }
}
