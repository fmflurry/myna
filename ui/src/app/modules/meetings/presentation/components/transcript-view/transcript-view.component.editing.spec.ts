import { TestBed } from '@angular/core/testing';

import { transcriptSegment } from '../../../application/testing/transcript-segment.factory';
import { TranscriptViewComponent, type TranscriptSegmentEdit } from './transcript-view.component';

describe('TranscriptViewComponent — inline segment editing', () => {
  const createFixture = (editable?: boolean) => {
    const fixture = TestBed.createComponent(TranscriptViewComponent);
    fixture.componentRef.setInput('transcript', {
      segments: [
        transcriptSegment({ startSec: 0, endSec: 5, text: 'Welcome everyone' }),
        transcriptSegment({ startSec: 75, endSec: 80, text: 'Next topic' }),
      ],
    });
    if (editable !== undefined) {
      fixture.componentRef.setInput('editable', editable);
    }
    fixture.detectChanges();
    return fixture;
  };

  it('emits segmentEdited with the edited segment index, not always the first one', () => {
    const fixture = createFixture();
    const emitted: TranscriptSegmentEdit[] = [];
    fixture.componentInstance.segmentEdited.subscribe((edit) => emitted.push(edit));

    const triggers: HTMLButtonElement[] = Array.from(fixture.nativeElement.querySelectorAll('.segment-trigger'));
    expect(triggers.length).toBe(2);
    triggers[1]!.click();
    fixture.detectChanges();

    const textareas: HTMLTextAreaElement[] = Array.from(fixture.nativeElement.querySelectorAll('.segment-input'));
    expect(textareas.length).toBe(1);
    textareas[0]!.value = 'Next subject';
    textareas[0]!.dispatchEvent(new Event('input'));
    textareas[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();

    expect(emitted).toEqual([{ index: 1, text: 'Next subject' }]);
  });

  it('still renders mm:ss timestamps outside the editable segment', () => {
    const fixture = createFixture();

    const items: HTMLElement[] = Array.from(fixture.nativeElement.querySelectorAll('li'));
    expect(items[0]?.querySelector('.timestamp')?.textContent).toBe('00:00');
    expect(items[1]?.querySelector('.timestamp')?.textContent).toBe('01:15');
  });

  it('propagates editable=false to every segment, disabling the edit trigger for all of them', () => {
    const fixture = createFixture(false);

    expect(fixture.nativeElement.querySelectorAll('.segment-trigger').length).toBe(0);
    expect(fixture.nativeElement.querySelectorAll('.segment-text').length).toBe(2);
  });
});
