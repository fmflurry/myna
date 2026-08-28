import type { ImportProgress } from '../../core/ports/audio-import.port';
import { toMeetingId } from '../../core/models/meeting.model';
import type { ImportProgressPayloadDto } from '../dto/import.dto';

/** Maps an `ImportProgressPayloadDto` to the domain `ImportProgress`. */
export function mapImportProgressDtoToDomain(dto: ImportProgressPayloadDto): ImportProgress {
  return {
    meetingId: toMeetingId(dto.meetingId),
    phase: dto.phase,
    processedSec: dto.processedSec,
    totalSec: dto.totalSec,
  };
}
