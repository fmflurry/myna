import { toFolderId } from '../../core/models/folder.model';
import type { Meeting } from '../../core/models/meeting.model';
import { toMeetingId } from '../../core/models/meeting.model';
import type { MeetingExportFormat } from '../../core/ports/meeting-repository.port';
import type { ExportFormatDto } from '../tauri/commands';
import type { MeetingDto } from '../dto/meeting.dto';
import { mapSummaryRefDtoToDomain } from './summary.mapper';
import { mapTranscriptDtoToDomain } from './transcript.mapper';

/** Maps a `MeetingDto` to the domain `Meeting`. */
export function mapMeetingDtoToDomain(dto: MeetingDto): Meeting {
  return {
    id: toMeetingId(dto.id),
    title: dto.title,
    createdAt: new Date(dto.createdAt),
    durationSec: dto.durationSec,
    // `exactOptionalPropertyTypes` forbids assigning `undefined` to an
    // optional key, so absent fields are omitted via conditional spread
    // rather than set to `undefined`.
    ...(dto.audioPath !== null ? { audioPath: dto.audioPath } : {}),
    ...(dto.transcript !== null ? { transcript: mapTranscriptDtoToDomain(dto.transcript) } : {}),
    summaries: dto.summaries.map(mapSummaryRefDtoToDomain),
    archived: dto.archived,
    hasAudio: dto.hasAudio,
    hasSystemTrack: dto.hasSystemTrack,
    droppedAudioChunks: dto.droppedAudioChunks,
    ...(dto.folderId !== null && dto.folderId !== undefined ? { folderId: toFolderId(dto.folderId) } : {}),
    ...(dto.speakerNames && Object.keys(dto.speakerNames).length > 0
      ? { speakerNames: dto.speakerNames }
      : {}),
  };
}

/**
 * Maps the domain `MeetingExportFormat` ('markdown' | 'json' | 'txt') to
 * the Rust `ExportFormat` wire value ('markdown' | 'json' | 'text'). The
 * only divergence is 'txt' vs 'text'.
 */
export function mapMeetingExportFormatToDto(format: MeetingExportFormat): ExportFormatDto {
  return format === 'txt' ? 'text' : format;
}
