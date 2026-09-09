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
  /**
   * Corrects the text of a live (still-recording) journal segment — the
   * port half of the Rust `edit_live_transcript_segment` command. The
   * backend preserves the segment's timing/speaker triple (so live-event
   * vs journal dedupe still holds), stamps `edited`, keeps the first
   * `originalText`, and clears `suspectReasons`. Resolves with the patched
   * live transcript; rejects when `id` is not the active recording or
   * `index` is out of range.
   */
  abstract editLiveSegment(id: MeetingId, index: number, text: string): Promise<Transcript>;
}
