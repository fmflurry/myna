import { TestBed } from '@angular/core/testing';

import type { Folder, FolderId } from '../../../core/models/folder.model';
import { toFolderId } from '../../../core/models/folder.model';
import type { Meeting } from '../../../core/models/meeting.model';
import { FolderSectionComponent } from './folder-section.component';

/**
 * RED spec for Phase 3 — `app-folder-section`, a dumb component rendering one
 * folder's disclosure (header with name/count, inline rename, two-step
 * delete confirm) and its meetings as a listbox, mirroring the archive
 * disclosure precedent in `meeting-sidebar.component.ts`/`.html`.
 *
 * Contract under test (component does not exist yet):
 * - Inputs: folder (required), meetings, expanded, selectedId,
 *   selectionDisabled, recordingMeetingId.
 * - Outputs: toggled, renamed, deleted, plus re-emitted row events
 *   (meetingSelected / meetingDeleted) — not exercised here; covered
 *   indirectly via meeting-sidebar's folder specs.
 * - Header: `<button class="folder-toggle" aria-expanded aria-controls>`.
 * - Body: `<div role="listbox" [attr.aria-label]="'<folder name> meetings'">`.
 * - Empty folder (expanded) shows `.empty-hint`.
 * - Rename: `.rename` button opens `.rename-input`; Enter commits (trimmed),
 *   Escape cancels, blank is ignored.
 * - Delete: `.delete` button opens a two-step confirm (`.confirm-yes` /
 *   `.confirm-no`); Escape backs out without emitting.
 */
