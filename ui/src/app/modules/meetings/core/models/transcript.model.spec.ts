import { speakerAccentIndex, speakerDisplayName, speakerRole, speakerSubId, withSegmentText } from './transcript.model';
import type { Transcript, TranscriptSegment } from './transcript.model';

describe('withSegmentText', () => {
  const original: Transcript = {
    segments: [
      { startSec: 0, endSec: 5, text: 'first', speaker: 'me' },
      { startSec: 5, endSec: 10, text: 'second', speaker: 'others' },
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

describe('speakerRole', () => {
  it('resolves "me" and "others" directly', () => {
    expect(speakerRole('me')).toBe('me');
    expect(speakerRole('others')).toBe('others');
  });

  it('resolves the prefix of a sub-identity label', () => {
    expect(speakerRole('others:2')).toBe('others');
  });

  it('resolves anything unrecognised — including "unknown" itself — to "unknown"', () => {
    expect(speakerRole('unknown')).toBe('unknown');
    expect(speakerRole('')).toBe('unknown');
    expect(speakerRole('narrator')).toBe('unknown');
  });
});

describe('speakerSubId', () => {
  it('returns null when the label carries no sub-identity', () => {
    expect(speakerSubId('me')).toBeNull();
    expect(speakerSubId('others')).toBeNull();
    expect(speakerSubId('unknown')).toBeNull();
  });

  it('returns the suffix after ":" when present', () => {
    expect(speakerSubId('others:2')).toBe('2');
    expect(speakerSubId('others:7')).toBe('7');
  });
});

describe('speakerDisplayName', () => {
  it('returns "Me" and "Others" for the plain roles', () => {
    expect(speakerDisplayName('me')).toBe('Me');
    expect(speakerDisplayName('others')).toBe('Others');
  });

  it('returns "" for "unknown" — never fabricates attribution the app does not have', () => {
    expect(speakerDisplayName('unknown')).toBe('');
  });

  it('renders an unseen sub-identity label correctly with zero code change (forward-compat)', () => {
    expect(speakerDisplayName('others:7')).toBe('Others 7');
    expect(speakerDisplayName('others:2')).toBe('Others 2');
  });
});

describe('speakerAccentIndex', () => {
  it('is stable: the SAME label always resolves to the SAME index', () => {
    const first = speakerAccentIndex('others:7', 6);
    const second = speakerAccentIndex('others:7', 6);

    expect(first).toBe(second);
  });

  it('always resolves within [0, paletteSize)', () => {
    for (const label of ['me', 'others', 'others:2', 'others:7', 'unknown', 'narrator']) {
      const index = speakerAccentIndex(label, 6);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(6);
    }
  });
});
