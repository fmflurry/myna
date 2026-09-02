import type { Observable } from 'rxjs';

import type { MeetingId } from '../models/meeting.model';
import type { Speaker, Transcript, TranscriptSegment } from '../models/transcript.model';

export interface TranscriptPartial {
  readonly meetingId: MeetingId;
  readonly text: string;
  readonly speaker: Speaker;
}

export interface TranscriptFinal {
  readonly meetingId: MeetingId;
  readonly segment: TranscriptSegment;
}

/**
 * Maps onto the frozen Rust command get_transcript, plus the
 * transcript://partial and transcript://final events.
 */
export abstract class TranscriberPort {
  abstract partials(): Observable<TranscriptPartial>;
  abstract finals(): Observable<TranscriptFinal>;
  abstract transcriptFor(id: MeetingId): Promise<Transcript>;
  /**
   * The transcript finalized SO FAR for a recording still in progress,
   * read from the backend's durability journal — the query half of the
   * session-resilience contract (ADR 0011). A webview reload mid-meeting
   * rebuilds the visible transcript with this instead of relying on having
   * been subscribed to every `transcript://final` event. Resolves to an
   * empty transcript when `id` is not the active recording.
   */
  abstract liveTranscriptFor(id: MeetingId): Promise<Transcript>;
}
