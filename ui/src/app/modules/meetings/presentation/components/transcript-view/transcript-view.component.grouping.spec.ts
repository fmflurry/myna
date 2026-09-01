import { TestBed } from '@angular/core/testing';

import { transcriptSegment } from '../../../application/testing/transcript-segment.factory';
import { TranscriptViewComponent, type TranscriptSegmentEdit } from './transcript-view.component';

describe('TranscriptViewComponent — grouped rendering of consecutive same-speaker segments', () => {
  const createFixture = () => {
    const fixture = TestBed.createComponent(TranscriptViewComponent);
    fixture.componentRef.setInput('transcript', {
      segments: Array.from({ length: 7 }, (_, index) =>
        transcriptSegment({ startSec: index * 5, endSec: index * 5 + 5, text: `Line ${index}`, speaker: 'others:1' }),
      ),
    });
    fixture.detectChanges();
    return fixture;
  };

  it('renders exactly one timestamp and one speaker chip for the whole group', () => {
    const fixture = createFixture();

    expect(fixture.nativeElement.querySelectorAll('.timestamp').length).toBe(1);
    expect(fixture.nativeElement.querySelectorAll('.speaker-chip').length).toBe(1);
  });

  it('uses the FIRST segment startSec as the group timestamp', () => {
    const fixture = createFixture();

    const timestamp: HTMLElement = fixture.nativeElement.querySelector('.timestamp');
    expect(timestamp.textContent).toBe('00:00');
  });

  it('still renders one editable segment trigger per underlying segment', () => {
    const fixture = createFixture();

    expect(fixture.nativeElement.querySelectorAll('.segment-trigger').length).toBe(7);
  });

  it('emits the ABSOLUTE index when editing the 5th line within the group', () => {
    const fixture = createFixture();
    const emitted: TranscriptSegmentEdit[] = [];
    fixture.componentInstance.segmentEdited.subscribe((edit) => emitted.push(edit));

    const triggers: HTMLButtonElement[] = Array.from(fixture.nativeElement.querySelectorAll('.segment-trigger'));
    triggers[4]!.click();
    fixture.detectChanges();

    const textareas: HTMLTextAreaElement[] = Array.from(fixture.nativeElement.querySelectorAll('.segment-input'));
    expect(textareas.length).toBe(1);
    textareas[0]!.value = 'Edited fifth line';
    textareas[0]!.dispatchEvent(new Event('input'));
    textareas[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();

    expect(emitted).toEqual([{ index: 4, text: 'Edited fifth line' }]);
  });
});
