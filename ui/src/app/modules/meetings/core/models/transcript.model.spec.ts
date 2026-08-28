import { withSegmentText } from './transcript.model';
import type { Transcript, TranscriptSegment } from './transcript.model';

describe('withSegmentText', () => {
  const original: Transcript = {
    segments: [
      { startSec: 0, endSec: 5, text: 'first' },
      { startSec: 5, endSec: 10, text: 'second' },
    ],
  };

  it('replaces only the target segment text', () => {
    const updated = withSegmentText(original, 1, 'corrected');

    expect(updated.segments[1]?.text).toBe('corrected');
    expect(updated.segments[0]?.text).toBe('first');
  });

  it('preserves startSec, endSec, and segment order', () => {
    const updated = withSegmentText(original, 0, 'changed');

    expect(updated.segments[0]?.startSec).toBe(0);
    expect(updated.segments[0]?.endSec).toBe(5);
    expect(updated.segments.map((segment: TranscriptSegment) => segment.text)).toEqual([
      'changed',
      'second',
    ]);
  });

  it('returns a new object and never mutates the input', () => {
    const updated = withSegmentText(original, 0, 'changed');

    expect(updated).not.toBe(original);
    expect(updated.segments).not.toBe(original.segments);
    expect(original.segments[0]?.text).toBe('first');
  });

  it('leaves everything unchanged when the index is out of range', () => {
    const updated = withSegmentText(original, 5, 'unreachable');

    expect(updated.segments.map((segment: TranscriptSegment) => segment.text)).toEqual([
      'first',
      'second',
    ]);
  });
});
