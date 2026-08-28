/**
 * Fraction (0-1) of the two-column meeting workspace the transcript column
 * occupies; the summary column takes the remainder. Shared between
 * `MeetingsStore` (persisted default/fallback) and `SplitWorkspaceComponent`
 * (drag/keyboard clamping), so both sides of the split agree on the same
 * bounds without either layer importing the other.
 */
export const DEFAULT_SPLIT_RATIO = 0.4;

/** Narrowest either column may shrink to — keeps neither side unusably thin while dragging, restoring, or loading a stored ratio. */
export const MIN_SPLIT_RATIO = 0.25;

/** Widest the transcript column may grow to, leaving the summary column at least this same minimum on the other side. */
export const MAX_SPLIT_RATIO = 0.75;

/** Decimal precision kept for a ratio — enough to be visually exact while absorbing float drift from division/addition (e.g. `0.4 + 0.02`). */
const RATIO_PRECISION = 10000;

/** Clamps an arbitrary stored/dragged ratio into the valid [MIN_SPLIT_RATIO, MAX_SPLIT_RATIO] range, rounded to avoid float-drift artifacts (e.g. `42.00000000000001%`) reaching the DOM. */
export const clampSplitRatio = (ratio: number): number => {
  const clamped = Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
  return Math.round(clamped * RATIO_PRECISION) / RATIO_PRECISION;
};
