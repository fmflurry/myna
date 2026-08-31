import { TestBed } from '@angular/core/testing';

import type { Meeting } from '../../../core/models/meeting.model';
import { toMeetingId } from '../../../core/models/meeting.model';
import { MeetingListItemComponent } from './meeting-list-item.component';

/**
 * RED spec for the drag-and-drop meeting move: a new `dragEnabled` input
 * plus `dragStarted`/`dragEnded` outputs on `MeetingListItemComponent`.
 *
 * jsdom 25.0.1 has neither `DragEvent` nor `DataTransfer` (both probe as
 * `undefined`), so a real drag gesture cannot be constructed here. Instead
 * every test dispatches a bare `new Event(type, { bubbles, cancelable })` —
 * Angular binds `(dragstart)`/`(dragend)` via plain `addEventListener`, so
 * the handlers fire regardless of the event's real subtype, and
 * `preventDefault()`/`defaultPrevented` both work correctly on a plain
 * `Event`. The dragged id is carried in a signal on `MeetingSidebarComponent`
 * (see `meeting-sidebar.component.drag.spec.ts`), never in `DataTransfer` —
 * nothing here reads `getData`.
 */
const dragEvent = (type: string): Event => new Event(type, { bubbles: true, cancelable: true });

describe('MeetingListItemComponent — drag source', () => {
  const meeting: Meeting = {
    id: toMeetingId('m1'),
    title: 'Standup',
    createdAt: new Date(2026, 7, 27, 14, 2),
    durationSec: 32 * 60,
    summaries: [],
    archived: false,
    hasAudio: false,
    hasSystemTrack: false,
    droppedAudioChunks: 0,
  };

  const createFixture = (
    overrides: {
      dragEnabled?: boolean;
      recording?: boolean;
      importing?: boolean;
      disabled?: boolean;
    } = {},
  ) => {
    const fixture = TestBed.createComponent(MeetingListItemComponent);
    fixture.componentRef.setInput('meeting', meeting);
    fixture.componentRef.setInput('dragEnabled', overrides.dragEnabled ?? true);
    fixture.componentRef.setInput('recording', overrides.recording ?? false);
    fixture.componentRef.setInput('importing', overrides.importing ?? false);
    fixture.componentRef.setInput('disabled', overrides.disabled ?? false);
    fixture.detectChanges();
    return fixture;
  };

  it('renders draggable="true" only once dragEnabled is set; the default (unset) is not draggable', () => {
    // Arrange / Act
    const fixture = TestBed.createComponent(MeetingListItemComponent);
    fixture.componentRef.setInput('meeting', meeting);
    fixture.detectChanges();

    // Assert — default input value is false, row is not draggable.
    expect(fixture.nativeElement.querySelector('.row').getAttribute('draggable')).toBeNull();

    // Act
    fixture.componentRef.setInput('dragEnabled', true);
    fixture.detectChanges();

    // Assert
    expect(fixture.nativeElement.querySelector('.row').getAttribute('draggable')).toBe('true');
  });

  it('emits dragStarted with the meeting id on dragstart', () => {
    // Arrange
    const fixture = createFixture();
    const emitted: string[] = [];
    fixture.componentInstance.dragStarted.subscribe((id) => emitted.push(id));

    // Act
    fixture.nativeElement.querySelector('.row').dispatchEvent(dragEvent('dragstart'));

    // Assert
    expect(emitted).toEqual(['m1']);
  });

  it('cancels the drag and emits nothing while recording', () => {
    // Arrange
    const fixture = createFixture({ recording: true });
    const emitted: string[] = [];
    fixture.componentInstance.dragStarted.subscribe((id) => emitted.push(id));
    const event = dragEvent('dragstart');

    // Act
    fixture.nativeElement.querySelector('.row').dispatchEvent(event);

    // Assert
    expect(emitted).toEqual([]);
    expect(event.defaultPrevented).toBe(true);
  });

  it('cancels the drag and emits nothing while importing', () => {
    // Arrange
    const fixture = createFixture({ importing: true });
    const emitted: string[] = [];
    fixture.componentInstance.dragStarted.subscribe((id) => emitted.push(id));
    const event = dragEvent('dragstart');

    // Act
    fixture.nativeElement.querySelector('.row').dispatchEvent(event);

    // Assert
    expect(emitted).toEqual([]);
    expect(event.defaultPrevented).toBe(true);
  });

  it('cancels the drag and emits nothing mid delete-confirm', () => {
    // Arrange
    const fixture = createFixture();
    fixture.nativeElement.querySelector('.delete').click();
    fixture.detectChanges();
    const emitted: string[] = [];
    fixture.componentInstance.dragStarted.subscribe((id) => emitted.push(id));
    const event = dragEvent('dragstart');

    // Act
    fixture.nativeElement.querySelector('.row').dispatchEvent(event);

    // Assert
    expect(emitted).toEqual([]);
    expect(event.defaultPrevented).toBe(true);
  });

  it('still emits dragStarted while disabled — disabled only blocks selection, and the archive button already stays usable during a recording, so drag must not contradict it', () => {
    // Arrange
    const fixture = createFixture({ disabled: true });
    const emitted: string[] = [];
    fixture.componentInstance.dragStarted.subscribe((id) => emitted.push(id));

    // Act
    fixture.nativeElement.querySelector('.row').dispatchEvent(dragEvent('dragstart'));

    // Assert
    expect(emitted).toEqual(['m1']);
  });

  it('emits dragEnded on dragend', () => {
    // Arrange
    const fixture = createFixture();
    let emitCount = 0;
    fixture.componentInstance.dragEnded.subscribe(() => {
      emitCount += 1;
    });

    // Act
    fixture.nativeElement.querySelector('.row').dispatchEvent(dragEvent('dragend'));

    // Assert
    expect(emitCount).toBe(1);
  });
});
