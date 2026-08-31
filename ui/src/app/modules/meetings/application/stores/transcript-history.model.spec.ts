import { describe, expect, it } from 'vitest';

import { toMeetingId } from '../../core/models/meeting.model';
import { transcriptSegment } from '../testing/transcript-segment.factory';
import { describeTranscriptOp, type TranscriptDeleteOp, type TranscriptMergeOp } from './transcript-history.model';

/**
 * Pure unit specs for the transcript-undo op/inverse helpers. Mirrors the
 * style of `speaker-history.model.ts` (`describeSpeakerOp`), but for the
 * single-slot `TranscriptOp` variants: `delete` (one removed segment) and
 * `merge` (two original segments). No Angular wiring — these are plain
 * functions over plain data.
 */
describe('describeTranscriptOp', () => {
  const meetingId = toMeetingId('m-1');

  it('describes a delete op with a non-empty, 1-based segment label', () => {
    const op: TranscriptDeleteOp = {
      kind: 'delete',
      meetingId,
      index: 2,
      segment: transcriptSegment({ text: 'third' }),
    };

    const label = describeTranscriptOp(op);

    expect(label.length).toBeGreaterThan(0);
    expect(label).toContain('3');
  });

  it('describes a merge op with a non-empty, 1-based segment label', () => {
    const op: TranscriptMergeOp = {
      kind: 'merge',
      meetingId,
      index: 1,
      previous: transcriptSegment({ text: 'first' }),
      current: transcriptSegment({ text: 'second' }),
    };

    const label = describeTranscriptOp(op);

    expect(label.length).toBeGreaterThan(0);
    expect(label).toContain('2');
  });

  it('produces a distinct label for delete vs merge at the same index', () => {
    const deleteOp: TranscriptDeleteOp = {
      kind: 'delete',
      meetingId,
      index: 0,
      segment: transcriptSegment({ text: 'only' }),
    };
    const mergeOp: TranscriptMergeOp = {
      kind: 'merge',
      meetingId,
      index: 0,
      previous: transcriptSegment({ text: 'a' }),
      current: transcriptSegment({ text: 'b' }),
    };

    expect(describeTranscriptOp(deleteOp)).not.toBe(describeTranscriptOp(mergeOp));
  });

  it('produces distinct labels for two delete ops at different indices', () => {
    const first: TranscriptDeleteOp = {
      kind: 'delete',
      meetingId,
      index: 0,
      segment: transcriptSegment({ text: 'a' }),
    };
    const second: TranscriptDeleteOp = {
      kind: 'delete',
      meetingId,
      index: 4,
      segment: transcriptSegment({ text: 'e' }),
    };

    expect(describeTranscriptOp(first)).not.toBe(describeTranscriptOp(second));
  });
});
