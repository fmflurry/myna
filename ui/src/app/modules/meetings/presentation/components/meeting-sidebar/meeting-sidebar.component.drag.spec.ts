import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';

import type { Folder, FolderId } from '../../../core/models/folder.model';
import { toFolderId } from '../../../core/models/folder.model';
import type { Meeting } from '../../../core/models/meeting.model';
import { toMeetingId } from '../../../core/models/meeting.model';
import type { MeetingDragMoveRequest } from './meeting-sidebar.component';
import { MeetingSidebarComponent } from './meeting-sidebar.component';

/**
 * RED spec for the drag-and-drop coordinator on `MeetingSidebarComponent`:
 * a private `draggingMeetingId` signal (never `DataTransfer` — jsdom 25.0.1
 * has neither `DragEvent` nor `DataTransfer`), legality gating per drop
 * target (`canDropInFolder` / `canDropInUncategorized` / `canDropInArchive`),
 * and a new `meetingMoveRequested` output carrying `MeetingDragMoveRequest`.
 *
 * Every drag/drop is simulated with a bare
 * `new Event(type, { bubbles, cancelable })` — Angular's drag bindings are
 * plain `addEventListener` calls, so a synthetic `Event` reaches them
 * regardless of its real subtype (same technique already used in
 * `meeting-sidebar.component.spec.ts` / `.folders.spec.ts` for `input`
 * events).
 */
