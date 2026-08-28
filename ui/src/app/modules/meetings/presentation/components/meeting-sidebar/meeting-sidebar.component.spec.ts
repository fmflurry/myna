import { TestBed } from '@angular/core/testing';

import type { Meeting } from '../../../core/models/meeting.model';
import { toMeetingId } from '../../../core/models/meeting.model';
import { MeetingSidebarComponent } from './meeting-sidebar.component';

describe('MeetingSidebarComponent', () => {
  const meetings: Meeting[] = [
    { id: toMeetingId('m1'), title: 'Standup', createdAt: new Date(2026, 7, 27, 14, 2), durationSec: 1920, summaries: [] },
    { id: toMeetingId('m2'), title: 'Client review', createdAt: new Date(2026, 7, 27, 11, 30), durationSec: 3480, summaries: [] },
    { id: toMeetingId('m3'), title: '1:1 Marie', createdAt: new Date(2026, 7, 26, 9, 0), durationSec: 1440, summaries: [] },
  ];

  const createFixture = () => {
    const fixture = TestBed.createComponent(MeetingSidebarComponent);
    fixture.componentRef.setInput('meetings', meetings);
    fixture.detectChanges();
    return fixture;
  };

  it('renders one row per meeting', () => {
    const fixture = createFixture();

    expect(fixture.nativeElement.querySelectorAll('app-meeting-list-item').length).toBe(3);
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
    expect(rows.length).toBe(3);
    expect(rows.every((row) => row.classList.contains('disabled'))).toBe(true);
  });
});
