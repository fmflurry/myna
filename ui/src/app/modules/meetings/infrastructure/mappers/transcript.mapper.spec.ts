import {
  mapRawTranscriptSegmentDtoToDomain,
  mapTranscriptDtoToDomain,
  mapTranscriptSegmentDtoToDomain,
} from './transcript.mapper';

describe('mapTranscriptSegmentDtoToDomain', () => {
  it('maps the camelCase DTO fields to the domain shape', () => {
    const segment = mapTranscriptSegmentDtoToDomain({ startSec: 1.5, endSec: 3.25, text: 'hello', speaker: 'me' });

    expect(segment).toEqual({ startSec: 1.5, endSec: 3.25, text: 'hello', speaker: 'me' });
  });

  it('defaults a missing speaker field to "unknown"', () => {
    const segment = mapTranscriptSegmentDtoToDomain({ startSec: 1.5, endSec: 3.25, text: 'hello' });

    expect(segment).toEqual({ startSec: 1.5, endSec: 3.25, text: 'hello', speaker: 'unknown' });
  });
});

describe('mapRawTranscriptSegmentDtoToDomain', () => {
  it('maps the snake_case myna_stt::TranscriptSegment fields to the domain shape', () => {
    const segment = mapRawTranscriptSegmentDtoToDomain({ start_sec: 2, end_sec: 4, text: 'world', speaker: 'others' });

    expect(segment).toEqual({ startSec: 2, endSec: 4, text: 'world', speaker: 'others' });
  });

  it('defaults a missing speaker field to "unknown"', () => {
    const segment = mapRawTranscriptSegmentDtoToDomain({ start_sec: 2, end_sec: 4, text: 'world' });

    expect(segment).toEqual({ startSec: 2, endSec: 4, text: 'world', speaker: 'unknown' });
  });
});

describe('mapTranscriptDtoToDomain', () => {
  it('maps an empty segments array to an empty transcript', () => {
    expect(mapTranscriptDtoToDomain({ segments: [] })).toEqual({ segments: [] });
  });

  it('maps every segment in order', () => {
    const dto = {
      segments: [
        { startSec: 0, endSec: 1, text: 'first', speaker: 'me' },
        { startSec: 1, endSec: 2, text: 'second', speaker: 'others' },
      ],
    };

    expect(mapTranscriptDtoToDomain(dto)).toEqual({
      segments: [
        { startSec: 0, endSec: 1, text: 'first', speaker: 'me' },
        { startSec: 1, endSec: 2, text: 'second', speaker: 'others' },
      ],
    });
  });
});
