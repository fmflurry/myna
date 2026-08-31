/**
 * Opaque, open-label speaker attribution — deliberately NOT a closed union.
 * Stored values are `'me'`, `'others'`, a sub-identity like `'others:2'`, or
 * `'unknown'` when the backend has no attribution for a segment. Keeping this
 * an open `string` (rather than a 3-value union) lets per-speaker diarization
 * land later without re-migrating already-persisted meetings.
 */
export type Speaker = string;

/** The coarse role a `Speaker` label resolves to, before any sub-identity. */
export type SpeakerRole = 'me' | 'others' | 'unknown';

const SUB_ID_SEPARATOR = ':';

/**
 * Resolves the coarse role a `Speaker` label carries: the prefix before
 * `':'`. Anything other than `'me'` or `'others'` — including an empty
 * string or a value the backend hasn't defined yet — resolves to `'unknown'`,
 * mirroring the parsing rule on the Rust side.
 */
export function speakerRole(speaker: Speaker): SpeakerRole {
  const separatorIndex = speaker.indexOf(SUB_ID_SEPARATOR);
  const prefix = separatorIndex === -1 ? speaker : speaker.slice(0, separatorIndex);
  return prefix === 'me' || prefix === 'others' ? prefix : 'unknown';
}

/** The sub-identity suffix after `':'`, or `null` when the label carries none. */
export function speakerSubId(speaker: Speaker): string | null {
  const separatorIndex = speaker.indexOf(SUB_ID_SEPARATOR);
  return separatorIndex === -1 ? null : speaker.slice(separatorIndex + 1);
}

/**
 * Human-facing label for a `Speaker`. Returns `''` for `unknown` so renderers
 * never fabricate attribution the app doesn't actually have. An unseen label
 * (e.g. `'others:7'`) renders correctly with zero code change: `'Others 7'`.
 */
export function speakerDisplayName(speaker: Speaker): string {
  const role = speakerRole(speaker);
  if (role === 'unknown') {
    return '';
  }
  const roleLabel = role === 'me' ? 'Me' : 'Others';
  const subId = speakerSubId(speaker);
  return subId ? `${roleLabel} ${subId}` : roleLabel;
}

/**
 * Stable index into a fixed-size accent palette, derived from a simple
 * string hash so the SAME label always resolves to the SAME accent — even
 * for a label never seen before (forward-compat for future diarization).
 */
export function speakerAccentIndex(speaker: Speaker, paletteSize: number): number {
  if (paletteSize <= 0) {
    return 0;
  }
  let hash = 0;
  for (let index = 0; index < speaker.length; index += 1) {
    hash = (hash * 31 + speaker.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % paletteSize;
}

export interface TranscriptSegment {
  readonly startSec: number;
  readonly endSec: number;
  readonly text: string;
  readonly speaker: Speaker;
  /** User-pinned speaker attribution; re-running diarization must not overwrite it.
      Absent on segments persisted before pinning. */
  readonly speakerPinned?: boolean;
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
