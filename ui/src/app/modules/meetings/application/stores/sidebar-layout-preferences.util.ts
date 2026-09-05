import { DEFAULT_SIDEBAR_WIDTH_PX, clampSidebarWidth } from '../../core/models/sidebar-layout.model';
import type { PreferencesPort } from '../../core/ports/preferences.port';

/** localStorage key the meetings sidebar width (in pixels) is persisted under. */
export const SIDEBAR_WIDTH_PREFERENCE_KEY = 'meetings.sidebarWidth';

/** localStorage key whether the sidebar is collapsed is persisted under. */
export const SIDEBAR_COLLAPSED_PREFERENCE_KEY = 'meetings.sidebarCollapsed';

/** Reads the persisted, clamped sidebar width — falls back to {@link DEFAULT_SIDEBAR_WIDTH_PX} for anything not a usable positive number. */
export const readStoredSidebarWidth = (preferences: PreferencesPort): number => {
  const stored = Number(preferences.get(SIDEBAR_WIDTH_PREFERENCE_KEY));
  return Number.isFinite(stored) && stored > 0 ? clampSidebarWidth(stored) : DEFAULT_SIDEBAR_WIDTH_PX;
};

/** Clamps and persists a sidebar width, returning the clamped value the caller should apply to its own state. */
export const storeSidebarWidth = (preferences: PreferencesPort, width: number): number => {
  const clamped = clampSidebarWidth(width);
  preferences.set(SIDEBAR_WIDTH_PREFERENCE_KEY, String(clamped));
  return clamped;
};

/** Reads the persisted sidebar-collapsed flag, defaulting to expanded (`false`). */
export const readStoredSidebarCollapsed = (preferences: PreferencesPort): boolean =>
  preferences.get(SIDEBAR_COLLAPSED_PREFERENCE_KEY) === 'true';

/** Persists the sidebar-collapsed flag. */
export const storeSidebarCollapsed = (preferences: PreferencesPort, collapsed: boolean): void => {
  preferences.set(SIDEBAR_COLLAPSED_PREFERENCE_KEY, String(collapsed));
};
