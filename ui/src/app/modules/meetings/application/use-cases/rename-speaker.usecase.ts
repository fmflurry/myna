import { Injectable, inject } from '@angular/core';

import type { Meeting, MeetingId } from '../../core/models/meeting.model';
import { MeetingRepositoryPort } from '../../core/ports/meeting-repository.port';

@Injectable()
export class RenameSpeakerUseCase {
  private readonly repository = inject(MeetingRepositoryPort);

  async rename(id: MeetingId, label: string, name: string): Promise<Meeting> {
    return this.repository.renameSpeaker(id, label, name);
  }
}
