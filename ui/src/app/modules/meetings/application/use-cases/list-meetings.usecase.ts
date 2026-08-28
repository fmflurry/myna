import { Injectable, inject } from '@angular/core';

import type { Meeting } from '../../core/models/meeting.model';
import { MeetingRepositoryPort } from '../../core/ports/meeting-repository.port';

@Injectable()
export class ListMeetingsUseCase {
  private readonly repository = inject(MeetingRepositoryPort);

  async list(): Promise<readonly Meeting[]> {
    return this.repository.list();
  }
}
