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
    hasAudio: false,
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

  // --- archive control: a reversible per-row toggle, no confirmation step.
  // Requires `archiveToggleRequested = output<MeetingArchiveRequest>()` and
  // an `.archive` button rendered next to `.delete`.

  it('emits archiveToggleRequested with archived:true for an unarchived meeting', () => {
    const fixture = createFixture();
    const emitted: { id: string; archived: boolean }[] = [];
    fixture.componentInstance.archiveToggleRequested.subscribe((request) => emitted.push(request));

    fixture.nativeElement.querySelector('.archive').click();

    expect(emitted).toEqual([{ id: 'm1', archived: true }]);
  });

  it('emits archiveToggleRequested with archived:false for an already-archived meeting', () => {
    const fixture = TestBed.createComponent(MeetingListItemComponent);
    fixture.componentRef.setInput('meeting', { ...meeting, archived: true });
    fixture.detectChanges();
    const emitted: { id: string; archived: boolean }[] = [];
    fixture.componentInstance.archiveToggleRequested.subscribe((request) => emitted.push(request));

    fixture.nativeElement.querySelector('.archive').click();

    expect(emitted).toEqual([{ id: 'm1', archived: false }]);
  });

  it('does not emit opened when the archive button is clicked', () => {
    const fixture = createFixture();
    const openedEmitted: string[] = [];
    fixture.componentInstance.opened.subscribe((id) => openedEmitted.push(id));

    fixture.nativeElement.querySelector('.archive').click();

    expect(openedEmitted.length).toBe(0);
  });

  it('hides the archive control while the row is recording', () => {
    const fixture = TestBed.createComponent(MeetingListItemComponent);
    fixture.componentRef.setInput('meeting', meeting);
    fixture.componentRef.setInput('recording', true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.archive')).toBeNull();
  });

  it('flips the archive button label to Unarchive meeting for an archived row', () => {
    const fixture = TestBed.createComponent(MeetingListItemComponent);
    fixture.componentRef.setInput('meeting', { ...meeting, archived: true });
    fixture.detectChanges();

    const button: HTMLElement = fixture.nativeElement.querySelector('.archive');
    expect(button.getAttribute('aria-label')).toBe('Unarchive meeting');
  });

  it('labels the archive button Archive meeting for an unarchived row', () => {
    const fixture = createFixture();

    const button: HTMLElement = fixture.nativeElement.querySelector('.archive');
    expect(button.getAttribute('aria-label')).toBe('Archive meeting');
  });
});
