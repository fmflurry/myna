import { storeSidebarCollapsed, storeSidebarWidth } from './sidebar-layout-preferences.util';
import { storeSplitRatio, storeTranscriptCollapsed } from './split-layout-preferences.util';
import type { PreferencesPort } from '../../core/ports/preferences.port';
import type { MeetingsSlots } from './meetings.store';

/**
 * Workspace-layout slot writers extracted out of `MeetingsStore` so that
 * class stays under the project's `max-lines` budget. Each one persists via
 * `PreferencesPort` first, then applies to `slots` — never mutates in place.
 * The store's same-named setters are one-line delegations to these.
 */

/** Clamps, persists, and applies a new transcript/summary split ratio, returning nothing — the caller reads back via the `SPLIT_RATIO` slot. */
export function applySplitRatio(slots: MeetingsSlots, preferences: PreferencesPort, ratio: number): void {
  const clamped = storeSplitRatio(preferences, ratio);
  slots.update('SPLIT_RATIO', { data: clamped, status: 'Success', isLoading: false });
}

/** Persists and applies the transcript-collapsed flag. */
export function applyTranscriptCollapsed(slots: MeetingsSlots, preferences: PreferencesPort, collapsed: boolean): void {
  storeTranscriptCollapsed(preferences, collapsed);
  slots.update('TRANSCRIPT_COLLAPSED', { data: collapsed, status: 'Success', isLoading: false });
}

/** Clamps, persists, and applies a new sidebar width. */
export function applySidebarWidth(slots: MeetingsSlots, preferences: PreferencesPort, width: number): void {
  const clamped = storeSidebarWidth(preferences, width);
  slots.update('SIDEBAR_WIDTH', { data: clamped, status: 'Success', isLoading: false });
}

/** Persists and applies the sidebar-collapsed flag. */
export function applySidebarCollapsed(slots: MeetingsSlots, preferences: PreferencesPort, collapsed: boolean): void {
  storeSidebarCollapsed(preferences, collapsed);
  slots.update('SIDEBAR_COLLAPSED', { data: collapsed, status: 'Success', isLoading: false });
}
