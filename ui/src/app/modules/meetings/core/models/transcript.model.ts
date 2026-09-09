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
  /**
   * Decode-time audit hints as their `SuspectReason` Debug variant names
   * (e.g. `'RepetitionLoop'`). Empty — or absent on legacy payloads — for
   * clean segments. Presence means "worth review", never "definitely
   * wrong": renderers must never fabricate flags from an absent field.
   */
  readonly suspectReasons?: readonly string[];
  /**
   * Whether a human has manually corrected this segment's `text`.
   * Absent on segments persisted before editing; reads as `false`.
   */
  readonly edited?: boolean;
  /**
   * The decoder's original text before the first human correction.
   * `undefined` until the first edit; preserved across further edits so
   * reviewers can always diff back to what the model actually produced.
   */
  readonly originalText?: string;
}

/**
 * Human-facing labels for the `SuspectReason` Debug variant names the
 * backend emits (see `myna_stt::suspect::SuspectReason`). Unknown strings —
 * e.g. a reason minted by a newer backend — fall back to the raw value so
 * the UI never drops an audit hint it doesn't recognize yet.
 */
const SUSPECT_REASON_LABELS: Record<string, string> = {
  RepetitionLoop: 'Repeated phrase',
  LanguageDriftHint: 'Possible language drift',
  LowSpeechEnergy: 'Low speech energy',
  TimingAnomaly: 'Unusual word timing',
  DegenerateLength: 'Unusual length',
};

/** Whether a segment carries any suspect flag worth review. */
export function isSuspect(segment: TranscriptSegment): boolean {
  return (segment.suspectReasons?.length ?? 0) > 0;
}

/** Human-facing label for a single suspect-reason wire value. */
export function suspectLabel(reason: string): string {
  return SUSPECT_REASON_LABELS[reason] ?? reason;
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
