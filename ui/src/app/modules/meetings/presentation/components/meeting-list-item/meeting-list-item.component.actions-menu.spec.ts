import { TestBed } from '@angular/core/testing';

import type { Folder, FolderId } from '../../../core/models/folder.model';
import { toFolderId } from '../../../core/models/folder.model';
import type { Meeting, MeetingId } from '../../../core/models/meeting.model';
import { toMeetingId } from '../../../core/models/meeting.model';
import { MeetingListItemComponent } from './meeting-list-item.component';

/** The archive/move-to-folder payload shapes the kebab menu emits — see the class doc comment on `MeetingListItemComponent`. */
interface ArchiveTogglePayload {
  readonly id: MeetingId;
  readonly archived: boolean;
}
interface FolderChangePayload {
  readonly id: MeetingId;
  readonly folderId: FolderId | null;
}

/**
 * Kebab (⋯) actions menu: archive/unarchive and move-to-folder, driven
 * entirely by `.focus()` + `dispatchEvent(new KeyboardEvent(...))` — never
 * `.click()` on the trigger — to guard the actual regression this feature
 * fixes: a keyboard-only or screen-reader user must be able to archive a
 * meeting and move it into/out of a folder without dragging. Split out of
 * `meeting-list-item.component.spec.ts` to keep that file under the
 * project's max-lines limit, mirroring
 * `meetings.facade.capture-defaults.spec.ts`. `archiveToggled`,
 * `folderChanged`, and `folders` are real members of
 * `MeetingListItemComponent` now (GREEN landed), so no structural cast is
 * needed here — `fixture.componentInstance.archiveToggled` etc. type-check
 * directly against the real component surface.
 */
