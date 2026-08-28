import { TestBed } from '@angular/core/testing';

import type { Meeting } from '../../../core/models/meeting.model';
import { toMeetingId } from '../../../core/models/meeting.model';
import { MeetingSidebarComponent } from './meeting-sidebar.component';

describe('MeetingSidebarComponent', () => {
  const meetings: Meeting[] = [
    { id: toMeetingId('m1'), title: 'Standup', createdAt: new Date(2026, 7, 27, 14, 2), durationSec: 1920, summaries: [], archived: false, hasAudio: false },
    { id: toMeetingId('m2'), title: 'Client review', createdAt: new Date(2026, 7, 27, 11, 30), durationSec: 3480, summaries: [], archived: false, hasAudio: false },
    { id: toMeetingId('m3'), title: '1:1 Marie', createdAt: new Date(2026, 7, 26, 9, 0), durationSec: 1440, summaries: [], archived: true, hasAudio: false },
  ];

  const createFixture = () => {
    const fixture = TestBed.createComponent(MeetingSidebarComponent);
    fixture.componentRef.setInput('meetings', meetings);
    fixture.detectChanges();
    return fixture;
  };

  it('renders one row per unarchived meeting (the third fixture meeting is archived and hidden by default)', () => {
    const fixture = createFixture();

    expect(fixture.nativeElement.querySelectorAll('app-meeting-list-item').length).toBe(2);
  });

  it('shows an empty state when there are no meetings at all', () => {
    const fixture = TestBed.createComponent(MeetingSidebarComponent);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.empty-state')).toBeTruthy();
  });

  it('filters the list by title as the user types', () => {
    const fixture = createFixture();
    const input: HTMLInputElement = fixture.nativeElement.querySelector('input');

    input.value = 'client';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    const rows: HTMLElement[] = Array.from(fixture.nativeElement.querySelectorAll('app-meeting-list-item'));
    expect(rows.length).toBe(1);
  });

  it('shows a no-match message when the search excludes every meeting', () => {
    const fixture = createFixture();
    const input: HTMLInputElement = fixture.nativeElement.querySelector('input');

    input.value = 'nonexistent meeting name';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.no-match')).toBeTruthy();
  });

  it('forwards meetingSelected from a row', () => {
    const fixture = createFixture();
    const emitted: string[] = [];
    fixture.componentInstance.meetingSelected.subscribe((id) => emitted.push(id));

    fixture.nativeElement.querySelector('app-meeting-list-item .row').click();

    expect(emitted).toEqual(['m1']);
  });

  it('forwards meetingDeleted from a row', () => {
    const fixture = createFixture();
    const emitted: string[] = [];
    fixture.componentInstance.meetingDeleted.subscribe((id) => emitted.push(id));

    fixture.nativeElement.querySelector('app-meeting-list-item .delete').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('app-meeting-list-item .confirm-yes').click();

    expect(emitted).toEqual(['m1']);
  });

  it('forwards selectionDisabled down to every row instead of silently blocking selection', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('selectionDisabled', true);
    fixture.detectChanges();

    const rows: HTMLElement[] = Array.from(fixture.nativeElement.querySelectorAll('app-meeting-list-item .row'));
    expect(rows.length).toBe(2);
    expect(rows.every((row) => row.classList.contains('disabled'))).toBe(true);
  });

  // Requires a new `recordingMeetingId = input<MeetingId | undefined>(undefined)`
  // on MeetingSidebarComponent, forwarded as `[recording]` to the matching row
  // so its delete confirm shows the "stop and discard" warning instead of the
  // generic "Delete?" prompt.
  it('marks only the row whose id matches recordingMeetingId as recording', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('recordingMeetingId', toMeetingId('m2'));
    fixture.detectChanges();

    // Only 2 of the 3 fixture meetings are active — the third is archived and hidden by default.
    const rows: HTMLElement[] = Array.from(fixture.nativeElement.querySelectorAll('app-meeting-list-item'));
    expect(rows.length).toBe(2);

    (rows[0]!.querySelector('.delete') as HTMLElement).click();
    fixture.detectChanges();
    expect(rows[0]!.querySelector('.confirm-label')!.textContent).toBe('Delete?');
    (rows[0]!.querySelector('.confirm-no') as HTMLElement).click();
    fixture.detectChanges();

    (rows[1]!.querySelector('.delete') as HTMLElement).click();
    fixture.detectChanges();
    expect(rows[1]!.querySelector('.confirm-label')!.textContent).toBe(
      'Stop and discard this recording? The audio and transcript will be deleted.',
    );
  });

  // --- archive disclosure: a collapsible "Archive (N)" section, sibling to
  // (never nested inside) the main listbox. Requires `activeMeetings` /
  // `archivedMeetings` / `archiveExpanded` computed signals and a
  // `meetingArchiveToggled` output forwarded from each row.

  it('shows no archive section when nothing is archived', () => {
    const fixture = TestBed.createComponent(MeetingSidebarComponent);
    fixture.componentRef.setInput('meetings', [
      { id: toMeetingId('a1'), title: 'Only one', createdAt: new Date(2026, 7, 27), durationSec: 60, summaries: [], archived: false, hasAudio: false },
    ]);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('section.archive')).toBeNull();
  });

  it('renders a collapsed "Archive (1)" disclosure by default', () => {
    const fixture = createFixture();

    const toggle: HTMLElement = fixture.nativeElement.querySelector('.archive-toggle');
    expect(toggle.textContent).toContain('Archive (1)');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(fixture.nativeElement.querySelector('#archived-meetings')).toBeNull();
  });

  it('reveals the archived listbox when the disclosure toggle is clicked', () => {
    const fixture = createFixture();

    fixture.nativeElement.querySelector('.archive-toggle').click();
    fixture.detectChanges();

    const archivedList = fixture.nativeElement.querySelector('#archived-meetings');
    expect(archivedList).toBeTruthy();
    expect(archivedList.querySelectorAll('app-meeting-list-item').length).toBe(1);
    expect(fixture.nativeElement.querySelector('.archive-toggle').getAttribute('aria-expanded')).toBe('true');
  });

  it('auto-expands the archive disclosure (without a click) when a search matches only an archived meeting', () => {
    const fixture = createFixture();
    const input: HTMLInputElement = fixture.nativeElement.querySelector('input');

    input.value = 'marie';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('#archived-meetings')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.no-match')).toBeNull();
    expect(fixture.nativeElement.querySelectorAll('.list[aria-label="Meetings"] app-meeting-list-item').length).toBe(0);
  });

  it('shows no-match, and no archive section, when the search matches neither active nor archived meetings', () => {
    const fixture = createFixture();
    const input: HTMLInputElement = fixture.nativeElement.querySelector('input');

    input.value = 'nonexistent meeting name';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.no-match')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('section.archive')).toBeNull();
  });

  it('forwards meetingArchiveToggled from a row', () => {
    const fixture = createFixture();
    const emitted: { id: string; archived: boolean }[] = [];
    fixture.componentInstance.meetingArchiveToggled.subscribe((request) => emitted.push(request));

    fixture.nativeElement.querySelector('app-meeting-list-item .archive').click();

    expect(emitted).toEqual([{ id: 'm1', archived: true }]);
  });
});
