import { Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { map } from 'rxjs';

import { emptyTranscript } from '../../core/models/transcript.model';
import type { Transcript } from '../../core/models/transcript.model';
import { toMeetingId } from '../../core/models/meeting.model';
import type { MeetingId } from '../../core/models/meeting.model';
import { TranscriberPort } from '../../core/ports/transcriber.port';
import type { TranscriptFinal, TranscriptPartial } from '../../core/ports/transcriber.port';
import { mapRawTranscriptSegmentDtoToDomain, mapTranscriptDtoToDomain } from '../mappers/transcript.mapper';
import { invokeCommand, onEvent } from './ipc';

/** `TranscriberPort` implementation backed by the Tauri IPC command surface. */
@Injectable()
export class TauriTranscriberAdapter extends TranscriberPort {
  override partials(): Observable<TranscriptPartial> {
    return onEvent('transcript://partial').pipe(
      map((dto) => ({ meetingId: toMeetingId(dto.meetingId), text: dto.text, speaker: dto.speaker })),
    );
  }

  override finals(): Observable<TranscriptFinal> {
    return onEvent('transcript://final').pipe(
      map((dto) => ({
        meetingId: toMeetingId(dto.meetingId),
        segment: mapRawTranscriptSegmentDtoToDomain(dto.segment),
      })),
    );
  }

  override async transcriptFor(id: MeetingId): Promise<Transcript> {
    const dto = await invokeCommand('get_transcript', { id });
    return dto === null ? emptyTranscript() : mapTranscriptDtoToDomain(dto);
  }

  override async liveTranscriptFor(id: MeetingId): Promise<Transcript> {
    // Tauri maps the Rust command's snake_case `meeting_id` param to the
    // camelCase `meetingId` invoke arg. `null` means `id` is not the active
    // recording — an empty transcript, never an error, so a mid-meeting
    // reload of a finished/other meeting degrades to "nothing live".
    const dto = await invokeCommand('get_live_transcript', { meetingId: id });
    return dto === null ? emptyTranscript() : mapTranscriptDtoToDomain(dto);
  }
}
