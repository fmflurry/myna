import { TestBed } from '@angular/core/testing';

import type { TranscriptSegment } from '../../../core/models/transcript.model';
import { LiveTranscriptComponent } from './live-transcript.component';

describe('LiveTranscriptComponent', () => {
  const createFixture = (finalizedSegments: TranscriptSegment[], partialText = '') => {
    const fixture = TestBed.createComponent(LiveTranscriptComponent);
    fixture.componentRef.setInput('finalizedSegments', finalizedSegments);
    fixture.componentRef.setInput('partialText', partialText);
    fixture.detectChanges();
    return fixture;
  };

  it('renders finalized segments with an mm:ss timestamp gutter and the text', () => {
    const fixture = createFixture([{ startSec: 65, endSec: 67, text: 'Hello team' }]);

    const finals = fixture.nativeElement.querySelectorAll('.final');
    expect(finals.length).toBe(1);
    expect(finals[0].querySelector('.timestamp').textContent).toBe('01:05');
    expect(finals[0].querySelector('.text').textContent).toBe('Hello team');
  });

  it('renders the trailing partial in a visually distinct style, using the same layout as a final', () => {
    const fixture = createFixture(
      [{ startSec: 0, endSec: 2, text: 'Hello team' }],
      'and welcome',
    );

    const partial = fixture.nativeElement.querySelector('.partial');
    expect(partial.querySelector('.text').textContent).toBe('and welcome');
    expect(fixture.nativeElement.querySelectorAll('.final').length).toBe(1);
  });

  it('renders a real segment whose startSec equals its endSec as finalized, not partial', () => {
    // Regression guard for the removed startSec===endSec sentinel hack: a
    // genuine zero-duration final segment must never be misread as partial.
    const fixture = createFixture([{ startSec: 3, endSec: 3, text: 'Quick aside' }]);

    expect(fixture.nativeElement.querySelectorAll('.final').length).toBe(1);
    expect(fixture.nativeElement.querySelector('.partial')).toBeNull();
  });

  it('shows a listening placeholder when there is nothing yet', () => {
    const fixture = createFixture([]);

    expect(fixture.nativeElement.querySelector('.empty')).toBeTruthy();
  });

  it('auto-scrolls the viewport to the bottom when new content renders', () => {
    const fixture = createFixture([{ startSec: 0, endSec: 1, text: 'One' }]);
    const container: HTMLElement = fixture.nativeElement.querySelector('.live-transcript');
    Object.defineProperty(container, 'scrollHeight', { value: 500, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 200, configurable: true });

    fixture.componentRef.setInput('finalizedSegments', [
      { startSec: 0, endSec: 1, text: 'One' },
      { startSec: 1, endSec: 2, text: 'Two' },
    ]);
    fixture.detectChanges();

    expect(container.scrollTop).toBe(500);
  });

  it('stops auto-scrolling once the user has scrolled away from the bottom', () => {
    const fixture = createFixture([{ startSec: 0, endSec: 1, text: 'One' }]);
    const container: HTMLElement = fixture.nativeElement.querySelector('.live-transcript');
    Object.defineProperty(container, 'scrollHeight', { value: 500, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(container, 'scrollTop', { value: 0, configurable: true, writable: true });

    container.dispatchEvent(new Event('scroll'));
    fixture.detectChanges();

    fixture.componentRef.setInput('finalizedSegments', [
      { startSec: 0, endSec: 1, text: 'One' },
      { startSec: 1, endSec: 2, text: 'Two' },
    ]);
    fixture.detectChanges();

    expect(container.scrollTop).toBe(0);
  });

  /**
   * Load-bearing requirement: "it doesn't show all sentences I pronounce" was
   * the user's most severe, most repeated complaint. This drives 20 finals in
   * sequence, interleaved with a stream of provisional partials, and asserts
   * every final remains present, in order, untouched — only the trailing
   * provisional line ever changes.
   */
  it('keeps all 20 sequential finals present, in order and unmutated, across a stream of partials', () => {
    const fixture = createFixture([]);
    const finals: TranscriptSegment[] = [];

    for (let i = 0; i < 20; i += 1) {
      // A partial arrives before each final is confirmed — it must never
      // displace or reorder any already-finalized segment.
      fixture.componentRef.setInput('partialText', `partial in progress ${i}`);
      fixture.detectChanges();

      finals.push({ startSec: i, endSec: i + 1, text: `Sentence number ${i}` });
      fixture.componentRef.setInput('finalizedSegments', [...finals]);
      fixture.componentRef.setInput('partialText', '');
      fixture.detectChanges();

      const renderedFinals: HTMLElement[] = Array.from(fixture.nativeElement.querySelectorAll('.final .text'));
      expect(renderedFinals.length).toBe(i + 1);
      expect(renderedFinals.map((el) => el.textContent)).toEqual(finals.map((segment) => segment.text));
    }

    // One last trailing partial after all 20 finals: the finals must be
    // completely unaffected, only the trailing provisional line changes.
    fixture.componentRef.setInput('partialText', 'still speaking');
    fixture.detectChanges();

    const renderedFinals: HTMLElement[] = Array.from(fixture.nativeElement.querySelectorAll('.final .text'));
    expect(renderedFinals.length).toBe(20);
    expect(renderedFinals.map((el) => el.textContent)).toEqual(finals.map((segment) => segment.text));
    expect(fixture.nativeElement.querySelector('.partial .text').textContent).toBe('still speaking');
  });
});