describe('MeetingListItemComponent — kebab actions menu (archive + move to folder)', () => {
  const meeting: Meeting = {
    id: toMeetingId('m1'),
    title: 'Standup',
    createdAt: new Date(2026, 7, 27, 14, 2),
    durationSec: 32 * 60,
    summaries: [],
    archived: false,
    hasAudio: false, hasSystemTrack: false,
    droppedAudioChunks: 0,
  };
  const folders: readonly Folder[] = [{ id: toFolderId('f1'), name: 'Work', createdAt: new Date(2026, 0, 1), position: 0 }];

  const createFixture = () => {
    const fixture = TestBed.createComponent(MeetingListItemComponent);
    fixture.componentRef.setInput('meeting', meeting);
    fixture.detectChanges();
    return fixture;
  };

  const openMenuViaKeyboard = (fixture: ReturnType<typeof createFixture>, key = 'Enter'): HTMLButtonElement => {
    const trigger: HTMLButtonElement = fixture.nativeElement.querySelector('.menu-trigger');
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    fixture.detectChanges();
    return trigger;
  };

  it('renders the kebab trigger as a real, focusable button labelled with the meeting title', () => {
    const fixture = createFixture();

    const trigger: HTMLButtonElement = fixture.nativeElement.querySelector('.menu-trigger');
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.getAttribute('type')).toBe('button');
    expect(trigger.getAttribute('aria-label')).toBe('More actions for Standup');
    expect(trigger.getAttribute('tabindex')).not.toBe('-1');

    trigger.focus();
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps the menu closed until the trigger is activated', () => {
    const fixture = createFixture();

    expect(fixture.nativeElement.querySelector('.menu')).toBeNull();
    expect(fixture.nativeElement.querySelector('.menu-trigger').getAttribute('aria-expanded')).toBe('false');
  });

  it('opens the menu via Enter on the trigger — no click anywhere — exposing Archive and folder options as real buttons', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('folders', folders);
    fixture.detectChanges();

    const trigger = openMenuViaKeyboard(fixture);

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(fixture.nativeElement.querySelector('.menu')).toBeTruthy();

    const archiveItem: HTMLButtonElement = fixture.nativeElement.querySelector('.menu-item-archive');
    expect(archiveItem.tagName).toBe('BUTTON');
    expect(archiveItem.textContent?.trim()).toBe('Archive');

    const folderItems: HTMLButtonElement[] = Array.from(fixture.nativeElement.querySelectorAll('.menu-item-folder'));
    expect(folderItems.map((item) => item.tagName)).toEqual(['BUTTON', 'BUTTON']);
    expect(folderItems.map((item) => item.textContent?.trim())).toEqual(['No folder', 'Work']);
  });

  it('opens the menu via Space on the trigger — no click anywhere', () => {
    const fixture = createFixture();

    const trigger = openMenuViaKeyboard(fixture, ' ');

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(fixture.nativeElement.querySelector('.menu')).toBeTruthy();
  });

  it('shows Unarchive instead of Archive once the meeting is already archived', () => {
    const fixture = TestBed.createComponent(MeetingListItemComponent);
    fixture.componentRef.setInput('meeting', { ...meeting, archived: true });
    fixture.detectChanges();

    openMenuViaKeyboard(fixture);

    const archiveItem: HTMLButtonElement = fixture.nativeElement.querySelector('.menu-item-archive');
    expect(archiveItem.textContent?.trim()).toBe('Unarchive');
  });

  it('activates Archive via Enter: emits archiveToggled({ id, archived: true }) and closes the menu, using only keyboard events', () => {
    const fixture = createFixture();
    const emitted: ArchiveTogglePayload[] = [];
    fixture.componentInstance.archiveToggled.subscribe((event) => emitted.push(event));

    openMenuViaKeyboard(fixture);
    const archiveItem: HTMLButtonElement = fixture.nativeElement.querySelector('.menu-item-archive');
    archiveItem.focus();
    archiveItem.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();

    expect(emitted).toEqual([{ id: toMeetingId('m1'), archived: true }]);
    expect(fixture.nativeElement.querySelector('.menu')).toBeNull();
  });

  it('activates Unarchive via Space on an already-archived meeting: emits archiveToggled({ id, archived: false })', () => {
    const fixture = TestBed.createComponent(MeetingListItemComponent);
    fixture.componentRef.setInput('meeting', { ...meeting, archived: true });
    fixture.detectChanges();
    const emitted: ArchiveTogglePayload[] = [];
    fixture.componentInstance.archiveToggled.subscribe((event) => emitted.push(event));

    openMenuViaKeyboard(fixture);
    const archiveItem: HTMLButtonElement = fixture.nativeElement.querySelector('.menu-item-archive');
    archiveItem.focus();
    archiveItem.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    fixture.detectChanges();

    expect(emitted).toEqual([{ id: toMeetingId('m1'), archived: false }]);
  });

  it('activates a named folder option via Space: emits folderChanged({ id, folderId }) with that folder’s id', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('folders', folders);
    fixture.detectChanges();
    const emitted: FolderChangePayload[] = [];
    fixture.componentInstance.folderChanged.subscribe((event) => emitted.push(event));

    openMenuViaKeyboard(fixture);
    const folderItems: HTMLButtonElement[] = Array.from(fixture.nativeElement.querySelectorAll('.menu-item-folder'));
    const workItem = folderItems.find((item) => item.textContent?.trim() === 'Work');
    expect(workItem).toBeTruthy();
    workItem?.focus();
    workItem?.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    fixture.detectChanges();

    expect(emitted).toEqual([{ id: toMeetingId('m1'), folderId: toFolderId('f1') }]);
  });

  it('activates "No folder" via Enter: emits folderChanged({ id, folderId: null })', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('folders', folders);
    fixture.detectChanges();
    const emitted: FolderChangePayload[] = [];
    fixture.componentInstance.folderChanged.subscribe((event) => emitted.push(event));

    openMenuViaKeyboard(fixture);
    const folderItems: HTMLButtonElement[] = Array.from(fixture.nativeElement.querySelectorAll('.menu-item-folder'));
    const noFolderItem = folderItems.find((item) => item.textContent?.trim() === 'No folder');
    expect(noFolderItem).toBeTruthy();
    noFolderItem?.focus();
    noFolderItem?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();

    expect(emitted).toEqual([{ id: toMeetingId('m1'), folderId: null }]);
  });

  it('closes the menu on Escape without emitting any action', () => {
    const fixture = createFixture();
    const archiveEmitted: ArchiveTogglePayload[] = [];
    const folderEmitted: FolderChangePayload[] = [];
    fixture.componentInstance.archiveToggled.subscribe((event) => archiveEmitted.push(event));
    fixture.componentInstance.folderChanged.subscribe((event) => folderEmitted.push(event));

    const trigger = openMenuViaKeyboard(fixture);
    expect(fixture.nativeElement.querySelector('.menu')).toBeTruthy();

    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.menu')).toBeNull();
    expect(archiveEmitted).toEqual([]);
    expect(folderEmitted).toEqual([]);
  });

  it('closes the menu when the user clicks outside it, without emitting any action', () => {
    // Mirrors the (document:click) pattern in CaptureSettingsComponent.
    const fixture = createFixture();
    const archiveEmitted: ArchiveTogglePayload[] = [];
    fixture.componentInstance.archiveToggled.subscribe((event) => archiveEmitted.push(event));

    openMenuViaKeyboard(fixture);
    expect(fixture.nativeElement.querySelector('.menu')).toBeTruthy();

    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.menu')).toBeNull();
    expect(archiveEmitted).toEqual([]);
  });
});
