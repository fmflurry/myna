import { Injectable, inject } from '@angular/core';

import type { MeetingId } from '../../core/models/meeting.model';
import {
  MeetingRepositoryPort,
  type MeetingExportFormat,
} from '../../core/ports/meeting-repository.port';

@Injectable()
export class ExportMeetingUseCase {
  private readonly meetings = inject(MeetingRepositoryPort);

  async export(id: MeetingId, format: MeetingExportFormat, dest: string): Promise<void> {
    await this.meetings.export(id, format, dest);
  }
}
