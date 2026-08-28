import type { Meeting, MeetingId } from '../models/meeting.model';

export type MeetingExportFormat = 'markdown' | 'json' | 'txt';

/**
 * Maps onto the frozen Rust commands list_meetings, get_meeting,
 * delete_meeting, rename_meeting and export_meeting.
 */
export abstract class MeetingRepositoryPort {
  abstract list(): Promise<readonly Meeting[]>;
  abstract get(id: MeetingId): Promise<Meeting>;
  abstract delete(id: MeetingId): Promise<void>;
  abstract rename(id: MeetingId, title: string): Promise<Meeting>;
  abstract export(id: MeetingId, format: MeetingExportFormat, dest: string): Promise<void>;
}