describe('FolderSectionComponent', () => {
  const folder: Folder = { id: toFolderId('f1'), name: 'Project X', createdAt: new Date(2026, 7, 1), position: 0 };

  const createFixture = (overrides: { folder?: Folder; meetings?: readonly Meeting[]; expanded?: boolean } = {}) => {
    const fixture = TestBed.createComponent(FolderSectionComponent);
    fixture.componentRef.setInput('folder', overrides.folder ?? folder);
    fixture.componentRef.setInput('meetings', overrides.meetings ?? []);
    fixture.componentRef.setInput('expanded', overrides.expanded ?? false);
    fixture.detectChanges();
    return fixture;
  };

  it('header exposes aria-expanded and aria-controls matching the body id', () => {
    // Arrange / Act
    const fixture = createFixture({ expanded: true, meetings: [] });

    // Assert
    const button: HTMLButtonElement = fixture.nativeElement.querySelector('.folder-toggle');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const controls = button.getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    const body = fixture.nativeElement.querySelector(`#${controls}`);
    expect(body).toBeTruthy();
    expect(body.getAttribute('role')).toBe('listbox');
    expect(body.getAttribute('aria-label')).toBe('Project X meetings');
  });

  it('shows the empty hint for a folder with no meetings', () => {
    // Arrange / Act
    const fixture = createFixture({ expanded: true, meetings: [] });

    // Assert
    const hint = fixture.nativeElement.querySelector('.empty-hint');
    expect(hint).toBeTruthy();
    expect(hint.textContent).toContain('Empty — move a meeting here');
  });

  it('delete requires two steps and Escape backs out', () => {
    // Arrange
    const fixture = createFixture();
    const deleted: FolderId[] = [];
    fixture.componentInstance.deleted.subscribe((id: FolderId) => deleted.push(id));

    // Act: a single click only opens the confirm — nothing is deleted yet.
    fixture.nativeElement.querySelector('.delete').click();
    fixture.detectChanges();

    // Assert
    expect(fixture.nativeElement.querySelector('.confirm-yes')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.confirm-no')).toBeTruthy();
    expect(deleted).toEqual([]);

    // Act: Escape backs out without deleting.
    fixture.nativeElement
      .querySelector('.folder-header')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();

    // Assert
    expect(fixture.nativeElement.querySelector('.confirm-yes')).toBeNull();
    expect(fixture.nativeElement.querySelector('.delete')).toBeTruthy();
    expect(deleted).toEqual([]);

    // Act: the second step — click delete, then confirm — actually deletes.
    fixture.nativeElement.querySelector('.delete').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('.confirm-yes').click();

    // Assert
    expect(deleted).toEqual([folder.id]);
  });

  it('commits the rename on Enter with the trimmed name', () => {
    // Arrange
    const fixture = createFixture();
    const renamed: { id: FolderId; name: string }[] = [];
    fixture.componentInstance.renamed.subscribe((event: { id: FolderId; name: string }) => renamed.push(event));
    fixture.nativeElement.querySelector('.rename').click();
    fixture.detectChanges();
    const input: HTMLInputElement = fixture.nativeElement.querySelector('.rename-input');

    // Act
    input.value = '  Renamed Folder  ';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();

    // Assert
    expect(renamed).toEqual([{ id: folder.id, name: 'Renamed Folder' }]);
    expect(fixture.nativeElement.querySelector('.rename-input')).toBeNull();
  });

  it('cancels the rename on Escape without emitting', () => {
    // Arrange
    const fixture = createFixture();
    const renamed: { id: FolderId; name: string }[] = [];
    fixture.componentInstance.renamed.subscribe((event: { id: FolderId; name: string }) => renamed.push(event));
    fixture.nativeElement.querySelector('.rename').click();
    fixture.detectChanges();
    const input: HTMLInputElement = fixture.nativeElement.querySelector('.rename-input');

    // Act
    input.value = 'Should not save';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();

    // Assert
    expect(renamed).toEqual([]);
    expect(fixture.nativeElement.querySelector('.rename-input')).toBeNull();
    expect(fixture.nativeElement.querySelector('.folder-name').textContent).toBe('Project X');
  });

  it('ignores a blank rename and emits nothing', () => {
    // Arrange
    const fixture = createFixture();
    const renamed: { id: FolderId; name: string }[] = [];
    fixture.componentInstance.renamed.subscribe((event: { id: FolderId; name: string }) => renamed.push(event));
    fixture.nativeElement.querySelector('.rename').click();
    fixture.detectChanges();
    const input: HTMLInputElement = fixture.nativeElement.querySelector('.rename-input');

    // Act
    input.value = '   ';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();

    // Assert
    expect(renamed).toEqual([]);
  });
});

/**
 * RED spec for the drag-and-drop drop target: a new `dropAccepting` input
 * and `dropped` output on `FolderSectionComponent`, bound on the
 * `.folder-section` ROOT (not `.list`) so a COLLAPSED folder is still a
 * valid drop target. jsdom 25.0.1 has neither `DragEvent` nor
 * `DataTransfer`; every test below dispatches a bare
 * `new Event(type, { bubbles, cancelable })`, which Angular's
 * `(dragover)`/`(dragleave)`/`(drop)` bindings receive via plain
 * `addEventListener` regardless of the real event subtype.
 */
describe('FolderSectionComponent — drop target', () => {
  const folder: Folder = { id: toFolderId('f1'), name: 'Project X', createdAt: new Date(2026, 7, 1), position: 0 };

  const dragEvent = (type: string): Event => new Event(type, { bubbles: true, cancelable: true });

  const createFixture = () => {
    const fixture = TestBed.createComponent(FolderSectionComponent);
    fixture.componentRef.setInput('folder', folder);
    fixture.componentRef.setInput('meetings', []);
    fixture.detectChanges();
    return fixture;
  };

  it('dragover while dropAccepting sets defaultPrevented and adds .drop-hover', () => {
    // Arrange
    const fixture = createFixture();
    fixture.componentRef.setInput('dropAccepting', true);
    fixture.detectChanges();
    const root: HTMLElement = fixture.nativeElement.querySelector('.folder-section');
    const event = dragEvent('dragover');

    // Act
    root.dispatchEvent(event);
    fixture.detectChanges();

    // Assert
    expect(event.defaultPrevented).toBe(true);
    expect(root.classList.contains('drop-hover')).toBe(true);
  });

  it('dragover while NOT dropAccepting leaves defaultPrevented false and adds no drop-hover class', () => {
    // Arrange
    const fixture = createFixture();
    fixture.componentRef.setInput('dropAccepting', false);
    fixture.detectChanges();
    const root: HTMLElement = fixture.nativeElement.querySelector('.folder-section');
    const event = dragEvent('dragover');

    // Act
    root.dispatchEvent(event);
    fixture.detectChanges();

    // Assert
    expect(event.defaultPrevented).toBe(false);
    expect(root.classList.contains('drop-hover')).toBe(false);
  });

  it('drop emits dropped with the folder id while accepting, and emits nothing while not', () => {
    // Arrange
    const fixture = createFixture();
    const dropped: FolderId[] = [];
    fixture.componentInstance.dropped.subscribe((id: FolderId) => dropped.push(id));
    const root: HTMLElement = fixture.nativeElement.querySelector('.folder-section');

    // Act: not accepting — drop is ignored.
    fixture.componentRef.setInput('dropAccepting', false);
    fixture.detectChanges();
    root.dispatchEvent(dragEvent('drop'));

    // Assert
    expect(dropped).toEqual([]);

    // Act: accepting — drop emits the folder id.
    fixture.componentRef.setInput('dropAccepting', true);
    fixture.detectChanges();
    root.dispatchEvent(dragEvent('dragover'));
    root.dispatchEvent(dragEvent('drop'));

    // Assert
    expect(dropped).toEqual([folder.id]);
  });

  it('dragleave clears the .drop-hover class', () => {
    // Arrange
    const fixture = createFixture();
    fixture.componentRef.setInput('dropAccepting', true);
    fixture.detectChanges();
    const root: HTMLElement = fixture.nativeElement.querySelector('.folder-section');
    root.dispatchEvent(dragEvent('dragover'));
    fixture.detectChanges();
    expect(root.classList.contains('drop-hover')).toBe(true);

    // Act
    root.dispatchEvent(dragEvent('dragleave'));
    fixture.detectChanges();

    // Assert
    expect(root.classList.contains('drop-hover')).toBe(false);
  });
});
