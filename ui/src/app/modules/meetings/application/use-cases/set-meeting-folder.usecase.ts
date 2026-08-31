import { Injectable, inject } from '@angular/core';

import type { FolderId } from '../../core/models/folder.model';
import type { Meeting, MeetingId } from '../../core/models/meeting.model';
import { MeetingRepositoryPort } from '../../core/ports/meeting-repository.port';

@Injectable()
export class SetMeetingFolderUseCase {
  private readonly repository = inject(MeetingRepositoryPort);

  async execute(id: MeetingId, folderId: FolderId | null): Promise<Meeting> {
    return this.repository.setFolder(id, folderId);
  }
}
