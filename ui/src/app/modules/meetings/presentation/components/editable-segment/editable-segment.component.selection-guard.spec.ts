import { TestBed } from '@angular/core/testing';
import { afterEach } from 'vitest';

import { EditableSegmentComponent } from './editable-segment.component';

/**
 * A drag-select that ENDS on a segment's trigger button fires a trailing
 * `click` on it. Entering edit mode there would swap the text for a textarea
 * and destroy the selection — and with it the floating attribution toolbar —
 * before the user can act on it. The click is the tail of a selection, not
 * an intent to edit; a genuine click (collapsed or absent selection) must
 * still open the editor.
 */
describe('EditableSegmentComponent — drag-select guard', () => {
  const createFixture = (text: string, editable = true) => {
    const fixture = TestBed.createComponent(EditableSegmentComponent);
    fixture.componentRef.setInput('text', text);
    fixture.componentRef.setInput('editable', editable);
    fixture.detectChanges();
    document.body.appendChild(fixture.nativeElement);
    return fixture;
  };

  afterEach(() => {
    window.getSelection()?.removeAllRanges();
  });

  const selectInsideTrigger = (trigger: HTMLElement): void => {
    const node = document.createTreeWalker(trigger, NodeFilter.SHOW_TEXT).nextNode();
    if (node === null) {
      throw new Error('Trigger renders no text node');
    }
    const text = node as Text;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, text.data.length);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
  };

  it('stays in read mode when the click ends a non-collapsed selection anchored inside the trigger', () => {
    const fixture = createFixture('Welcome everyone');
    const trigger: HTMLElement = fixture.nativeElement.querySelector('.segment-trigger');
    selectInsideTrigger(trigger);

    trigger.click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.segment-input')).toBeNull();
    expect(fixture.nativeElement.querySelector('.segment-trigger')).not.toBeNull();
    fixture.nativeElement.remove();
  });

  it('opens the editor on a normal click while the selection is collapsed', () => {
    const fixture = createFixture('Welcome everyone');
    const trigger: HTMLElement = fixture.nativeElement.querySelector('.segment-trigger');
    const text = document.createTreeWalker(trigger, NodeFilter.SHOW_TEXT).nextNode() as Text;
    const range = document.createRange();
    range.setStart(text, 3);
    range.setEnd(text, 3);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);

    trigger.click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.segment-input')).not.toBeNull();
    fixture.nativeElement.remove();
  });

  it('opens the editor on a normal click when there is no selection at all', () => {
    const fixture = createFixture('Welcome everyone');
    const trigger: HTMLElement = fixture.nativeElement.querySelector('.segment-trigger');

    trigger.click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.segment-input')).not.toBeNull();
    fixture.nativeElement.remove();
  });
});
