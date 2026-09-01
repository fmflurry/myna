import { transcriptSegment } from '../../../application/testing/transcript-segment.factory';
import { groupConsecutiveSegments } from './transcript-view.component.support';

describe('groupConsecutiveSegments', () => {
  it('collapses a run of consecutive same-speaker segments into one group with absolute indices', () => {
    const segments = Array.from({ length: 7 }, (_, index) =>
      transcriptSegment({ startSec: index * 5, endSec: index * 5 + 5, text: `Line ${index}`, speaker: 'others:1' }),
    );

    const groups = groupConsecutiveSegments({ segments });

    expect(groups.length).toBe(1);
    expect(groups[0]?.speaker).toBe('others:1');
    expect(groups[0]?.startSec).toBe(0);
    expect(groups[0]?.entries.length).toBe(7);
    expect(groups[0]?.entries.map((entry) => entry.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('starts a new group on a speaker change (boundary)', () => {
    const segments = [
      transcriptSegment({ startSec: 0, endSec: 5, text: 'a', speaker: 'others:1' }),
      transcriptSegment({ startSec: 5, endSec: 10, text: 'b', speaker: 'others:1' }),
      transcriptSegment({ startSec: 10, endSec: 15, text: 'c', speaker: 'others:2' }),
      transcriptSegment({ startSec: 15, endSec: 20, text: 'd', speaker: 'others:2' }),
    ];

    const groups = groupConsecutiveSegments({ segments });

    expect(groups.length).toBe(2);
    expect(groups[0]?.speaker).toBe('others:1');
    expect(groups[0]?.entries.map((entry) => entry.index)).toEqual([0, 1]);
    expect(groups[1]?.speaker).toBe('others:2');
    expect(groups[1]?.entries.map((entry) => entry.index)).toEqual([2, 3]);
  });

  it('never groups "unknown" segments, even consecutively', () => {
    const segments = [
      transcriptSegment({ startSec: 0, endSec: 5, text: 'a', speaker: 'unknown' }),
      transcriptSegment({ startSec: 5, endSec: 10, text: 'b', speaker: 'unknown' }),
      transcriptSegment({ startSec: 10, endSec: 15, text: 'c', speaker: 'unknown' }),
    ];

    const groups = groupConsecutiveSegments({ segments });

    expect(groups.length).toBe(3);
    expect(groups.map((group) => group.entries.map((entry) => entry.index))).toEqual([[0], [1], [2]]);
  });

  it('returns an empty array for an empty transcript', () => {
    expect(groupConsecutiveSegments({ segments: [] })).toEqual([]);
  });

  it('returns an empty array for an undefined transcript', () => {
    expect(groupConsecutiveSegments(undefined)).toEqual([]);
  });
});
