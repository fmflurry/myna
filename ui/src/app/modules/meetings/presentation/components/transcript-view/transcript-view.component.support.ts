import { speakerRole, speakerSubId, type Speaker, type Transcript } from '../../../core/models/transcript.model';

/** A known, named speaker identity offered in the reassign menu. */
export interface SpeakerIdentity {
  readonly label: string;
  readonly name: string;
}

/**
 * Every named "others" identity known for this transcript, derived from
 * `speakerNames` alone — the canonical name registry (not from scanning
 * segments, which would miss a name assigned to a speaker no segment
 * currently carries). Sorted by display name for a stable menu order.
 */
export function knownSpeakerIdentities(speakerNames: Readonly<Record<string, string>>): readonly SpeakerIdentity[] {
  return Object.entries(speakerNames)
    .filter(([label]) => speakerRole(label) === 'others')
    .map(([label, name]) => ({ label, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Reserved namespace prefix for UI-minted speaker sub-ids — see `mintNewSpeakerLabel`. */
const MINTED_SUB_ID_PREFIX = 'm';

/**
 * Mints a fresh `others:m<N>` label for a brand-new speaker the user is
 * introducing via "New speaker…". The `m`-prefixed sub-id namespace is
 * reserved and disjoint from the diarizer's own output: the diarizer only
 * ever emits PURE-NUMERIC sub-ids (`others:1`, `others:2`, …), so a minted
 * label can never collide with one produced by a later re-run — this is a
 * structural guarantee, not merely unlikely.
 *
 * Scans both the transcript's segments and `speakerNames`' keys for the
 * highest already-minted `mN` index, so re-opening "New speaker…" after
 * assigning some segments never reuses a label already in use.
 */
export function mintNewSpeakerLabel(
  transcript: Transcript | undefined,
  speakerNames: Readonly<Record<string, string>>,
): Speaker {
  let highest = 0;
  const consider = (label: string): void => {
    if (speakerRole(label) !== 'others') {
      return;
    }
    const subId = speakerSubId(label);
    if (!subId?.startsWith(MINTED_SUB_ID_PREFIX)) {
      return;
    }
    const index = Number.parseInt(subId.slice(MINTED_SUB_ID_PREFIX.length), 10);
    if (Number.isInteger(index) && index > highest) {
      highest = index;
    }
  };

  for (const segment of transcript?.segments ?? []) {
    consider(segment.speaker);
  }
  for (const label of Object.keys(speakerNames)) {
    consider(label);
  }

  return `others:${MINTED_SUB_ID_PREFIX}${highest + 1}`;
}
