import { TestBed } from '@angular/core/testing';

import type { Folder } from '../../../core/models/folder.model';
import { toFolderId } from '../../../core/models/folder.model';
import type { Meeting } from '../../../core/models/meeting.model';
import { toMeetingId } from '../../../core/models/meeting.model';
import { MeetingSidebarComponent } from './meeting-sidebar.component';

/**
 * RED spec for Phase 4 — where a meeting renders inside `MeetingSidebarComponent`,
 * driven purely by its `folderId` field (no interaction with the "Move to…"
 * picker here — that's `meeting-list-item.move.spec.ts` and the shell-level
 * wiring in `meetings-shell.page.move.spec.ts`). Two invariants under test
 * are NOT yet true of the current implementation:
 *
 * - A meeting whose `folderId` names no folder in `folders()` currently
 *   vanishes (filtered out of BOTH `uncategorizedMeetings` — which requires
 *   `folderId === undefined` — and every folder's `meetingsInFolder`, since
 *   no folder id matches). It must instead render under Uncategorized; the
 *   backend deliberately never validates `folderId` (see `delete_folder`),
 *   so this dangling-id case is a real, expected state.
 * - Archive and folder assignment are orthogonal: an archived meeting must
 *   never surface inside its folder's disclosure.
 */
describe('MeetingSidebarComponent — folder assignment rendering', () => {
  const folderA: Folder = { id: toFolderId('fA'), name: 'Clients', createdAt: new Date(2026, 7, 1), position: 0 };

  const baseMeeting = (id: string, title: string, overrides: Partial<Meeting> = {}): Meeting => ({
    id: toMeetingId(id),
    title,
    createdAt: new Date(2026, 7, 27),
    durationSec: 60,
    summaries: [],
    archived: false,
    hasAudio: false,
    hasSystemTrack: false,
    droppedAudioChunks: 0,
    ...overrides,
  });

  const createFixture = (meetings: readonly Meeting[], folders: readonly Folder[] = [folderA]) => {
    const fixture = TestBed.createComponent(MeetingSidebarComponent);
    fixture.componentRef.setInput('meetings', meetings);
    fixture.componentRef.setInput('folders', folders);
    fixture.componentRef.setInput('expandedFolders', new Set([folderA.id]));
    fixture.detectChanges();
    return fixture;
  };

  const titlesIn = (root: HTMLElement, containerSelector: string): (string | undefined)[] =>
    Array.from(root.querySelectorAll(`${containerSelector} app-meeting-list-item .title`)).map(
      (node) => node.textContent?.trim(),
    );

  it('a meeting moved to a folder leaves the uncategorized list and appears in that folder section', () => {
    // Arrange / Act — unfiled first.
    const unfiled = createFixture([baseMeeting('m1', 'Standup')]);

    // Assert
    expect(titlesIn(unfiled.nativeElement, '.list[aria-label="Meetings"]')).toEqual(['Standup']);
    expect(titlesIn(unfiled.nativeElement, 'app-folder-section')).toEqual([]);

    // Act — the same meeting, now filed under folderA.
    const filed = createFixture([baseMeeting('m1', 'Standup', { folderId: folderA.id })]);

    // Assert
    expect(titlesIn(filed.nativeElement, '.list[aria-label="Meetings"]')).toEqual([]);
    expect(titlesIn(filed.nativeElement, 'app-folder-section')).toEqual(['Standup']);
  });

  it('a meeting whose folderId names no existing folder renders under Uncategorized', () => {
    // Arrange / Act
    const fixture = createFixture([baseMeeting('m1', 'Orphaned', { folderId: toFolderId('ghost-folder') })]);

    // Assert
    expect(titlesIn(fixture.nativeElement, '.list[aria-label="Meetings"]')).toEqual(['Orphaned']);
    expect(titlesIn(fixture.nativeElement, 'app-folder-section')).toEqual([]);
  });

  it('an archived meeting stays in the Archive section regardless of its folderId', () => {
    // Arrange / Act
    const fixture = createFixture([baseMeeting('m1', 'Old client call', { folderId: folderA.id, archived: true })]);

    // Assert — never in Uncategorized, never in its folder's section; counted in the Archive toggle.
    expect(titlesIn(fixture.nativeElement, '.list[aria-label="Meetings"]')).toEqual([]);
    expect(titlesIn(fixture.nativeElement, 'app-folder-section')).toEqual([]);
    const archiveToggle: HTMLElement = fixture.nativeElement.querySelector('.archive-toggle');
    expect(archiveToggle.textContent).toContain('Archive (1)');
  });
});
