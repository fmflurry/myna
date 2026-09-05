import type { MeetingId } from '../models/meeting.model';

/**
 * One playable segment of a meeting's audio, positioned on the meeting's
 * GLOBAL timeline. Legacy single-file meetings resolve to exactly one chunk;
 * segmented recordings (SegmentedWavRecorder) produce `audio.wav`,
 * `audio.part-0002.wav`, ... in backend order.
 */
export interface AudioChunk {
  /** Asset-converted URL, ready for an `<audio src="...">` element. */
  readonly url: string;
  /** Offset of this chunk on the global timeline, in seconds. */
  readonly startSec: number;
  /** Chunk length in seconds; 0 when the backend does not know it. */
  readonly durationSec: number;
}

/**
 * Port for resolving a meeting's audio file URL for playback.
 * Implementations convert a backend filesystem path to a playable URL.
 */
export abstract class AudioRepositoryPort {
  /**
   * Returns a playable URL for the meeting's audio.wav file, or null if none exists.
   * The URL must be suitable for use in an `<audio src="...">` element.
   */
  abstract getAudioUrl(meetingId: MeetingId): Promise<string | null>;

  /**
   * Returns the meeting's ordered playable chunks for seamless multipart
   * playback: every path asset-converted, backend order preserved, an empty
   * array when the meeting has no audio. Rejects with a typed `MeetingsError`
   * on backend failure.
   */
  abstract getAudioChunks(meetingId: MeetingId): Promise<readonly AudioChunk[]>;
}