describe('MeetingSidebarComponent — drag and drop', () => {
  const folderA: Folder = { id: toFolderId('fA'), name: 'Clients', createdAt: new Date(2026, 7, 1), position: 0 };
  const folderB: Folder = { id: toFolderId('fB'), name: 'Internal', createdAt: new Date(2026, 7, 2), position: 1 };

  const baseMeeting = (
    id: string,
    overrides: { folderId?: FolderId; archived?: boolean } = {},
  ): Meeting => ({
    id: toMeetingId(id),
    title: id,
    createdAt: new Date(2026, 7, 27),
    durationSec: 60,
    summaries: [],
    archived: overrides.archived ?? false,
    hasAudio: false,
    hasSystemTrack: false,
    droppedAudioChunks: 0,
    ...(overrides.folderId ? { folderId: overrides.folderId } : {}),
  });

  const defaultMeetings: readonly Meeting[] = [
    baseMeeting('m-uncat'),
    baseMeeting('m-a', { folderId: folderA.id }),
    baseMeeting('m-b', { folderId: folderB.id }),
    baseMeeting('m-archived', { archived: true }),
  ];

  const createFixture = (
    overrides: { meetings?: readonly Meeting[]; folders?: readonly Folder[] } = {},
  ) => {
    const fixture = TestBed.createComponent(MeetingSidebarComponent);
    fixture.componentRef.setInput('meetings', overrides.meetings ?? defaultMeetings);
    fixture.componentRef.setInput('folders', overrides.folders ?? [folderA, folderB]);
    fixture.detectChanges();
    return fixture;
  };

  const dragEvent = (type: string): Event => new Event(type, { bubbles: true, cancelable: true });

  const startDrag = (fixture: ComponentFixture<MeetingSidebarComponent>, row: HTMLElement): void => {
    row.dispatchEvent(dragEvent('dragstart'));
    fixture.detectChanges();
  };

  const dropOn = (fixture: ComponentFixture<MeetingSidebarComponent>, target: HTMLElement): void => {
    target.dispatchEvent(dragEvent('dragover'));
    fixture.detectChanges();
    target.dispatchEvent(dragEvent('drop'));
    fixture.detectChanges();
  };

  const folderSectionByName = (
    fixture: ComponentFixture<MeetingSidebarComponent>,
    name: string,
  ): HTMLElement => {
    const sections = Array.from(fixture.nativeElement.querySelectorAll('app-folder-section')) as HTMLElement[];
    const section = sections.find((candidate) => candidate.querySelector('.folder-name')?.textContent === name);
    if (!section) {
      throw new Error(`No app-folder-section named "${name}" was rendered.`);
    }
    return section;
  };

  const uncategorizedRow = (fixture: ComponentFixture<MeetingSidebarComponent>): HTMLElement =>
    fixture.nativeElement.querySelector('.list[aria-label="Meetings"] app-meeting-list-item .row');

  const expandArchiveAndGetRow = (fixture: ComponentFixture<MeetingSidebarComponent>): HTMLElement => {
    (fixture.nativeElement.querySelector('.archive-toggle') as HTMLElement).click();
    fixture.detectChanges();
    return fixture.nativeElement.querySelector('#archived-meetings app-meeting-list-item .row');
  };

  /**
   * A collapsed folder renders no rows at all (only an expanded folder's
   * `.list` contains `app-meeting-list-item`s) — a real user must expand a
   * folder before they can physically grab one of its rows to start a drag.
   * Unlike the archive disclosure (`archiveManuallyExpanded` is a signal this
   * component owns and toggles internally on click), folder expansion is
   * driven entirely by the externally-owned `expandedFolders` input — the
   * `toggled` output only re-emits for the facade/store to update that input
   * — so a click on `.folder-toggle` in isolation does nothing here. Setting
   * `expandedFolders` is the real mechanism a real drag through the app
   * actually goes through.
   */
  const expandFolderAndGetRow = (
    fixture: ComponentFixture<MeetingSidebarComponent>,
    folderName: string,
  ): HTMLElement => {
    const folder = fixture.componentInstance.folders().find((candidate) => candidate.name === folderName);
    if (!folder) {
      throw new Error(`No folder named "${folderName}" is bound to this fixture.`);
    }
    fixture.componentRef.setInput('expandedFolders', new Set([folder.id]));
    fixture.detectChanges();
    return folderSectionByName(fixture, folderName).querySelector('.row') as HTMLElement;
  };

  it('dropping a folder-A meeting on folder B emits a folder move to B', () => {
    // Arrange
    const fixture = createFixture();
    const emitted: MeetingDragMoveRequest[] = [];
    fixture.componentInstance.meetingMoveRequested.subscribe((request) => emitted.push(request));
    const sourceRow = expandFolderAndGetRow(fixture, 'Clients');
    const targetSection = folderSectionByName(fixture, 'Internal');

    // Act
    startDrag(fixture, sourceRow);
    dropOn(fixture, targetSection);

    // Assert
    expect(emitted).toEqual([{ id: toMeetingId('m-a'), target: { kind: 'folder', folderId: folderB.id } }]);
  });

  it('dropping a meeting on the folder it already belongs to emits nothing', () => {
    // Arrange
    const fixture = createFixture();
    const emitted: MeetingDragMoveRequest[] = [];
    fixture.componentInstance.meetingMoveRequested.subscribe((request) => emitted.push(request));
    const sourceRow = expandFolderAndGetRow(fixture, 'Clients');
    const section = folderSectionByName(fixture, 'Clients');

    // Act
    startDrag(fixture, sourceRow);
    dropOn(fixture, section);

    // Assert
    expect(emitted).toEqual([]);
  });

  it('dropping an uncategorized meeting on the archive section emits an archive move', () => {
    // Arrange
    const fixture = createFixture();
    const emitted: MeetingDragMoveRequest[] = [];
    fixture.componentInstance.meetingMoveRequested.subscribe((request) => emitted.push(request));
    const sourceRow = uncategorizedRow(fixture);
    const archiveSection = fixture.nativeElement.querySelector('section.archive') as HTMLElement;

    // Act
    startDrag(fixture, sourceRow);
    dropOn(fixture, archiveSection);

    // Assert
    expect(emitted).toEqual([{ id: toMeetingId('m-uncat'), target: { kind: 'archive' } }]);
  });

  it('dropping an already-archived meeting on the archive section emits nothing', () => {
    // Arrange
    const fixture = createFixture();
    const emitted: MeetingDragMoveRequest[] = [];
    fixture.componentInstance.meetingMoveRequested.subscribe((request) => emitted.push(request));
    const sourceRow = expandArchiveAndGetRow(fixture);
    const archiveSection = fixture.nativeElement.querySelector('section.archive') as HTMLElement;

    // Act
    startDrag(fixture, sourceRow);
    dropOn(fixture, archiveSection);

    // Assert
    expect(emitted).toEqual([]);
  });

  it('dropping an archived meeting on a folder emits a folder move — archived meetings are always droppable into a folder', () => {
    // Arrange
    const fixture = createFixture();
    const emitted: MeetingDragMoveRequest[] = [];
    fixture.componentInstance.meetingMoveRequested.subscribe((request) => emitted.push(request));
    const sourceRow = expandArchiveAndGetRow(fixture);
    const targetSection = folderSectionByName(fixture, 'Clients');

    // Act
    startDrag(fixture, sourceRow);
    dropOn(fixture, targetSection);

    // Assert
    expect(emitted).toEqual([{ id: toMeetingId('m-archived'), target: { kind: 'folder', folderId: folderA.id } }]);
  });

  it('dropping a folder-A meeting onto the uncategorized list emits an uncategorized move', () => {
    // Arrange
    const fixture = createFixture();
    const emitted: MeetingDragMoveRequest[] = [];
    fixture.componentInstance.meetingMoveRequested.subscribe((request) => emitted.push(request));
    const sourceRow = expandFolderAndGetRow(fixture, 'Clients');
    const uncategorizedList = fixture.nativeElement.querySelector('.list[aria-label="Meetings"]') as HTMLElement;

    // Act
    startDrag(fixture, sourceRow);
    dropOn(fixture, uncategorizedList);

    // Assert
    expect(emitted).toEqual([{ id: toMeetingId('m-a'), target: { kind: 'uncategorized' } }]);
  });

  it('renders the archive drop target during a drag even when the archive is empty', () => {
    // Arrange
    const fixture = createFixture({ meetings: [baseMeeting('m-uncat')], folders: [] });
    expect(fixture.nativeElement.querySelector('section.archive')).toBeNull();
    const sourceRow = uncategorizedRow(fixture);

    // Act
    startDrag(fixture, sourceRow);

    // Assert
    expect(fixture.nativeElement.querySelector('section.archive')).toBeTruthy();
  });

  it('dragend clears every drop-accepting/drop-hover class and emits no move', () => {
    // Arrange
    const fixture = createFixture();
    const emitted: MeetingDragMoveRequest[] = [];
    fixture.componentInstance.meetingMoveRequested.subscribe((request) => emitted.push(request));
    const sourceRow = uncategorizedRow(fixture);
    const targetSection = folderSectionByName(fixture, 'Internal');

    // Act
    startDrag(fixture, sourceRow);
    targetSection.dispatchEvent(dragEvent('dragover'));
    fixture.detectChanges();

    // Assert (hovering mid-drag)
    expect(targetSection.classList.contains('drop-accepting')).toBe(true);
    expect(targetSection.classList.contains('drop-hover')).toBe(true);

    // Act
    sourceRow.dispatchEvent(dragEvent('dragend'));
    fixture.detectChanges();

    // Assert
    expect(targetSection.classList.contains('drop-accepting')).toBe(false);
    expect(targetSection.classList.contains('drop-hover')).toBe(false);
    expect(emitted).toEqual([]);
  });

  it('drops onto a COLLAPSED folder still work — no .list is required to receive the drop', () => {
    // Arrange
    const fixture = createFixture();
    const emitted: MeetingDragMoveRequest[] = [];
    fixture.componentInstance.meetingMoveRequested.subscribe((request) => emitted.push(request));
    const sourceRow = uncategorizedRow(fixture);
    const targetSection = folderSectionByName(fixture, 'Clients');
    expect(targetSection.querySelector('.list')).toBeNull();

    // Act
    startDrag(fixture, sourceRow);
    dropOn(fixture, targetSection);

    // Assert — still collapsed, and the drop still landed.
    expect(targetSection.querySelector('.list')).toBeNull();
    expect(emitted).toEqual([{ id: toMeetingId('m-uncat'), target: { kind: 'folder', folderId: folderA.id } }]);
  });
});
