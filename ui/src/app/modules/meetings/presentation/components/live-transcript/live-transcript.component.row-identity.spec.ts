import { afterEach, beforeEach, vi } from 'vitest';

import { TestBed } from '@angular/core/testing';

import { transcriptSegment } from '../../../application/testing/transcript-segment.factory';
import type { TranscriptSegment } from '../../../core/models/transcript.model';
import { LiveTranscriptComponent } from './live-transcript.component';

describe('LiveTranscriptComponent window-slide row identity', () => {
  /**
   * Deterministic rAF harness, same as live-transcript.component.spec.ts:
   * the component's afterRenderEffect schedules a real
   * requestAnimationFrame, which must be stubbed/flushed explicitly in this
   * Vitest/jsdom setup.
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

  /**
   * Perf/UX regression guard. `trackBySegment` currently keys on
   * `${index}:${segment.startSec}` (live-transcript.component.ts:210-212),
   * where `index` is the LOCAL `@for` position within the 250-row bounded
   * window (`visibleFinalizedSegments`, live-transcript.component.ts:78-82).
   * Sliding the window by one — the 251st finalized segment arrives — shifts
   * every still-visible segment's local index down by one, so Angular sees
   * a changed track key for EVERY visible row and destroys/recreates the
   * entire window instead of reusing the 249 `<p class="final">` rows that
   * are still logically present. This fails (RED) until `trackBySegment`
   * keys on segment identity (`startSec|endSec|speaker`) instead of the
   * local render index.
   */
  it('keeps the <p class="final"> DOM node for a segment that stays visible across a 250-row window slide', () => {
    const initial: TranscriptSegment[] = Array.from({ length: 250 }, (_, index) =>
      transcriptSegment({ startSec: index, endSec: index + 1, text: `Sentence ${index}` }),
    );
    const fixture = TestBed.createComponent(LiveTranscriptComponent);
    fixture.componentRef.setInput('finalizedSegments', initial);
    fixture.detectChanges();

    const rowsBefore: HTMLElement[] = Array.from(fixture.nativeElement.querySelectorAll('.final'));
    expect(rowsBefore.length).toBe(250);
    // Segment absolute index 125 ("Sentence 125") stays visible both before
    // and after the one-segment slide below — only the oldest segment (0)
    // drops out of the window.
    const trackedRowBefore = rowsBefore.find((row) => row.querySelector('.text')?.textContent === 'Sentence 125');
    expect(trackedRowBefore).toBeTruthy();

    fixture.componentRef.setInput('finalizedSegments', [
      ...initial,
      transcriptSegment({ startSec: 250, endSec: 251, text: 'Sentence 250' }),
    ]);
    fixture.detectChanges();

    const rowsAfter: HTMLElement[] = Array.from(fixture.nativeElement.querySelectorAll('.final'));
    expect(rowsAfter.length).toBe(250);
    const trackedRowAfter = rowsAfter.find((row) => row.querySelector('.text')?.textContent === 'Sentence 125');
    expect(trackedRowAfter).toBeTruthy();

    // Same logical segment, still visible after the slide — must be the
    // SAME DOM node instance, not a destroyed-and-recreated look-alike.
    expect(trackedRowAfter).toBe(trackedRowBefore);
  });
});
