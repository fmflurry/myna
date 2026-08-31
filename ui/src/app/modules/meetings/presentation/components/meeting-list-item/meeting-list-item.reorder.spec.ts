import { TestBed } from '@angular/core/testing';

import type { Meeting } from '../../../core/models/meeting.model';
import { toMeetingId } from '../../../core/models/meeting.model';
import type { DropEdge } from '../../utils/reorder-geometry.util';
import { MeetingListItemComponent } from './meeting-list-item.component';

/**
 * RED spec for Phase 3 (manual reordering): `MeetingListItemComponent` grows
 * a new `dropIndicatorEnabled` input and `dropOnRow` output so a row itself
 * becomes a reorder drop target, showing a `.drop-before`/`.drop-after`
 * indicator resolved by the existing `resolveDropEdge` util.
 *
 * This DELIBERATELY reverses the "no `stopPropagation()`" rule that governs
 * `onDragStart`/`onDragEnd` (see `meeting-list-item.drag.spec.ts`): a row drop
 * already carries its container via the sidebar's own bookkeeping, so once
 * `dropIndicatorEnabled()` is true the row must own the `dragover`/`drop`
 * pair outright — including `stopPropagation()` — or a single drop would
 * double-fire the container's own (non-reorder) move handler. The
 * dragstart/dragend pair is untouched and still must not `stopPropagation`.
 *
 * Every indicator class assertion below reads `.row` — the same element
 * `meeting-list-item.drag.spec.ts` already dispatches `dragstart`/`dragend`
 * on — because the component's own template root has no separate host
 * wrapper independent of `.row`; the existing `[class.selected]`/
 * `[class.disabled]` bindings live there too, so `[class.drop-before]`/
 * `[class.drop-after]` are expected to follow the same convention.
 *
 * jsdom 25.0.1 has neither `DragEvent` nor `DataTransfer`, so every
 * dragover/drop/dragleave below is a bare `new Event(type, { bubbles,
 * cancelable })` — the same technique `meeting-list-item.drag.spec.ts` uses
 * for `dragstart`/`dragend` — with `clientY` attached via
 * `Object.defineProperty` since `Event` has no such property natively.
 */
describe('MeetingListItemComponent — row-level reorder drop target (Phase 3)', () => {
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

  const createFixture = (overrides: { dropIndicatorEnabled?: boolean } = {}) => {
    const fixture = TestBed.createComponent(MeetingListItemComponent);
    fixture.componentRef.setInput('meeting', meeting);
    fixture.componentRef.setInput('dropIndicatorEnabled', overrides.dropIndicatorEnabled ?? false);
    fixture.detectChanges();
    return fixture;
  };

  /** A fixed 40px-tall row starting at y=100 — midpoint (the before/after boundary) sits at clientY=120. */
  const stubRowRect = (rowEl: HTMLElement): void => {
    Object.defineProperty(rowEl, 'getBoundingClientRect', { value: () => ({ top: 100, height: 40 }) });
  };

  const dragOverEvent = (clientY: number): Event => {
    const event = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clientY', { value: clientY });
    return event;
  };

  it('dropIndicatorEnabled=false: dragover does not preventDefault, sets no indicator class, and still bubbles to an ancestor', () => {
    // Arrange
    const fixture = createFixture({ dropIndicatorEnabled: false });
    const rowEl = fixture.nativeElement.querySelector('.row') as HTMLElement;
    stubRowRect(rowEl);
    let bubbledToAncestor = false;
    fixture.nativeElement.addEventListener('dragover', () => {
      bubbledToAncestor = true;
    });
    const event = dragOverEvent(130);

    // Act
    rowEl.dispatchEvent(event);
    fixture.detectChanges();

    // Assert
    expect(event.defaultPrevented).toBe(false);
    expect(rowEl.classList.contains('drop-before')).toBe(false);
    expect(rowEl.classList.contains('drop-after')).toBe(false);
    expect(bubbledToAncestor).toBe(true);
  });

  it('enabled + clientY in the upper half of the row resolves the "before" indicator', () => {
    // Arrange
    const fixture = createFixture({ dropIndicatorEnabled: true });
    const rowEl = fixture.nativeElement.querySelector('.row') as HTMLElement;
    stubRowRect(rowEl);
    const event = dragOverEvent(110);

    // Act
    rowEl.dispatchEvent(event);
    fixture.detectChanges();

    // Assert
    expect(event.defaultPrevented).toBe(true);
    expect(rowEl.classList.contains('drop-before')).toBe(true);
    expect(rowEl.classList.contains('drop-after')).toBe(false);
  });

  it('enabled + clientY in the lower half of the row resolves the "after" indicator', () => {
    // Arrange
    const fixture = createFixture({ dropIndicatorEnabled: true });
    const rowEl = fixture.nativeElement.querySelector('.row') as HTMLElement;
    stubRowRect(rowEl);
    const event = dragOverEvent(130);

    // Act
    rowEl.dispatchEvent(event);
    fixture.detectChanges();

    // Assert
    expect(event.defaultPrevented).toBe(true);
    expect(rowEl.classList.contains('drop-after')).toBe(true);
    expect(rowEl.classList.contains('drop-before')).toBe(false);
  });

  it('drop emits dropOnRow with the currently hovered edge', () => {
    // Arrange
    const fixture = createFixture({ dropIndicatorEnabled: true });
    const rowEl = fixture.nativeElement.querySelector('.row') as HTMLElement;
    stubRowRect(rowEl);
    rowEl.dispatchEvent(dragOverEvent(130)); // hovers "after"
    fixture.detectChanges();
    const emitted: DropEdge[] = [];
    fixture.componentInstance.dropOnRow.subscribe((edge) => emitted.push(edge));
    const dropEvent = new Event('drop', { bubbles: true, cancelable: true });

    // Act
    rowEl.dispatchEvent(dropEvent);
    fixture.detectChanges();

    // Assert
    expect(dropEvent.defaultPrevented).toBe(true);
    expect(emitted).toEqual(['after']);
  });

  it('dragleave clears the indicator class', () => {
    // Arrange
    const fixture = createFixture({ dropIndicatorEnabled: true });
    const rowEl = fixture.nativeElement.querySelector('.row') as HTMLElement;
    stubRowRect(rowEl);
    rowEl.dispatchEvent(dragOverEvent(110));
    fixture.detectChanges();
    expect(rowEl.classList.contains('drop-before')).toBe(true);

    // Act
    rowEl.dispatchEvent(new Event('dragleave', { bubbles: true, cancelable: true }));
    fixture.detectChanges();

    // Assert
    expect(rowEl.classList.contains('drop-before')).toBe(false);
    expect(rowEl.classList.contains('drop-after')).toBe(false);
  });

  it('flipping dropIndicatorEnabled to false clears a stale indicator class without a dragleave', () => {
    // Arrange
    const fixture = createFixture({ dropIndicatorEnabled: true });
    const rowEl = fixture.nativeElement.querySelector('.row') as HTMLElement;
    stubRowRect(rowEl);
    rowEl.dispatchEvent(dragOverEvent(110));
    fixture.detectChanges();
    expect(rowEl.classList.contains('drop-before')).toBe(true);

    // Act
    fixture.componentRef.setInput('dropIndicatorEnabled', false);
    fixture.detectChanges();

    // Assert
    expect(rowEl.classList.contains('drop-before')).toBe(false);
    expect(rowEl.classList.contains('drop-after')).toBe(false);
  });
});
