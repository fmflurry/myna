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

/** One row of a speaker-reassign picker: the label to assign and how to show it. */
export interface SpeakerReassignOption {
  readonly key: string;
  readonly text: string;
  /** The flat speaker label to assign. For `New speaker…` this is freshly minted at call ("open") time. */
  readonly speaker: Speaker;
}

/**
 * The full speaker-reassign option list — Me, Others (unassigned), every
 * known named identity, and New speaker… — shared by the per-chip menu and
 * the text-selection toolbar. Pure: the caller owns what an option click
 * does with `speaker` (single-segment reassign vs multi-segment assignment).
 */
export function speakerReassignOptions(
  transcript: Transcript | undefined,
  speakerNames: Readonly<Record<string, string>>,
): readonly SpeakerReassignOption[] {
  return [
    { key: 'me', text: 'Me', speaker: 'me' },
    { key: 'others', text: 'Others (unassigned)', speaker: 'others' },
    ...knownSpeakerIdentities(speakerNames).map((identity) => ({
      key: identity.label,
      text: identity.name,
      speaker: identity.label,
    })),
    { key: 'new', text: 'New speaker…', speaker: mintNewSpeakerLabel(transcript, speakerNames) },
  ];
}

/** Minimum on-screen margin a popup menu must keep from any viewport edge. */
const VIEWPORT_MARGIN_PX = 8;
/** Assumed menu width used only to decide whether the left edge needs clamping (jsdom never lays out real width). */
const MENU_ESTIMATED_WIDTH_PX = 220;
/** Below this much space on the preferred side, the menu flips to the other side. */
const MENU_FLIP_THRESHOLD_PX = 160;
/** Gap between the anchor rect and the menu. */
const MENU_ANCHOR_GAP_PX = 4;
/** Floor for the computed max-height so a menu near a cramped edge still shows something. */
const MENU_MIN_HEIGHT_PX = 120;

/** Computed, viewport-clamped placement for an open popup menu. */
export interface AnchoredMenuPosition {
  readonly left: number;
  readonly top: number | null;
  readonly bottom: number | null;
  readonly maxHeight: number;
  /** True when the menu is anchored ABOVE the rect (its `bottom` is set, `top` is not). */
  readonly dropup: boolean;
}

/**
 * Derives a viewport-clamped placement for a popup anchored to `rect`.
 * `preferAbove` picks which side is primary and which is the fallback:
 * the chip menu hangs BELOW its chip and flips to a dropup when there
 * isn't room below; the selection toolbar sits ABOVE the selection and
 * flips below when there isn't room above. The left edge is always
 * clamped to stay within {@link VIEWPORT_MARGIN_PX} of either edge
 * (using an estimated width since jsdom never lays out a real one).
 */
export function computeAnchoredMenuPosition(rect: DOMRect, preferAbove: boolean): AnchoredMenuPosition {
  const spaceAbove = rect.top;
  const spaceBelow = window.innerHeight - rect.bottom;
  const placeAbove = preferAbove ? spaceAbove >= MENU_FLIP_THRESHOLD_PX : spaceBelow < MENU_FLIP_THRESHOLD_PX;

  let left = rect.left;
  if (left + MENU_ESTIMATED_WIDTH_PX > window.innerWidth - VIEWPORT_MARGIN_PX) {
    left = window.innerWidth - MENU_ESTIMATED_WIDTH_PX - VIEWPORT_MARGIN_PX;
  }
  left = Math.min(Math.max(left, VIEWPORT_MARGIN_PX), window.innerWidth - VIEWPORT_MARGIN_PX);

  if (placeAbove) {
    const maxHeight = Math.max(spaceAbove - VIEWPORT_MARGIN_PX, MENU_MIN_HEIGHT_PX);
    return { left, top: null, bottom: window.innerHeight - rect.top + MENU_ANCHOR_GAP_PX, maxHeight, dropup: true };
  }
  const maxHeight = Math.max(spaceBelow - VIEWPORT_MARGIN_PX, MENU_MIN_HEIGHT_PX);
  return { left, top: rect.bottom + MENU_ANCHOR_GAP_PX, bottom: null, maxHeight, dropup: false };
}
