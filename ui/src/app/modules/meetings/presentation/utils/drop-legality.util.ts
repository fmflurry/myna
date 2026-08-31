import type { FolderId } from '../../core/models/folder.model';
import type { Meeting } from '../../core/models/meeting.model';

/** False when `meeting` is already in `folderId` and not archived — archived meetings are always droppable into a folder. */
export function isLegalFolderTarget(meeting: Meeting, folderId: FolderId): boolean {
  return meeting.archived || meeting.folderId !== folderId;
}

/** False when `meeting` already has no folder and is not archived. */
export function isLegalUncategorizedTarget(meeting: Meeting, knownFolderIds: ReadonlySet<FolderId>): boolean {
  const hasNoFolder = meeting.folderId === undefined || !knownFolderIds.has(meeting.folderId);
  return meeting.archived || !hasNoFolder;
}

/** False when `meeting` is already archived. */
export function isLegalArchiveTarget(meeting: Meeting): boolean {
  return !meeting.archived;
}
