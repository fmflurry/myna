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
 * cancel_import, plus the import://progress event.
 */
export abstract class AudioImportPort {
  abstract importFile(path: string, title?: string): Promise<Meeting>;
  abstract retranscribe(id: MeetingId, path?: string): Promise<Meeting>;
  abstract cancel(): Promise<void>;
  abstract progress(): Observable<ImportProgress>;
}
