import { Injectable } from '@angular/core';

import type { Meeting, MeetingId } from '../../core/models/meeting.model';
import { MeetingRepositoryPort } from '../../core/ports/meeting-repository.port';
import type { MeetingExportFormat } from '../../core/ports/meeting-repository.port';
import { mapMeetingDtoToDomain, mapMeetingExportFormatToDto } from '../mappers/meeting.mapper';
import { invokeCommand } from './ipc';

/** `MeetingRepositoryPort` implementation backed by the Tauri IPC command surface. */
@Injectable()
export class TauriMeetingRepositoryAdapter extends MeetingRepositoryPort {
  override async list(): Promise<readonly Meeting[]> {
    const dtos = await invokeCommand('list_meetings', {});
    return dtos.map(mapMeetingDtoToDomain);
  }

  override async get(id: MeetingId): Promise<Meeting> {
    const dto = await invokeCommand('get_meeting', { id });
    return mapMeetingDtoToDomain(dto);
  }

  override async delete(id: MeetingId): Promise<void> {
    await invokeCommand('delete_meeting', { id });
  }

  override async rename(id: MeetingId, title: string): Promise<Meeting> {
    const dto = await invokeCommand('rename_meeting', { meetingId: id, title });
    return mapMeetingDtoToDomain(dto);
  }

  override async export(id: MeetingId, format: MeetingExportFormat, dest: string): Promise<void> {
    await invokeCommand('export_meeting', {
      meetingId: id,
      format: mapMeetingExportFormatToDto(format),
      dest,
    });
  }
}
