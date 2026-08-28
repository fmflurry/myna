import { emptyTranscript, withSegment } from '../../core/models/transcript.model';
import type { Transcript, TranscriptSegment } from '../../core/models/transcript.model';
import type { RawTranscriptSegmentDto, TranscriptDto, TranscriptSegmentDto } from '../dto/transcript.dto';

/** Maps the camelCase `TranscriptSegmentDto` (from `TranscriptDto`) to the domain model. */
export function mapTranscriptSegmentDtoToDomain(dto: TranscriptSegmentDto): TranscriptSegment {
  return {
    startSec: dto.startSec,
    endSec: dto.endSec,
    text: dto.text,
  };
}

/**
 * Maps the snake_case `myna_stt::TranscriptSegment` shape, unique to the
 * `transcript://final` event payload, to the domain model.
 */
export function mapRawTranscriptSegmentDtoToDomain(dto: RawTranscriptSegmentDto): TranscriptSegment {
  return {
    startSec: dto.start_sec,
    endSec: dto.end_sec,
    text: dto.text,
  };
}

/** Maps a full `TranscriptDto` to the domain `Transcript`. */
export function mapTranscriptDtoToDomain(dto: TranscriptDto): Transcript {
  return dto.segments.reduce(
    (transcript, segment) => withSegment(transcript, mapTranscriptSegmentDtoToDomain(segment)),
    emptyTranscript(),
  );
}
