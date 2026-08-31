import type { FolderId } from '../models/folder.model';
import type { Meeting, MeetingId } from '../models/meeting.model';
import type { TranscriptSegment } from '../models/transcript.model';

export type MeetingExportFormat = 'markdown' | 'json' | 'txt';

/**
 * Maps onto the frozen Rust commands list_meetings, get_meeting,
 * delete_meeting, rename_meeting, set_meeting_archived, set_meeting_folder,
 * set_meeting_placement, edit_transcript_segment and export_meeting.
 */
export abstract class MeetingRepositoryPort {
  abstract list(): Promise<readonly Meeting[]>;
  abstract get(id: MeetingId): Promise<Meeting>;
  abstract delete(id: MeetingId): Promise<void>;
  abstract rename(id: MeetingId, title: string): Promise<Meeting>;
  abstract setArchived(id: MeetingId, archived: boolean): Promise<Meeting>;
  abstract setFolder(id: MeetingId, folderId: FolderId | null): Promise<Meeting>;
  /**
   * Single-write container + ordering placement, backed by
   * `set_meeting_placement`. `previousId`/`nextId` name the desired
   * neighbours in the backend's ordering; passing `null` for both resolves
   * to `Placement::Keep` on the backend (container change only, no reorder).
   */
  abstract place(
    id: MeetingId,
    folderId: FolderId | null,
    archived: boolean,
    previousId: MeetingId | null,
    nextId: MeetingId | null,
  ): Promise<Meeting>;
  abstract editTranscriptSegment(id: MeetingId, index: number, text: string): Promise<Meeting>;
  /** Sets the display name for a speaker label; an empty `name` clears the entry. */
  abstract renameSpeaker(id: MeetingId, label: string, name: string): Promise<Meeting>;
  /**
   * Drops the display-name entry for `label` and collapses every segment
   * attributed to it to bare `'others'`, mirroring the Rust `remove_speaker`
   * command.
   */
  abstract removeSpeaker(id: MeetingId, label: string): Promise<Meeting>;
  abstract setSegmentSpeaker(id: MeetingId, index: number, speaker: string): Promise<Meeting>;
  /** Deletes the transcript segment at `index`, guarded by `expectedText` (stale-write protection). */
  abstract deleteTranscriptSegment(id: MeetingId, index: number, expectedText: string): Promise<Meeting>;
  /** Merges the transcript segment at `index` into the one immediately above it, guarded by `expectedText`. */
  abstract mergeTranscriptSegmentUp(id: MeetingId, index: number, expectedText: string): Promise<Meeting>;
  /** Inverse of a structural mutation: splices `segments` into the transcript at `index`, replacing `removeCount` existing segments. */
  abstract restoreTranscriptSegments(
    id: MeetingId,
    index: number,
    removeCount: number,
    segments: readonly TranscriptSegment[],
  ): Promise<Meeting>;
  abstract export(id: MeetingId, format: MeetingExportFormat, dest: string): Promise<void>;
}
