/**
 * Width in pixels of the meetings sidebar. Shared between
 * `MeetingsStore` (persisted default/fallback) and the sidebar shell
 * (drag/keyboard clamping), so both sides of the sidebar agree on the same
 * bounds without either layer importing the other.
 */
export const DEFAULT_SIDEBAR_WIDTH_PX = 224;

/** Narrowest the sidebar may shrink to — keeps the meeting list usable while dragging, restoring, or loading a stored width. */
export const MIN_SIDEBAR_WIDTH_PX = 200;

/** Widest the sidebar may grow to, leaving the workspace enough room on the other side. */
export const MAX_SIDEBAR_WIDTH_PX = 480;

/** Clamps an arbitrary stored/dragged width into the valid [MIN_SIDEBAR_WIDTH_PX, MAX_SIDEBAR_WIDTH_PX] range, rounded to whole pixels to avoid sub-pixel artifacts (e.g. `223.99999999999997px`) reaching the DOM. */
export const clampSidebarWidth = (width: number): number => {
  const clamped = Math.min(MAX_SIDEBAR_WIDTH_PX, Math.max(MIN_SIDEBAR_WIDTH_PX, width));
  return Math.round(clamped);
};
