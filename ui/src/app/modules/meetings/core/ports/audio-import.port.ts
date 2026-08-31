import type { Observable } from 'rxjs';

import type { Meeting, MeetingId } from '../models/meeting.model';

export type ImportPhase = 'converting' | 'transcribing' | 'done';

export interface ImportProgress {
  readonly meetingId: MeetingId;
  readonly phase: ImportPhase;
  readonly processedSec: number;
  readonly totalSec: number;
}

/**
 * Maps onto the frozen Rust commands import_audio, retranscribe_meeting,
 * cancel_import, diarize_meeting, plus the import://progress event.
 */
export abstract class AudioImportPort {
  abstract importFile(path: string, title?: string): Promise<Meeting>;
  abstract retranscribe(id: MeetingId, path?: string): Promise<Meeting>;
  abstract cancel(): Promise<void>;
  /** User-triggered speaker detection over an already-recorded meeting's system-audio track; see `diarize_meeting`. */
  abstract diarize(id: MeetingId): Promise<Meeting>;
  abstract progress(): Observable<ImportProgress>;
  abstract errors(): Observable<{ readonly code: string; readonly message: string }>;
}
