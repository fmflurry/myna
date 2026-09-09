import { afterEach, beforeEach, vi } from 'vitest';

import { TestBed } from '@angular/core/testing';

import { transcriptSegment } from '../../../application/testing/transcript-segment.factory';
import type { TranscriptSegment } from '../../../core/models/transcript.model';
import { LiveTranscriptComponent } from './live-transcript.component';

/**
 * Scroll-follow behaviour: the viewport keeps following new finals and
 * growing partials while it is at the bottom, stops the moment the user
 * scrolls up, and resumes once they return to the bottom. Split out of
 * `live-transcript.component.spec.ts` to stay under the max-lines limit.
 */
describe('LiveTranscriptComponent scroll follow', () => {
  const VIEWPORT_HEIGHT_PX = 200;
  const INITIAL_CONTENT_HEIGHT_PX = 500;

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

  /**
   * jsdom has no layout: `scrollHeight`/`clientHeight` are 0 and `scrollTop`
   * is an unclamped plain field. Give the container real-looking metrics and
   * a browser-like `scrollTop` that clamps to the bottom, so a follow lands on
   * `maxScrollTop()` exactly as it does on screen.
   */
  const installScrollMetrics = (container: HTMLElement) => {
    let scrollHeight = INITIAL_CONTENT_HEIGHT_PX;
    let scrollTop = 0;
    const maxScrollTop = (): number => scrollHeight - VIEWPORT_HEIGHT_PX;
    Object.defineProperty(container, 'clientHeight', { configurable: true, get: () => VIEWPORT_HEIGHT_PX });
    Object.defineProperty(container, 'scrollHeight', { configurable: true, get: () => scrollHeight });
    Object.defineProperty(container, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.max(0, Math.min(value, maxScrollTop()));
      },
    });
    return {
      maxScrollTop,
      /** New content rendered: the scrollable height grows, the viewport does not move. */
      growTo: (height: number): void => {
        scrollHeight = height;
      },
      /** Moves the viewport as the user would and dispatches the resulting `scroll` event. */
      userScrollTo: (top: number): void => {
        container.scrollTop = top;
        container.dispatchEvent(new Event('scroll'));
      },
    };
  };

  const segments = (count: number): TranscriptSegment[] =>
    Array.from({ length: count }, (_, index) =>
      transcriptSegment({ startSec: index, endSec: index + 1, text: `Sentence ${index}` }),
    );

  const createFixture = (finalizedSegments: TranscriptSegment[], partialTextMe = '') => {
    const fixture = TestBed.createComponent(LiveTranscriptComponent);
    fixture.componentRef.setInput('finalizedSegments', finalizedSegments);
    fixture.componentRef.setInput('partialTextMe', partialTextMe);
    fixture.componentRef.setInput('partialTextOthers', '');
    fixture.detectChanges();
    const container: HTMLElement = fixture.nativeElement.querySelector('.live-transcript');
    return { fixture, container, viewport: installScrollMetrics(container) };
  };

  const newerButton = (fixture: { nativeElement: HTMLElement }): HTMLButtonElement | null =>
    fixture.nativeElement.querySelector('[aria-label="Show newer transcript"]');

  it('follows each new final to the new bottom while the viewport is at the bottom', () => {
    const { fixture, container, viewport } = createFixture(segments(1));

    fixture.componentRef.setInput('finalizedSegments', segments(2));
    fixture.detectChanges();
    flushPendingFrames();
    expect(container.scrollTop).toBe(viewport.maxScrollTop());

    viewport.growTo(800);
    fixture.componentRef.setInput('finalizedSegments', segments(3));
    fixture.detectChanges();
    flushPendingFrames();
    expect(container.scrollTop).toBe(600);
  });

  it('stays pinned to the bottom while a live partial grows the container', () => {
    const { fixture, container, viewport } = createFixture(segments(1), 'and');

    viewport.growTo(530);
    fixture.componentRef.setInput('partialTextMe', 'and welcome to the');
    fixture.detectChanges();
    flushPendingFrames();
    expect(container.scrollTop).toBe(330);

    viewport.growTo(560);
    fixture.componentRef.setInput('partialTextMe', 'and welcome to the meeting, everyone');
    fixture.detectChanges();
    flushPendingFrames();
    expect(container.scrollTop).toBe(360);
  });

  it('leaves the viewport where the user scrolled up to when new content arrives', () => {
    const { fixture, container, viewport } = createFixture(segments(1));
    fixture.componentRef.setInput('finalizedSegments', segments(2));
    fixture.detectChanges();
    flushPendingFrames();
    expect(container.scrollTop).toBe(viewport.maxScrollTop());

    viewport.userScrollTo(100);
    fixture.detectChanges();

    viewport.growTo(560);
    fixture.componentRef.setInput('finalizedSegments', segments(3));
    fixture.detectChanges();
    flushPendingFrames();
    expect(container.scrollTop).toBe(100);
    expect(newerButton(fixture)).not.toBeNull();
  });

  it('resumes following once the user scrolls back to the bottom', () => {
    const { fixture, container, viewport } = createFixture(segments(1));

    viewport.userScrollTo(0);
    fixture.detectChanges();
    fixture.componentRef.setInput('finalizedSegments', segments(2));
    fixture.detectChanges();
    flushPendingFrames();
    expect(container.scrollTop).toBe(0);

    viewport.userScrollTo(viewport.maxScrollTop());
    fixture.detectChanges();
    expect(newerButton(fixture)).toBeNull();

    viewport.growTo(600);
    fixture.componentRef.setInput('finalizedSegments', segments(3));
    fixture.detectChanges();
    flushPendingFrames();
    expect(container.scrollTop).toBe(400);
  });

  /**
   * The browser dispatches the `scroll` event for the component's OWN
   * scroll-to-bottom one frame late. Streaming content that lands in between
   * makes that readback look "away from the bottom" even though the user
   * never touched the viewport — this must not stop the follow.
   */
  it('keeps following when its own scroll reads back late, after content already grew past the tolerance', () => {
    const { fixture, container, viewport } = createFixture(segments(1));
    fixture.componentRef.setInput('finalizedSegments', segments(2));
    fixture.detectChanges();
    flushPendingFrames();
    expect(container.scrollTop).toBe(viewport.maxScrollTop());

    viewport.growTo(560);
    fixture.componentRef.setInput('finalizedSegments', segments(3));
    fixture.detectChanges();
    // Late readback of the previous follow: the viewport has not moved, but is now 60 px from the bottom.
    container.dispatchEvent(new Event('scroll'));
    fixture.detectChanges();
    flushPendingFrames();

    expect(container.scrollTop).toBe(360);
    expect(newerButton(fixture)).toBeNull();
  });
});
