import type { Router } from '@angular/router';

import { MeetingsFacade } from '../../../application/facades/meetings.facade';
import type { SystemAudioStatus } from '../../../core/models/capture-source.model';
import type { FolderId } from '../../../core/models/folder.model';
import type { Meeting, MeetingId } from '../../../core/models/meeting.model';
import type { MeetingDragMoveRequest } from '../../components/meeting-sidebar/meeting-sidebar.component';

/**
 * Shown to the capture-source-picker before `checkSystemAudio()` has
 * resolved. `unknown`, not `unavailable` — there is no preflight API for
 * the audio permission, so the system/mixed options must stay selectable
 * even during this brief window, not just once the check settles.
 */
export const CHECKING_SYSTEM_AUDIO: SystemAudioStatus = { kind: 'unknown' };

const ISO_DATE_LENGTH = 10;

/** `"<title> - <YYYY-MM-DD>"` — the suggested file name the export dialog offers. */
export const buildExportFilename = (meeting: Meeting): string =>
  `${meeting.title} - ${meeting.createdAt.toISOString().slice(0, ISO_DATE_LENGTH)}`;

/** The meeting's CURRENT folder (or `null`), looked up from `meetings` — used to preserve filing when archiving. */
function currentFolderId(meetings: readonly Meeting[], id: MeetingId): FolderId | null {
  return meetings.find((meeting) => meeting.id === id)?.folderId ?? null;
}

/**
 * Drag-and-drop is the only way to move or archive a meeting — this is the
 * sole handler for both; it routes by the drop target's `kind`, always via
 * `facade.placeMeeting` with `previousId`/`nextId` both `null` (the backend
 * resolves that to `Placement::Keep` — container change only, matching
 * today's behaviour but as one write instead of two). Archiving preserves
 * the meeting's CURRENT folder — looked up from `meetings` — so a meeting
 * dragged to the archive never loses its filing.
 */
export function runMeetingMoveRequested(facade: MeetingsFacade, meetings: readonly Meeting[], request: MeetingDragMoveRequest): void {
  const { target } = request;
  if (target.kind === 'placement') {
    const { container, previousId, nextId } = target;
    if (container.kind === 'archive') {
      void facade.placeMeeting(request.id, currentFolderId(meetings, request.id), true, previousId, nextId);
      return;
    }
    const folderId = container.kind === 'folder' ? container.folderId : null;
    void facade.placeMeeting(request.id, folderId, false, previousId, nextId);
    return;
  }
  if (target.kind === 'archive') {
    void facade.placeMeeting(request.id, currentFolderId(meetings, request.id), true, null, null);
    return;
  }
  const folderId = target.kind === 'folder' ? target.folderId : null;
  void facade.placeMeeting(request.id, folderId, false, null, null);
}

/**
 * There is no finished recording session on disk to stop first —
 * `cancelRecording()` stops the session and wipes the meeting dir, including
 * audio.wav, instead of `deleteMeeting()`.
 */
export function runMeetingDeleted(facade: MeetingsFacade, router: Router, id: MeetingId): void {
  if (facade.busy() && facade.selectedMeeting()?.id === id) {
    void facade.cancelRecording().then(() => router.navigate(['/meetings']));
    return;
  }
  void facade.deleteMeeting(id).then(() => {
    if (facade.selectedMeeting() === undefined) {
      void router.navigate(['/meetings']);
    }
  });
}
