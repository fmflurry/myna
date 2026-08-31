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
}
