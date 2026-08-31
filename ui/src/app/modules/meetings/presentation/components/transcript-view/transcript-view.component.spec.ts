import { TestBed } from '@angular/core/testing';

import { transcriptSegment } from '../../../application/testing/transcript-segment.factory';
import { TranscriptViewComponent } from './transcript-view.component';

describe('TranscriptViewComponent', () => {
  it('renders each segment with an mm:ss timestamp', () => {
    const fixture = TestBed.createComponent(TranscriptViewComponent);
    fixture.componentRef.setInput('transcript', {
      segments: [
        transcriptSegment({ startSec: 0, endSec: 5, text: 'Welcome everyone' }),
        transcriptSegment({ startSec: 75, endSec: 80, text: 'Next topic' }),
      ],
    });
    fixture.detectChanges();

    const items: HTMLElement[] = Array.from(fixture.nativeElement.querySelectorAll('li'));
    expect(items.length).toBe(2);
    expect(items[0]?.querySelector('.timestamp')?.textContent).toBe('00:00');
    expect(items[1]?.querySelector('.timestamp')?.textContent).toBe('01:15');
  });

  it('shows an empty state when there is no transcript', () => {
    const fixture = TestBed.createComponent(TranscriptViewComponent);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.empty')).toBeTruthy();
  });

  it('renders no speaker chrome for an "unknown" segment, and a label + stable accent for a known one', () => {
    const fixture = TestBed.createComponent(TranscriptViewComponent);
    fixture.componentRef.setInput('transcript', {
      segments: [
        transcriptSegment({ startSec: 0, endSec: 5, text: 'No attribution', speaker: 'unknown' }),
        transcriptSegment({ startSec: 5, endSec: 10, text: 'Chiming in', speaker: 'others:7' }),
      ],
    });
    fixture.detectChanges();

    const items: HTMLElement[] = Array.from(fixture.nativeElement.querySelectorAll('li'));
    expect(items[0]?.querySelector('.speaker-label')).toBeNull();
    expect(items[1]?.querySelector('.speaker-label')?.textContent).toBe('Others 7');
  });
});
