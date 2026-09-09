import { afterEach, beforeEach, vi } from 'vitest';

import { TestBed } from '@angular/core/testing';

import { transcriptSegment } from '../../../application/testing/transcript-segment.factory';
import type { TranscriptSegment } from '../../../core/models/transcript.model';
import { LiveTranscriptComponent } from './live-transcript.component';

/**
 * Live flags + inline editing: suspect/edited badges and the `editableLive`
 * inline-editor switch. Split into its own file to keep
 * `live-transcript.component.spec.ts` under the project's max-lines limit
 * (same pattern as the other `*.component.*.spec.ts` files).
 */
describe('LiveTranscriptComponent live flags + editing', () => {
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

  it('renders a suspect badge with the human-facing reason tooltip on a flagged live segment', () => {
    const fixture = createFixture([
      transcriptSegment({
        startSec: 0,
        endSec: 1,
        text: 'Shaky decode',
        speaker: 'me',
        suspectReasons: ['RepetitionLoop'],
      }),
    ]);

    const badge: HTMLElement | null = fixture.nativeElement.querySelector('.final .suspect-badge');
    expect(badge).toBeTruthy();
    expect(badge?.getAttribute('title')).toBe('Repeated phrase');
    expect(badge?.getAttribute('aria-label')).toBe('Possibly mis-transcribed');
  });

  it('renders an Edited badge carrying the decoder-original text on a human-corrected live segment', () => {
    const fixture = createFixture([
      transcriptSegment({
        startSec: 0,
        endSec: 1,
        text: 'Corrected',
        speaker: 'me',
        edited: true,
        originalText: 'hello',
      }),
    ]);

    const badge: HTMLElement | null = fixture.nativeElement.querySelector('.final .edited-badge');
    expect(badge).toBeTruthy();
    expect(badge?.textContent).toBe('Edited');
    expect(badge?.getAttribute('title')).toBe('hello');
  });

  it('renders no audit badges for a clean unedited live segment', () => {
    const fixture = createFixture([
      transcriptSegment({ startSec: 0, endSec: 1, text: 'Clean decode', speaker: 'me' }),
    ]);

    expect(fixture.nativeElement.querySelector('.final .suspect-badge')).toBeNull();
    expect(fixture.nativeElement.querySelector('.final .edited-badge')).toBeNull();
  });

  it('renders inline editors for every finalized row while editableLive and plain text otherwise', () => {
    const segments = [
      transcriptSegment({ startSec: 0, endSec: 1, text: 'One' }),
      transcriptSegment({ startSec: 1, endSec: 2, text: 'Two' }),
    ];

    const editable = createFixture(segments);
    editable.componentRef.setInput('editableLive', true);
    editable.detectChanges();
    expect(editable.nativeElement.querySelectorAll('.final app-editable-segment').length).toBe(2);
    expect(editable.nativeElement.querySelector('.final span.text')).toBeNull();

    const readonly = createFixture(segments);
    expect(readonly.nativeElement.querySelector('app-editable-segment')).toBeNull();
    expect(readonly.nativeElement.querySelectorAll('.final span.text').length).toBe(2);
  });

  it('emits liveSegmentEdited with the absolute transcript index and the committed text', () => {
    const fixture = createFixture([
      transcriptSegment({ startSec: 0, endSec: 1, text: 'One' }),
      transcriptSegment({ startSec: 1, endSec: 2, text: 'Two' }),
    ]);
    fixture.componentRef.setInput('editableLive', true);
    fixture.detectChanges();
    const emitted: { readonly index: number; readonly text: string }[] = [];
    fixture.componentInstance.liveSegmentEdited.subscribe((edit) => emitted.push(edit));

    // A non-zero index proves the emission is not hardcoded to the first row.
    fixture.componentInstance.onLiveSegmentEdited(1, 'Two, corrected');

    expect(emitted).toEqual([{ index: 1, text: 'Two, corrected' }]);
  });
});
