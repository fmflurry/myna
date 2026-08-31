import { TestBed } from '@angular/core/testing';

import type { Folder, FolderId } from '../../../core/models/folder.model';
import { toFolderId } from '../../../core/models/folder.model';
import type { Meeting } from '../../../core/models/meeting.model';
import { toMeetingId } from '../../../core/models/meeting.model';
import { MeetingSidebarComponent } from './meeting-sidebar.component';

/**
 * RED spec for Phase 3 — folder rendering inside `MeetingSidebarComponent`.
 * Companion to `meeting-sidebar.component.spec.ts` (untouched); this file
 * only exercises the NEW folder-related inputs/outputs:
 *
 * - Inputs: `folders: readonly Folder[]`, `expandedFolders: ReadonlySet<FolderId>`.
 * - Outputs: `folderCreated`, `folderRenamed`, `folderDeleted`, `folderToggled`.
 * - Render order top to bottom: Uncategorized meetings (today's `.list[aria-label="Meetings"]`,
 *   unchanged markup) -> one `app-folder-section` per folder ordered by
 *   `position` -> `.new-folder-trigger` / `.new-folder-input` affordance ->
 *   the existing Archive section (untouched, pinned last).
 * - Search: a query auto-expands folders with hits and shows only those
 *   hits; a folder with 0 hits is hidden entirely; the new-folder
 *   affordance hides while a query is active.
 */
describe('MeetingSidebarComponent — folders', () => {
  const folderA: Folder = { id: toFolderId('fA'), name: 'Clients', createdAt: new Date(2026, 7, 1), position: 1 };
  const folderB: Folder = { id: toFolderId('fB'), name: 'Internal', createdAt: new Date(2026, 7, 2), position: 0 };
  const folderC: Folder = { id: toFolderId('fC'), name: 'Later', createdAt: new Date(2026, 7, 3), position: 2 };

  const baseMeeting = (id: string, title: string, folderId?: FolderId): Meeting => ({
    id: toMeetingId(id),
    title,
    createdAt: new Date(2026, 7, 27),
    durationSec: 60,
    summaries: [],
    archived: false,
    hasAudio: false,
    hasSystemTrack: false,
    droppedAudioChunks: 0,
    ...(folderId ? { folderId } : {}),
  });

  const createFixture = (overrides: { folders?: readonly Folder[]; meetings?: readonly Meeting[] } = {}) => {
    const fixture = TestBed.createComponent(MeetingSidebarComponent);
    fixture.componentRef.setInput('meetings', overrides.meetings ?? []);
    fixture.componentRef.setInput('folders', overrides.folders ?? []);
    fixture.detectChanges();
    return fixture;
  };

  it('renders one folder section per folder, ordered by position', () => {
    // Arrange / Act
    const fixture = createFixture({ folders: [folderA, folderB, folderC] });

    // Assert
    const sections: HTMLElement[] = Array.from(fixture.nativeElement.querySelectorAll('app-folder-section'));
    expect(sections.length).toBe(3);
    const names = sections.map((section) => section.querySelector('.folder-name')!.textContent);
    expect(names).toEqual(['Internal', 'Clients', 'Later']);
  });

  it('renders uncategorized meetings above the folder sections', () => {
    // Arrange / Act
    const fixture = createFixture({
      folders: [folderA],
      meetings: [baseMeeting('u1', 'Uncategorized standup'), baseMeeting('a1', 'Alpha review', folderA.id)],
    });

    // Assert
    const nodes: Element[] = Array.from(
      fixture.nativeElement.querySelectorAll('.list[aria-label="Meetings"], app-folder-section'),
    );
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes[0]!.matches('.list[aria-label="Meetings"]')).toBe(true);
  });

  it('sidebar markup is unchanged when there are no folders', () => {
    // Arrange / Act — mirrors the existing default fixture in meeting-sidebar.component.spec.ts.
    const fixture = createFixture({
      meetings: [
        baseMeeting('m1', 'Standup'),
        baseMeeting('m2', 'Client review'),
      ],
    });

    // Assert — the pre-existing uncategorized list still renders untouched, and no folder UI appears.
    const list = fixture.nativeElement.querySelector('.list[aria-label="Meetings"]');
    expect(list).toBeTruthy();
    expect(list.querySelectorAll('app-meeting-list-item').length).toBe(2);
    expect(fixture.nativeElement.querySelectorAll('app-folder-section').length).toBe(0);
  });

  it('a query auto-expands folders with hits and hides folders without hits', () => {
    // Arrange
    const fixture = createFixture({
      folders: [folderA, folderB],
      meetings: [baseMeeting('a1', 'Alpha review', folderA.id), baseMeeting('b1', 'Beta sync', folderB.id)],
    });
    const input: HTMLInputElement = fixture.nativeElement.querySelector('input');

    // Act
    input.value = 'alpha';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    // Assert
    const sections: HTMLElement[] = Array.from(fixture.nativeElement.querySelectorAll('app-folder-section'));
    expect(sections.length).toBe(1);
    expect(sections[0]!.querySelector('.folder-name')!.textContent).toBe('Clients');
    expect(sections[0]!.querySelector('.folder-toggle')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('hides the new-folder affordance while a query is active', () => {
    // Arrange
    const fixture = createFixture();
    expect(fixture.nativeElement.querySelector('.new-folder-trigger')).toBeTruthy();
    const input: HTMLInputElement = fixture.nativeElement.querySelector('input');

    // Act
    input.value = 'anything';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    // Assert
    expect(fixture.nativeElement.querySelector('.new-folder-trigger')).toBeNull();
  });

  it('emits folderCreated with the trimmed name on Enter', () => {
    // Arrange
    const fixture = createFixture();
    const created: string[] = [];
    fixture.componentInstance.folderCreated.subscribe((name: string) => created.push(name));
    fixture.nativeElement.querySelector('.new-folder-trigger').click();
    fixture.detectChanges();
    const input: HTMLInputElement = fixture.nativeElement.querySelector('.new-folder-input');

    // Act
    input.value = '  Client Work  ';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();

    // Assert
    expect(created).toEqual(['Client Work']);
  });

  it('Escape emits nothing', () => {
    // Arrange
    const fixture = createFixture();
    const created: string[] = [];
    fixture.componentInstance.folderCreated.subscribe((name: string) => created.push(name));
    fixture.nativeElement.querySelector('.new-folder-trigger').click();
    fixture.detectChanges();
    const input: HTMLInputElement = fixture.nativeElement.querySelector('.new-folder-input');

    // Act
    input.value = 'Some name';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();

    // Assert
    expect(created).toEqual([]);
    expect(fixture.nativeElement.querySelector('.new-folder-trigger')).toBeTruthy();
  });

  it('blank emits nothing', () => {
    // Arrange
    const fixture = createFixture();
    const created: string[] = [];
    fixture.componentInstance.folderCreated.subscribe((name: string) => created.push(name));
    fixture.nativeElement.querySelector('.new-folder-trigger').click();
    fixture.detectChanges();
    const input: HTMLInputElement = fixture.nativeElement.querySelector('.new-folder-input');

    // Act
    input.value = '   ';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();

    // Assert
    expect(created).toEqual([]);
  });
});
