import {
  speakerAccentIndex,
  speakerDisplayName,
  speakerRole,
  speakerSubId,
  type Speaker,
  type Transcript,
  type TranscriptSegment,
} from '../../../core/models/transcript.model';

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
  /** The flat speaker label to assign. For `New speaker…` this is freshly minted when the list is built. */
  readonly speaker: Speaker;
}

/**
 * The full speaker-reassign option list — Me, Others (unassigned), every
 * known named identity, and New speaker… — shared by the per-chip menu and
 * the text-selection toolbar. Pure: the caller owns what an option click
 * does with `speaker` (group reassign vs multi-segment assignment).
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

/**
 * Registry display name first (a rename must update EVERY chip for the
 * label), falling back to the derived label. `''` for `unknown` — renderers
 * must never fabricate attribution the app doesn't have.
 */
export function resolveSpeakerLabel(speaker: Speaker, speakerNames: Readonly<Record<string, string>>): string {
  return speakerNames[speaker] ?? speakerDisplayName(speaker);
}

/** Whether `speaker` carries real attribution chrome should render for. */
export function hasAttributedLabel(speaker: Speaker): boolean {
  return speakerRole(speaker) !== 'unknown';
}

/** Combined class list for the chip button: base + palette accent + `.speaker-label` when attributed. */
export function chipClasses(speaker: Speaker, paletteSize: number): string {
  const classes = ['speaker-chip', `speaker-accent-${speakerAccentIndex(speaker, paletteSize)}`];
  if (hasAttributedLabel(speaker)) {
    classes.push('speaker-label');
  }
  return classes.join(' ');
}

/** Visible chip text: the resolved label, or a call-to-action for `unknown` (never fabricated attribution). */
export function chipText(speaker: Speaker, speakerNames: Readonly<Record<string, string>>): string {
  return hasAttributedLabel(speaker) ? resolveSpeakerLabel(speaker, speakerNames) : 'Assign speaker';
}

/**
 * Confirm prompt for the chip menu's "Delete section…" row: names the
 * section's speaker (when attributed) and pluralises by line count.
 */
export function sectionDeleteMessage(
  indices: readonly number[],
  segments: readonly TranscriptSegment[],
  speakerLabelOf: (speaker: Speaker) => string,
): string {
  const speaker = segments[indices[0]!]?.speaker;
  const label = speaker === undefined ? '' : speakerLabelOf(speaker);
  const who = label === '' ? '' : ` by "${label}"`;
  const noun = indices.length === 1 ? 'line' : 'lines';
  return `Delete this section${who}? Its ${indices.length} ${noun} will be removed from the transcript.`;
}

/** Longest line text quoted verbatim in the per-line delete confirmation before it is cut to an excerpt. */
const LINE_DELETE_EXCERPT_MAX = 60;

/**
 * Confirm prompt for the per-line delete affordance: quotes the line's OWN
 * text (truncated with an ellipsis when long) so the user sees exactly WHICH
 * line is about to disappear — the section prompt can't disambiguate within
 * a multi-line block.
 */
