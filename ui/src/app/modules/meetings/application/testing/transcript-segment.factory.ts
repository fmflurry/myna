import type { TranscriptSegment } from '../../core/models/transcript.model';

/**
 * Builds a `TranscriptSegment` fixture with sensible defaults, so specs only
 * ever spell out the fields they actually care about. Defaults `speaker` to
 * `'unknown'` — the value the mapper falls back to for legacy/absent data —
 * which keeps every pre-existing behavioral assertion (rendered exactly as
 * before, no speaker chrome) true unchanged.
 */
export function transcriptSegment(overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    startSec: 0,
    endSec: 1,
    text: 'segment text',
    speaker: 'unknown',
    ...overrides,
  };
}
