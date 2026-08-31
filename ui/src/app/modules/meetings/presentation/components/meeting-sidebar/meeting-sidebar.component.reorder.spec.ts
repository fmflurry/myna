import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';

import type { Folder, FolderId } from '../../../core/models/folder.model';
import { toFolderId } from '../../../core/models/folder.model';
import type { Meeting } from '../../../core/models/meeting.model';
import { toMeetingId } from '../../../core/models/meeting.model';
import type { MeetingDragMoveRequest } from './meeting-sidebar.component';
import { MeetingSidebarComponent } from './meeting-sidebar.component';

/**
 * RED spec for Phase 3 (manual reordering) at the coordinator level:
 * `MeetingSidebarComponent` grows a `MeetingContainer`/extended
 * `MeetingMoveTarget` union (adding a `'placement'` variant carrying
 * `previousId`/`nextId`) and an `onDropOnRow(anchorId, edge, container)`
 * handler that reuses the existing `resolveDroppedMeeting()` +
 * `computePlacement()` pipeline — no new drag state. It reuses the SAME
 * `meetingMoveRequested` output already asserted in
 * `meeting-sidebar.component.drag.spec.ts` for folder/uncategorized/archive
 * container moves; a row-level drop now emits `{ id, target: { kind:
 * 'placement', container, previousId, nextId } }` (or nothing, when
 * `computePlacement` returns `null`).
 *
 * Row drops are dispatched directly on each `.row` element (never on the
 * container), unlike the existing drag spec's `dropOn` helper — this is the
 * whole point of Phase 3: the row itself now owns `dragover`/`drop` and
 * `stopPropagation()`s them (see `meeting-list-item.reorder.spec.ts`), and
 * these tests lean on jsdom's REAL DOM nesting (Angular renders an actual
 * element tree here, not a mock) so bubbling through
 * `<app-meeting-list-item>` / `<app-folder-section>` host elements behaves
 * exactly as it would in the real app.
 *
 * Every placement below is computed against the raw, UNSTUBBED
 * `getBoundingClientRect()` (jsdom's all-zero rect), which `resolveDropEdge`
 * deterministically resolves to `'before'` — see
 * `presentation/utils/reorder-geometry.util.ts`.
 *
 * The Alt+ArrowUp/ArrowDown keyboard path (tests 9-10) needs no drag state
 * and no geometry: it is dispatched as a plain `KeyboardEvent` (jsdom DOES
 * support the real constructor, unlike `DragEvent`) directly on a row and
 * relies on bubbling to wherever the sidebar wires the listener. Both
 * keyboard tests use only the uncategorized list, which the sidebar
 * template renders directly — sidestepping any assumption about how
 * `FolderSectionComponent` might forward a keyboard-originated swap for
 * folder rows, which this brief does not specify.
 */
