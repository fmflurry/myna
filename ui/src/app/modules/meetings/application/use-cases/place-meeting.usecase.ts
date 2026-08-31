import { Injectable, inject } from '@angular/core';

import type { FolderId } from '../../core/models/folder.model';
import type { Meeting, MeetingId } from '../../core/models/meeting.model';
import { MeetingRepositoryPort } from '../../core/ports/meeting-repository.port';

@Injectable()
export class PlaceMeetingUseCase {
  private readonly repository = inject(MeetingRepositoryPort);

  async execute(
    id: MeetingId,
    folderId: FolderId | null,
    archived: boolean,
    previousId: MeetingId | null,
    nextId: MeetingId | null,
  ): Promise<Meeting> {
    return this.repository.place(id, folderId, archived, previousId, nextId);
  }
}
