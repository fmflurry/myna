import { TestBed } from '@angular/core/testing';

import type { Meeting } from '../../../core/models/meeting.model';
import { toMeetingId } from '../../../core/models/meeting.model';
import { MeetingListItemComponent, SELECTION_DISABLED_HINT } from './meeting-list-item.component';

describe('MeetingListItemComponent', () => {
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

  const createFixture = (selected = false) => {
    const fixture = TestBed.createComponent(MeetingListItemComponent);
    fixture.componentRef.setInput('meeting', meeting);
    fixture.componentRef.setInput('selected', selected);
    fixture.detectChanges();
    return fixture;
  };

  it('renders the title and a time + duration secondary line', () => {
    const fixture = createFixture();

    expect(fixture.nativeElement.querySelector('.title').textContent).toBe('Standup');
    expect(fixture.nativeElement.querySelector('.meta').textContent).toContain('32m');
  });

  it('marks the selected row', () => {
    const fixture = createFixture(true);

    expect(fixture.nativeElement.querySelector('.row').classList.contains('selected')).toBe(true);
  });

  it('emits opened with the meeting id when clicked', () => {
    const fixture = createFixture();
    const emitted: string[] = [];
    fixture.componentInstance.opened.subscribe((id) => emitted.push(id));

    fixture.nativeElement.querySelector('.row').click();

    expect(emitted).toEqual(['m1']);
  });

  it('requires a two-step confirm before emitting deleteRequested', () => {
    const fixture = createFixture();
    const emitted: string[] = [];
    fixture.componentInstance.deleteRequested.subscribe((id) => emitted.push(id));

    fixture.nativeElement.querySelector('.delete').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.confirm')).toBeTruthy();
    expect(emitted.length).toBe(0);

    fixture.nativeElement.querySelector('.confirm-yes').click();

    expect(emitted).toEqual(['m1']);
  });

  it('cancels the confirm without emitting', () => {
    const fixture = createFixture();
    const emitted: string[] = [];
    fixture.componentInstance.deleteRequested.subscribe((id) => emitted.push(id));

    fixture.nativeElement.querySelector('.delete').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('.confirm-no').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.confirm')).toBeNull();
    expect(emitted.length).toBe(0);
  });

  it('hides the title and meta (swap, not overlay) while confirming delete', () => {
    // Regression test: the confirm block used to be absolutely positioned
    // ON TOP OF the always-rendered title/meta, so "Untitled meeting" and
    // "Delete?" were drawn over each other and both were unreadable.
    const fixture = createFixture();
    expect(fixture.nativeElement.querySelector('.title')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.confirm')).toBeNull();

    fixture.nativeElement.querySelector('.delete').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.confirm')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.title')).toBeNull();
    expect(fixture.nativeElement.querySelector('.meta')).toBeNull();
  });

  it('restores the title and meta after cancelling the delete confirmation', () => {
    const fixture = createFixture();

    fixture.nativeElement.querySelector('.delete').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('.confirm-no').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.confirm')).toBeNull();
    expect(fixture.nativeElement.querySelector('.title').textContent).toBe('Standup');
    expect(fixture.nativeElement.querySelector('.meta')).toBeTruthy();
  });

  it('cancels the delete confirmation on Escape without deleting', () => {
    const fixture = createFixture();
    const emitted: string[] = [];
    fixture.componentInstance.deleteRequested.subscribe((id) => emitted.push(id));

    fixture.nativeElement.querySelector('.delete').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.confirm')).toBeTruthy();

    fixture.nativeElement
      .querySelector('.row')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.confirm')).toBeNull();
    expect(fixture.nativeElement.querySelector('.title')).toBeTruthy();
    expect(emitted.length).toBe(0);
  });

  it('keeps the same row container element across the delete-confirm swap (no layout jump)', () => {
    const fixture = createFixture();
    const row = fixture.nativeElement.querySelector('.row');

    fixture.nativeElement.querySelector('.delete').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.row')).toBe(row);

    fixture.nativeElement.querySelector('.confirm-no').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.row')).toBe(row);
  });

  it('does not emit a selection event when Yes or No is clicked while confirming delete', () => {
    const fixture = createFixture();
    const openedEmitted: string[] = [];
    fixture.componentInstance.opened.subscribe((id) => openedEmitted.push(id));

    fixture.nativeElement.querySelector('.delete').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('.confirm-no').click();
    fixture.detectChanges();
    expect(openedEmitted).toEqual([]);

    fixture.nativeElement.querySelector('.delete').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('.confirm-yes').click();

    expect(openedEmitted).toEqual([]);
  });

  it('does not emit opened when the delete button is clicked', () => {
    const fixture = createFixture();
    const openedEmitted: string[] = [];
    fixture.componentInstance.opened.subscribe((id) => openedEmitted.push(id));

    fixture.nativeElement.querySelector('.delete').click();

    expect(openedEmitted.length).toBe(0);
  });

  it('never silently swallows a click when disabled: it visibly shows a tooltip explaining why', () => {
    const fixture = TestBed.createComponent(MeetingListItemComponent);
    fixture.componentRef.setInput('meeting', meeting);
    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();

    const row: HTMLElement = fixture.nativeElement.querySelector('.row');
    expect(row.classList.contains('disabled')).toBe(true);
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(row.getAttribute('title')).toBe(SELECTION_DISABLED_HINT);
  });

  it('does not emit opened when disabled and clicked', () => {
    const fixture = TestBed.createComponent(MeetingListItemComponent);
    fixture.componentRef.setInput('meeting', meeting);
    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();
    const emitted: string[] = [];
    fixture.componentInstance.opened.subscribe((id) => emitted.push(id));

    fixture.nativeElement.querySelector('.row').click();

    expect(emitted).toEqual([]);
  });

  // --- "recording" row: the delete confirm must warn about discarding the
  // in-progress recording instead of showing the generic "Delete?" prompt.
  // Requires a new `recording = input(false)` on MeetingListItemComponent.

  it('shows the standard Delete? confirm for a non-recording row', () => {
    const fixture = TestBed.createComponent(MeetingListItemComponent);
    fixture.componentRef.setInput('meeting', meeting);
    fixture.componentRef.setInput('recording', false);
    fixture.detectChanges();

    fixture.nativeElement.querySelector('.delete').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.confirm-label').textContent).toBe('Delete?');
  });

  it('shows a stop-and-discard warning instead of Delete? when recording is true', () => {
    const fixture = TestBed.createComponent(MeetingListItemComponent);
    fixture.componentRef.setInput('meeting', meeting);
    fixture.componentRef.setInput('recording', true);
    fixture.detectChanges();

    fixture.nativeElement.querySelector('.delete').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.confirm-label').textContent).toBe(
      'Stop and discard this recording? The audio and transcript will be deleted.',
    );
  });

  it('emits deleteRequested on confirm while recording', () => {
    const fixture = TestBed.createComponent(MeetingListItemComponent);
    fixture.componentRef.setInput('meeting', meeting);
    fixture.componentRef.setInput('recording', true);
    fixture.detectChanges();
    const emitted: string[] = [];
    fixture.componentInstance.deleteRequested.subscribe((id) => emitted.push(id));

    fixture.nativeElement.querySelector('.delete').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('.confirm-yes').click();

    expect(emitted).toEqual(['m1']);
  });

  it('emits nothing on No, and on Escape, while recording', () => {
    const fixture = TestBed.createComponent(MeetingListItemComponent);
    fixture.componentRef.setInput('meeting', meeting);
    fixture.componentRef.setInput('recording', true);
    fixture.detectChanges();
    const emitted: string[] = [];
    fixture.componentInstance.deleteRequested.subscribe((id) => emitted.push(id));

    fixture.nativeElement.querySelector('.delete').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('.confirm-no').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.confirm')).toBeNull();
    expect(emitted).toEqual([]);

    fixture.nativeElement.querySelector('.delete').click();
    fixture.detectChanges();
    fixture.nativeElement
      .querySelector('.row')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.confirm')).toBeNull();
    expect(emitted).toEqual([]);
  });

  // --- "importing" row: generalizes the recording badge above — the same
  // warn-on-delete treatment, but for an in-flight audio import or
  // re-transcribe. Requires `importing = input(false)`.

  it('shows an Importing status badge while importing', () => {
    const fixture = TestBed.createComponent(MeetingListItemComponent);
    fixture.componentRef.setInput('meeting', meeting);
    fixture.componentRef.setInput('importing', true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.status-badge').textContent).toContain('Importing');
  });

  it('shows a cancel-import warning instead of Delete? when importing is true', () => {
    const fixture = TestBed.createComponent(MeetingListItemComponent);
    fixture.componentRef.setInput('meeting', meeting);
    fixture.componentRef.setInput('importing', true);
    fixture.detectChanges();

    fixture.nativeElement.querySelector('.delete').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.confirm-label').textContent).toBe(
      'Cancel this import? The partially imported audio and transcript will be deleted.',
    );
  });

  // --- Kebab (⋯) actions menu (archive + move to folder) coverage lives in
  // `meeting-list-item.component.actions-menu.spec.ts` — split out to keep
  // this file under the project's max-lines limit, mirroring
  // `meetings.facade.capture-defaults.spec.ts`.
});
