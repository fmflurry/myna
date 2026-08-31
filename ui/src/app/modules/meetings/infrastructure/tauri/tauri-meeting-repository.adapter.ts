import { Injectable } from '@angular/core';

import type { FolderId } from '../../core/models/folder.model';
import type { Meeting, MeetingId } from '../../core/models/meeting.model';
import type { TranscriptSegment } from '../../core/models/transcript.model';
import { MeetingRepositoryPort } from '../../core/ports/meeting-repository.port';
import type { MeetingExportFormat } from '../../core/ports/meeting-repository.port';
import type { TranscriptSegmentWireDto } from '../dto/transcript.dto';
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

  override async setArchived(id: MeetingId, archived: boolean): Promise<Meeting> {
    const dto = await invokeCommand('set_meeting_archived', { meetingId: id, archived });
    return mapMeetingDtoToDomain(dto);
  }

  override async setFolder(id: MeetingId, folderId: FolderId | null): Promise<Meeting> {
    const dto = await invokeCommand('set_meeting_folder', { meetingId: id, folderId });
    return mapMeetingDtoToDomain(dto);
  }

  override async place(
    id: MeetingId,
    folderId: FolderId | null,
    archived: boolean,
    previousId: MeetingId | null,
    nextId: MeetingId | null,
  ): Promise<Meeting> {
    const dto = await invokeCommand('set_meeting_placement', {
      meetingId: id,
      folderId,
      archived,
      previousId,
      nextId,
    });
    return mapMeetingDtoToDomain(dto);
  }

  override async editTranscriptSegment(id: MeetingId, index: number, text: string): Promise<Meeting> {
    const dto = await invokeCommand('edit_transcript_segment', {
      meetingId: id,
      segmentIndex: index,
      text,
    });
    return mapMeetingDtoToDomain(dto);
  }

  override async renameSpeaker(id: MeetingId, label: string, name: string): Promise<Meeting> {
    const dto = await invokeCommand('rename_speaker', { meetingId: id, label, name });
    return mapMeetingDtoToDomain(dto);
  }

  override async removeSpeaker(id: MeetingId, label: string): Promise<Meeting> {
    const dto = await invokeCommand('remove_speaker', { meetingId: id, label });
    return mapMeetingDtoToDomain(dto);
  }

  override async setSegmentSpeaker(id: MeetingId, index: number, speaker: string): Promise<Meeting> {
    const dto = await invokeCommand('set_segment_speaker', {
      meetingId: id,
      segmentIndex: index,
      speaker,
    });
    return mapMeetingDtoToDomain(dto);
  }

  override async deleteTranscriptSegment(
    id: MeetingId,
    index: number,
    expectedText: string,
  ): Promise<Meeting> {
    const dto = await invokeCommand('delete_transcript_segment', {
      meetingId: id,
      segmentIndex: index,
      expectedText,
    });
    return mapMeetingDtoToDomain(dto);
  }

  override async mergeTranscriptSegmentUp(
    id: MeetingId,
    index: number,
    expectedText: string,
  ): Promise<Meeting> {
    const dto = await invokeCommand('merge_transcript_segment_up', {
      meetingId: id,
      segmentIndex: index,
      expectedText,
    });
    return mapMeetingDtoToDomain(dto);
  }

  override async restoreTranscriptSegments(
    id: MeetingId,
    index: number,
    removeCount: number,
    segments: readonly TranscriptSegment[],
  ): Promise<Meeting> {
    const wireSegments: readonly TranscriptSegmentWireDto[] = segments.map((segment) => ({
      startSec: segment.startSec,
      endSec: segment.endSec,
      text: segment.text,
      speaker: segment.speaker,
      speakerPinned: segment.speakerPinned ?? false,
    }));
    const dto = await invokeCommand('restore_transcript_segments', {
      meetingId: id,
      segmentIndex: index,
      removeCount,
      segments: wireSegments,
    });
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