describe('MeetingSidebarComponent — row-level reorder (Phase 3)', () => {
  const folderA: Folder = { id: toFolderId('fA'), name: 'Clients', createdAt: new Date(2026, 7, 1), position: 0 };
  const folderB: Folder = { id: toFolderId('fB'), name: 'Internal', createdAt: new Date(2026, 7, 2), position: 1 };

  const baseMeeting = (id: string, overrides: { folderId?: FolderId; archived?: boolean } = {}): Meeting => ({
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

  // Uncategorized, in render order: m1, m2, m3.
  const m1 = baseMeeting('m1');
  const m2 = baseMeeting('m2');
  const m3 = baseMeeting('m3');
  // Folder A: a1, a2. Folder B: b1, b2.
  const a1 = baseMeeting('a1', { folderId: folderA.id });
  const a2 = baseMeeting('a2', { folderId: folderA.id });
  const b1 = baseMeeting('b1', { folderId: folderB.id });
  const b2 = baseMeeting('b2', { folderId: folderB.id });
  // Archived, in render order: arch1, arch2.
  const arch1 = baseMeeting('arch1', { archived: true });
  const arch2 = baseMeeting('arch2', { archived: true });

  const defaultMeetings: readonly Meeting[] = [m1, m2, m3, a1, a2, b1, b2, arch1, arch2];

  const createFixture = (overrides: { meetings?: readonly Meeting[]; folders?: readonly Folder[] } = {}) => {
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

  const dropOnRow = (fixture: ComponentFixture<MeetingSidebarComponent>, row: HTMLElement): void => {
    row.dispatchEvent(dragEvent('dragover'));
    fixture.detectChanges();
    row.dispatchEvent(dragEvent('drop'));
    fixture.detectChanges();
  };

  const rowWithTitle = (root: HTMLElement, title: string): HTMLElement => {
    const rows = Array.from(root.querySelectorAll('app-meeting-list-item .row')) as HTMLElement[];
    const row = rows.find((candidate) => candidate.querySelector('.title')?.textContent === title);
    if (!row) {
      throw new Error(`No row titled "${title}" is rendered under the given root.`);
    }
    return row;
  };

  const uncategorizedListEl = (fixture: ComponentFixture<MeetingSidebarComponent>): HTMLElement =>
    fixture.nativeElement.querySelector('.list[aria-label="Meetings"]');

  const uncategorizedRow = (fixture: ComponentFixture<MeetingSidebarComponent>, title: string): HTMLElement =>
    rowWithTitle(uncategorizedListEl(fixture), title);

  const folderSectionByName = (fixture: ComponentFixture<MeetingSidebarComponent>, name: string): HTMLElement => {
    const sections = Array.from(fixture.nativeElement.querySelectorAll('app-folder-section')) as HTMLElement[];
    const section = sections.find((candidate) => candidate.querySelector('.folder-name')?.textContent === name);
    if (!section) {
      throw new Error(`No app-folder-section named "${name}" was rendered.`);
    }
    return section;
  };

  /** Expands ALL named folders at once (setting `expandedFolders` overwrites the whole set). */
  const expandFolders = (fixture: ComponentFixture<MeetingSidebarComponent>, names: readonly string[]): void => {
    const ids = names.map((name) => {
      const folder = fixture.componentInstance.folders().find((candidate) => candidate.name === name);
      if (!folder) {
        throw new Error(`No folder named "${name}" is bound to this fixture.`);
      }
      return folder.id;
    });
    fixture.componentRef.setInput('expandedFolders', new Set(ids));
    fixture.detectChanges();
  };

  const folderRow = (fixture: ComponentFixture<MeetingSidebarComponent>, folderName: string, title: string): HTMLElement =>
    rowWithTitle(folderSectionByName(fixture, folderName), title);

  const expandArchiveAndGetRow = (fixture: ComponentFixture<MeetingSidebarComponent>, title: string): HTMLElement => {
    (fixture.nativeElement.querySelector('.archive-toggle') as HTMLElement).click();
    fixture.detectChanges();
    return rowWithTitle(fixture.nativeElement.querySelector('#archived-meetings'), title);
  };

  const setSearchQuery = (fixture: ComponentFixture<MeetingSidebarComponent>, value: string): void => {
    const input = fixture.nativeElement.querySelector('input[type="search"]') as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };

  it('drop on an uncategorized row resolves neighbours using "before" semantics off the raw (unstubbed) rect', () => {
    // Arrange
    const fixture = createFixture();
    const emitted: MeetingDragMoveRequest[] = [];
    fixture.componentInstance.meetingMoveRequested.subscribe((request) => emitted.push(request));
    const sourceRow = uncategorizedRow(fixture, 'm3');
    const anchorRow = uncategorizedRow(fixture, 'm1');

    // Act
    startDrag(fixture, sourceRow);
    dropOnRow(fixture, anchorRow);

    // Assert — dropping m3 "before" m1 (the all-zero rect always resolves 'before') puts it at the very front.
    expect(emitted).toEqual([
      {
        id: toMeetingId('m3'),
        target: { kind: 'placement', container: { kind: 'uncategorized' }, previousId: null, nextId: toMeetingId('m1') },
      },
    ]);
  });

  it('drop on a folder-B row while dragging a folder-A meeting moves AND reorders in one request', () => {
    // Arrange
    const fixture = createFixture();
    const emitted: MeetingDragMoveRequest[] = [];
    fixture.componentInstance.meetingMoveRequested.subscribe((request) => emitted.push(request));
    expandFolders(fixture, ['Clients', 'Internal']);
    const sourceRow = folderRow(fixture, 'Clients', 'a1');
    const anchorRow = folderRow(fixture, 'Internal', 'b1');

    // Act
    startDrag(fixture, sourceRow);
    dropOnRow(fixture, anchorRow);

    // Assert
    expect(emitted).toEqual([
      {
        id: toMeetingId('a1'),
        target: {
          kind: 'placement',
          container: { kind: 'folder', folderId: folderB.id },
          previousId: null,
          nextId: toMeetingId('b1'),
        },
      },
    ]);
  });

  it('drop on an archived row while dragging an unarchived meeting resolves an archive placement', () => {
    // Arrange
    const fixture = createFixture();
    const emitted: MeetingDragMoveRequest[] = [];
    fixture.componentInstance.meetingMoveRequested.subscribe((request) => emitted.push(request));
    const sourceRow = uncategorizedRow(fixture, 'm2');
    const anchorRow = expandArchiveAndGetRow(fixture, 'arch1');

    // Act
    startDrag(fixture, sourceRow);
    dropOnRow(fixture, anchorRow);

    // Assert
    expect(emitted).toEqual([
      {
        id: toMeetingId('m2'),
        target: { kind: 'placement', container: { kind: 'archive' }, previousId: null, nextId: toMeetingId('arch1') },
      },
    ]);
  });

  it('drop on the dragged row itself emits nothing', () => {
    // Arrange
    const fixture = createFixture();
    const emitted: MeetingDragMoveRequest[] = [];
    fixture.componentInstance.meetingMoveRequested.subscribe((request) => emitted.push(request));
    const sourceRow = uncategorizedRow(fixture, 'm1');

    // Act
    startDrag(fixture, sourceRow);
    dropOnRow(fixture, sourceRow);

    // Assert
    expect(emitted).toEqual([]);
  });

  it('drop on a row while a search query is active falls through to the container handler; no placement is emitted', () => {
    // Arrange
    const fixture = createFixture();
    setSearchQuery(fixture, 'm'); // matches m1, m2, m3 only
    const emitted: MeetingDragMoveRequest[] = [];
    fixture.componentInstance.meetingMoveRequested.subscribe((request) => emitted.push(request));
    const sourceRow = uncategorizedRow(fixture, 'm1');
    const anchorRow = uncategorizedRow(fixture, 'm2');

    // Act
    startDrag(fixture, sourceRow);
    dropOnRow(fixture, anchorRow);

    // Assert — the row's own indicator never activates, and no placement was requested.
    expect(anchorRow.classList.contains('drop-before')).toBe(false);
    expect(anchorRow.classList.contains('drop-after')).toBe(false);
    expect(emitted).toEqual([]);
  });

  it('dragend clears every row indicator class in the sidebar', () => {
    // Arrange
    const fixture = createFixture();
    const sourceRow = uncategorizedRow(fixture, 'm1');
    const rowTwo = uncategorizedRow(fixture, 'm2');
    const rowThree = uncategorizedRow(fixture, 'm3');

    // Act — hover two different rows mid-drag.
    startDrag(fixture, sourceRow);
    rowTwo.dispatchEvent(dragEvent('dragover'));
    fixture.detectChanges();
    rowThree.dispatchEvent(dragEvent('dragover'));
    fixture.detectChanges();

    // Assert (mid-drag)
    expect(rowTwo.classList.contains('drop-before')).toBe(true);
    expect(rowThree.classList.contains('drop-before')).toBe(true);

    // Act
    sourceRow.dispatchEvent(dragEvent('dragend'));
    fixture.detectChanges();

    // Assert
    expect(rowTwo.classList.contains('drop-before')).toBe(false);
    expect(rowTwo.classList.contains('drop-after')).toBe(false);
    expect(rowThree.classList.contains('drop-before')).toBe(false);
    expect(rowThree.classList.contains('drop-after')).toBe(false);
  });

  it('drop on a row inside a folder emits exactly one placement request — the folder chrome drop handler never also fires', () => {
    // Arrange
    const fixture = createFixture();
    const emitted: MeetingDragMoveRequest[] = [];
    fixture.componentInstance.meetingMoveRequested.subscribe((request) => emitted.push(request));
    const sourceRow = uncategorizedRow(fixture, 'm1');
    expandFolders(fixture, ['Clients']);
    const anchorRow = folderRow(fixture, 'Clients', 'a1');

    // Act
    startDrag(fixture, sourceRow);
    dropOnRow(fixture, anchorRow);

    // Assert — exactly one event; a second, duplicate {kind:'folder'} move would fail this `toEqual`.
    expect(emitted).toEqual([
      {
        id: toMeetingId('m1'),
        target: {
          kind: 'placement',
          container: { kind: 'folder', folderId: folderA.id },
          previousId: null,
          nextId: toMeetingId('a1'),
        },
      },
    ]);
  });

  it('a row drop dispatched immediately after dragend still resolves via the draggedSnapshot fallback', () => {
    // Arrange
    const fixture = createFixture();
    const emitted: MeetingDragMoveRequest[] = [];
    fixture.componentInstance.meetingMoveRequested.subscribe((request) => emitted.push(request));
    const sourceRow = uncategorizedRow(fixture, 'm1');
    const anchorRow = uncategorizedRow(fixture, 'm3');

    // Act — dragend fires (synchronously clearing draggingMeetingId) BEFORE the drop, mirroring the
    // out-of-order platform risk `draggedSnapshot` exists to harden against; the snapshot itself is
    // cleared only via a deferred `setTimeout(0)`, so it is still populated here.
    startDrag(fixture, sourceRow);
    sourceRow.dispatchEvent(dragEvent('dragend'));
    fixture.detectChanges();
    dropOnRow(fixture, anchorRow);

    // Assert
    expect(emitted).toEqual([
      {
        id: toMeetingId('m1'),
        target: {
          kind: 'placement',
          container: { kind: 'uncategorized' },
          previousId: toMeetingId('m2'),
          nextId: toMeetingId('m3'),
        },
      },
    ]);
  });

  it('Alt+ArrowDown on a focused row swaps it with the next row in the same container', () => {
    // Arrange
    const fixture = createFixture();
    const emitted: MeetingDragMoveRequest[] = [];
    fixture.componentInstance.meetingMoveRequested.subscribe((request) => emitted.push(request));
    const row = uncategorizedRow(fixture, 'm1');

    // Act
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true }));
    fixture.detectChanges();

    // Assert — m1 swaps with m2: new order is m2, m1, m3.
    expect(emitted).toEqual([
      {
        id: toMeetingId('m1'),
        target: {
          kind: 'placement',
          container: { kind: 'uncategorized' },
          previousId: toMeetingId('m2'),
          nextId: toMeetingId('m3'),
        },
      },
    ]);
  });

  it('Alt+ArrowUp on the first row of a container emits nothing', () => {
    // Arrange
    const fixture = createFixture();
    const emitted: MeetingDragMoveRequest[] = [];
    fixture.componentInstance.meetingMoveRequested.subscribe((request) => emitted.push(request));
    const row = uncategorizedRow(fixture, 'm1');

    // Act
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true, cancelable: true }));
    fixture.detectChanges();

    // Assert
    expect(emitted).toEqual([]);
  });
});
