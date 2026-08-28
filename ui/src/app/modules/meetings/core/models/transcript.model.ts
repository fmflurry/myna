export interface TranscriptSegment {
  readonly startSec: number;
  readonly endSec: number;
  readonly text: string;
}

export interface Transcript {
  readonly segments: readonly TranscriptSegment[];
}

export const emptyTranscript = (): Transcript => ({ segments: [] });

export const withSegment = (transcript: Transcript, segment: TranscriptSegment): Transcript => ({
  segments: [...transcript.segments, segment],
});

export const withSegmentText = (transcript: Transcript, index: number, text: string): Transcript => ({
  segments: transcript.segments.map((segment, i) => (i === index ? { ...segment, text } : segment)),
});
