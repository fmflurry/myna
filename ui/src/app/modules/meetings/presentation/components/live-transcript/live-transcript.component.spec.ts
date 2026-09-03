import { afterEach, beforeEach, vi } from 'vitest';

import { TestBed } from '@angular/core/testing';

import { transcriptSegment } from '../../../application/testing/transcript-segment.factory';
import type { TranscriptSegment } from '../../../core/models/transcript.model';
import { LiveTranscriptComponent } from './live-transcript.component';

describe('LiveTranscriptComponent', () => {
  /**
   * Deterministic rAF harness. The component must coalesce auto-scrolls into
   * at most ONE layout read per animation frame, so specs capture frames via
   * `vi.stubGlobal` and flush them explicitly — `fakeAsync`/`tick` are off
   * limits in this Vitest/jsdom setup (ProxyZone failures).
   */
  const frames = new Map<number, FrameRequestCallback>();
  let frameSeq = 0;

  beforeEach(() => {
    frames.clear();
    frameSeq = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frameSeq += 1;
      frames.set(frameSeq, callback);
      return frameSeq;
    });
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
      frames.delete(handle);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Runs every queued frame callback once, as the browser would on the next vsync. */
  const flushPendingFrames = (): void => {
    const pending = Array.from(frames.values());
    frames.clear();
    for (const callback of pending) {
      callback(performance.now());
    }
  };

  const createFixture = (
    finalizedSegments: TranscriptSegment[],
    partialTextMe = '',
    partialTextOthers = '',
  ) => {
    const fixture = TestBed.createComponent(LiveTranscriptComponent);
    fixture.componentRef.setInput('finalizedSegments', finalizedSegments);
    fixture.componentRef.setInput('partialTextMe', partialTextMe);
    fixture.componentRef.setInput('partialTextOthers', partialTextOthers);
    fixture.detectChanges();
    return fixture;
  };

  it('renders finalized segments with an mm:ss timestamp gutter and the text', () => {
    const fixture = createFixture([transcriptSegment({ startSec: 65, endSec: 67, text: 'Hello team' })]);

    const finals = fixture.nativeElement.querySelectorAll('.final');
    expect(finals.length).toBe(1);
    expect(finals[0].querySelector('.timestamp').textContent).toBe('01:05');
    expect(finals[0].querySelector('.text').textContent).toBe('Hello team');
  });

  it('renders the trailing "me" partial in a visually distinct style, using the same layout as a final', () => {
    const fixture = createFixture(
      [transcriptSegment({ startSec: 0, endSec: 2, text: 'Hello team' })],
      'and welcome',
    );

    const partial = fixture.nativeElement.querySelector('.partial');
    expect(partial.querySelector('.text').textContent).toBe('and welcome');
    expect(fixture.nativeElement.querySelectorAll('.final').length).toBe(1);
  });

  it('renders a real segment whose startSec equals its endSec as finalized, not partial', () => {
    // Regression guard for the removed startSec===endSec sentinel hack: a
    // genuine zero-duration final segment must never be misread as partial.
    const fixture = createFixture([transcriptSegment({ startSec: 3, endSec: 3, text: 'Quick aside' })]);

    expect(fixture.nativeElement.querySelectorAll('.final').length).toBe(1);
    expect(fixture.nativeElement.querySelector('.partial')).toBeNull();
  });

  it('shows a listening placeholder when there is nothing yet', () => {
    const fixture = createFixture([]);

    expect(fixture.nativeElement.querySelector('.empty')).toBeTruthy();
  });

  it('renders an "unknown" segment with no speaker chrome at all, exactly as before per-speaker attribution existed', () => {
    const fixture = createFixture([transcriptSegment({ startSec: 0, endSec: 1, text: 'No attribution here', speaker: 'unknown' })]);

    const final = fixture.nativeElement.querySelector('.final');
    expect(final.querySelector('.speaker-label')).toBeNull();
    expect(final.querySelector('.text').textContent).toBe('No attribution here');
  });

  it('renders an unseen speaker label (forward-compat for future per-speaker diarization) with a stable accent and no crash', () => {
    const fixture = createFixture([transcriptSegment({ startSec: 0, endSec: 1, text: 'Chiming in', speaker: 'others:7' })]);

    const label = fixture.nativeElement.querySelector('.final .speaker-label');
    expect(label.textContent).toBe('Others 7');
    const accentClass = Array.from(label.classList as DOMTokenList).find((cls) => /^speaker-accent-\d+$/.test(cls as string));
    expect(accentClass).toBeTruthy();

    // Re-rendering the SAME label resolves to the SAME accent class every time.
    const fixture2 = createFixture([transcriptSegment({ startSec: 0, endSec: 1, text: 'Chiming in', speaker: 'others:7' })]);
    const label2 = fixture2.nativeElement.querySelector('.final .speaker-label');
    expect(label2.className).toBe(label.className);
  });

  it('renders "Me" and "Others" chrome for the two bounded live-partial slots', () => {
    const fixture = createFixture([], 'I think we should', 'actually I disagree');

    const partials: HTMLElement[] = Array.from(fixture.nativeElement.querySelectorAll('.partial'));
    expect(partials.length).toBe(2);
    expect(partials[0]?.querySelector('.speaker-label')?.textContent).toBe('Me');
    expect(partials[0]?.querySelector('.text')?.textContent).toBe('I think we should');
    expect(partials[1]?.querySelector('.speaker-label')?.textContent).toBe('Others');
    expect(partials[1]?.querySelector('.text')?.textContent).toBe('actually I disagree');
  });

  it('auto-scrolls the viewport to the bottom when new content renders', () => {
    const fixture = createFixture([transcriptSegment({ startSec: 0, endSec: 1, text: 'One' })]);
    const container: HTMLElement = fixture.nativeElement.querySelector('.live-transcript');
    Object.defineProperty(container, 'scrollHeight', { value: 500, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 200, configurable: true });

    fixture.componentRef.setInput('finalizedSegments', [
      transcriptSegment({ startSec: 0, endSec: 1, text: 'One' }),
      transcriptSegment({ startSec: 1, endSec: 2, text: 'Two' }),
    ]);
    fixture.detectChanges();
    flushPendingFrames();

    expect(container.scrollTop).toBe(500);
  });

  it('stops auto-scrolling once the user has scrolled away from the bottom', () => {
    const fixture = createFixture([transcriptSegment({ startSec: 0, endSec: 1, text: 'One' })]);
    const container: HTMLElement = fixture.nativeElement.querySelector('.live-transcript');
    Object.defineProperty(container, 'scrollHeight', { value: 500, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(container, 'scrollTop', { value: 0, configurable: true, writable: true });

    container.dispatchEvent(new Event('scroll'));
    fixture.detectChanges();

    fixture.componentRef.setInput('finalizedSegments', [
      transcriptSegment({ startSec: 0, endSec: 1, text: 'One' }),
      transcriptSegment({ startSec: 1, endSec: 2, text: 'Two' }),
    ]);
    fixture.detectChanges();
    flushPendingFrames();

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
      fixture.componentRef.setInput('partialTextMe', `partial in progress ${i}`);
      fixture.detectChanges();

      finals.push(transcriptSegment({ startSec: i, endSec: i + 1, text: `Sentence number ${i}` }));
      fixture.componentRef.setInput('finalizedSegments', [...finals]);
      fixture.componentRef.setInput('partialTextMe', '');
      fixture.detectChanges();

      const renderedFinals: HTMLElement[] = Array.from(fixture.nativeElement.querySelectorAll('.final .text'));
      expect(renderedFinals.length).toBe(i + 1);
      expect(renderedFinals.map((el) => el.textContent)).toEqual(finals.map((segment) => segment.text));
    }

    // One last trailing partial after all 20 finals: the finals must be
    // completely unaffected, only the trailing provisional line changes.
    fixture.componentRef.setInput('partialTextMe', 'still speaking');
    fixture.detectChanges();

    const renderedFinals: HTMLElement[] = Array.from(fixture.nativeElement.querySelectorAll('.final .text'));
    expect(renderedFinals.length).toBe(20);
    expect(renderedFinals.map((el) => el.textContent)).toEqual(finals.map((segment) => segment.text));
    expect(fixture.nativeElement.querySelector('.partial .text').textContent).toBe('still speaking');
  });

  /**
   * Phase 5 render-cost bound: partials arrive at streaming rate, so a burst
   * of updates landing inside ONE frame must produce at most ONE `scrollHeight`
   * layout read — not one per update. Before the rAF coalescing fix the
   * afterRenderEffect read `scrollHeight` synchronously on every update, so
   * the zero-read assertion below fails (RED) against the old code.
   */
  it('coalesces a burst of streaming updates into at most one scrollHeight read per animation frame', () => {
    const finals = Array.from({ length: 2000 }, (_, index) =>
      transcriptSegment({ startSec: index, endSec: index + 1, text: `Sentence number ${index}` }),
    );
    const fixture = createFixture(finals);
    const container: HTMLElement = fixture.nativeElement.querySelector('.live-transcript');
    let scrollHeightReads = 0;
    Object.defineProperty(container, 'scrollHeight', {
      configurable: true,
      get: () => {
        scrollHeightReads += 1;
        return 500;
      },
    });

    for (let i = 0; i < 5; i += 1) {
      fixture.componentRef.setInput('partialTextMe', `partial ${i}`);
      fixture.detectChanges();
    }
    // Scheduling must not touch layout: the reads happen only inside the frame.
    expect(scrollHeightReads).toBe(0);

    flushPendingFrames();
    expect(scrollHeightReads).toBeLessThanOrEqual(1);
    // The single coalesced read still follows the stream to the bottom.
    expect(container.scrollTop).toBe(500);
  });

  /** A frame queued just before teardown must never run against a destroyed view. */
  it('cancels the pending auto-scroll frame when the component is destroyed', () => {
    const fixture = createFixture([transcriptSegment({ startSec: 0, endSec: 1, text: 'One' })]);
    const container: HTMLElement = fixture.nativeElement.querySelector('.live-transcript');
    let scrollHeightReads = 0;
    Object.defineProperty(container, 'scrollHeight', {
      configurable: true,
      get: () => {
        scrollHeightReads += 1;
        return 500;
      },
    });

    fixture.componentRef.setInput('partialTextMe', 'speaking');
    fixture.detectChanges();
    // Exactly one frame is queued: the component's coalesced auto-scroll.
    expect(frames.size).toBe(1);

    // Destroy must cancel the pending frame. Angular's own teardown also
    // schedules/cancels rAF handles, so assert via the queue, not the raw
    // cancel-call list: if the component leaked, its frame would still be
    // queued here.
    fixture.destroy();
    expect(frames.size).toBe(0);

    flushPendingFrames();
    expect(scrollHeightReads).toBe(0);
  });
});
