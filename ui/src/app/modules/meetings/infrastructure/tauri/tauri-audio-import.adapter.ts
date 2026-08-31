import { Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { map } from 'rxjs';

import type { Meeting, MeetingId } from '../../core/models/meeting.model';
import { AudioImportPort, type ImportProgress } from '../../core/ports/audio-import.port';
import { mapMeetingDtoToDomain } from '../mappers/meeting.mapper';
import { mapImportProgressDtoToDomain } from '../mappers/import.mapper';
import { invokeCommand, onEvent } from './ipc';

/** `AudioImportPort` implementation backed by the Tauri IPC command surface. */
@Injectable()
export class TauriAudioImportAdapter extends AudioImportPort {
  override async importFile(path: string, title?: string): Promise<Meeting> {
    const dto = await invokeCommand('import_audio', { path, ...(title !== undefined ? { title } : {}) });
    return mapMeetingDtoToDomain(dto);
  }

  override async retranscribe(id: MeetingId, path?: string): Promise<Meeting> {
    const dto = await invokeCommand('retranscribe_meeting', {
      meetingId: id,
      ...(path !== undefined ? { path } : {}),
    });
    return mapMeetingDtoToDomain(dto);
  }

  override async cancel(): Promise<void> {
    await invokeCommand('cancel_import', {});
  }

  override async diarize(id: MeetingId): Promise<Meeting> {
    const dto = await invokeCommand('diarize_meeting', { meetingId: id });
    return mapMeetingDtoToDomain(dto);
  }

  override progress(): Observable<ImportProgress> {
    return onEvent('import://progress').pipe(map(mapImportProgressDtoToDomain));
  }

  override errors(): Observable<{ readonly code: string; readonly message: string }> {
    return onEvent('error://occurred');
  }
}
