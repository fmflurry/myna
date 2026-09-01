import type { MeetingId } from '../models/meeting.model';

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
}