export function lineDeleteMessage(text: string): string {
  const excerpt = text.length > LINE_DELETE_EXCERPT_MAX ? `${text.slice(0, LINE_DELETE_EXCERPT_MAX - 1)}…` : text;
  return `Delete this line? "${excerpt}" will be removed from the transcript.`;
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

/**
 * The ABSOLUTE segment indices of every `[data-segment-index]` element under
 * `root` that `range` intersects, in ascending DOM order (each element
 * appears once, so the result is unique by construction). Unparseable
 * `data-segment-index` values are skipped.
 */
export function selectedSegmentIndices(range: Range, root: HTMLElement): readonly number[] {
  const indices: number[] = [];
  for (const el of root.querySelectorAll<HTMLElement>('[data-segment-index]')) {
    if (range.intersectsNode(el)) {
      const parsed = Number.parseInt(el.getAttribute('data-segment-index') ?? '', 10);
      if (!Number.isNaN(parsed)) {
        indices.push(parsed);
      }
    }
  }
  return indices;
}

/**
 * What a document `mouseup` says about the floating selection toolbar:
 * `ignore` (the event must not touch the toolbar at all), `close`, or `open`
 * targeting `indices` anchored to the selection `rect` (`null` where the
 * engine has no layout — jsdom's `Range` lacks `getBoundingClientRect`).
 */
export type SelectionToolbarIntent =
  | { readonly kind: 'ignore' }
  | { readonly kind: 'close' }
  | { readonly kind: 'open'; readonly indices: readonly number[]; readonly rect: DOMRect | null };

/**
 * Reads the live text selection and decides what the toolbar should do. A
 * collapsed or whitespace-only selection closes it; a selection anchored
 * inside the chip menu, a chip, or the toolbar itself is someone else's
 * business (`ignore`); a non-editable transcript never opens it; a real
 * selection intersecting no segment closes it.
 */
export function readSelectionToolbarIntent(
  selection: Selection | null,
  root: HTMLElement,
  editable: boolean,
): SelectionToolbarIntent {
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) {
    return { kind: 'close' };
  }
  if (selection.toString().trim().length === 0) {
    return { kind: 'close' };
  }
  if (!editable) {
    return { kind: 'ignore' };
  }
  const range = selection.getRangeAt(0);
  const anchor = range.commonAncestorContainer;
  const anchorElement = anchor instanceof Element ? anchor : anchor.parentElement;
  if (anchorElement?.closest('.speaker-menu, .speaker-chip, .selection-menu')) {
    return { kind: 'ignore' };
  }
  const indices = selectedSegmentIndices(range, root);
  if (indices.length === 0) {
    return { kind: 'close' };
  }
  // jsdom's Range has no getBoundingClientRect at all; the toolbar still
  // opens, just without an inline anchor (real browsers always have one).
  const rect = typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null;
  return { kind: 'open', indices, rect };
}

/** One segment within a rendered group, carrying its ABSOLUTE `transcript.segments` index. */
export interface TranscriptSegmentGroupEntry {
  readonly index: number;
  readonly segment: TranscriptSegment;
}

/** A run of consecutive segments sharing one attributed speaker, rendered as a single block. */
export interface TranscriptSegmentGroup {
  readonly speaker: Speaker;
  /** The FIRST segment's `startSec` — matches `apply_segment_merge_up`'s rule of taking `prev.start_sec`. */
  readonly startSec: number;
  readonly entries: readonly TranscriptSegmentGroupEntry[];
}

/**
 * Groups consecutive transcript segments sharing the same attributed speaker
 * into one rendering block. Diarization is a pure relabel that never changes
 * segment boundaries, so a single monologue commonly spans several VAD
 * segments all stamped with the same speaker — grouping them here is purely
 * a PRESENTATION concern; every entry keeps its absolute index unchanged.
 *
 * `unknown` segments never group, even with an adjacent `unknown` segment:
 * the app has no attribution to merge on, so each renders as its own block.
 */
export function groupConsecutiveSegments(transcript: Transcript | undefined): readonly TranscriptSegmentGroup[] {
  const groups: TranscriptSegmentGroup[] = [];
  const segments = transcript?.segments ?? [];

  segments.forEach((segment, index) => {
    const previousGroup = groups.at(-1);
    const continuesRun =
      previousGroup !== undefined && previousGroup.speaker === segment.speaker && speakerRole(segment.speaker) !== 'unknown';

    if (continuesRun && previousGroup !== undefined) {
      groups[groups.length - 1] = { ...previousGroup, entries: [...previousGroup.entries, { index, segment }] };
      return;
    }
    groups.push({ speaker: segment.speaker, startSec: segment.startSec, entries: [{ index, segment }] });
  });

  return groups;
}
