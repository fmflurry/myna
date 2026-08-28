import { DEFAULT_SPLIT_RATIO, clampSplitRatio } from '../../core/models/split-layout.model';
import type { PreferencesPort } from '../../core/ports/preferences.port';

/** localStorage key the two-column workspace's transcript/summary split ratio is persisted under. */
export const SPLIT_RATIO_PREFERENCE_KEY = 'meetings.splitRatio';

/** localStorage key whether the transcript column is collapsed is persisted under. */
export const TRANSCRIPT_COLLAPSED_PREFERENCE_KEY = 'meetings.transcriptCollapsed';

/** Reads the persisted, clamped split ratio — falls back to {@link DEFAULT_SPLIT_RATIO} for anything not a usable positive number. */
export const readStoredSplitRatio = (preferences: PreferencesPort): number => {
  const stored = Number(preferences.get(SPLIT_RATIO_PREFERENCE_KEY));
  return Number.isFinite(stored) && stored > 0 ? clampSplitRatio(stored) : DEFAULT_SPLIT_RATIO;
};

/** Clamps and persists a split ratio, returning the clamped value the caller should apply to its own state. */
export const storeSplitRatio = (preferences: PreferencesPort, ratio: number): number => {
  const clamped = clampSplitRatio(ratio);
  preferences.set(SPLIT_RATIO_PREFERENCE_KEY, String(clamped));
  return clamped;
};

/** Reads the persisted transcript-collapsed flag, defaulting to expanded (`false`). */
export const readStoredTranscriptCollapsed = (preferences: PreferencesPort): boolean =>
  preferences.get(TRANSCRIPT_COLLAPSED_PREFERENCE_KEY) === 'true';

/** Persists the transcript-collapsed flag. */
export const storeTranscriptCollapsed = (preferences: PreferencesPort, collapsed: boolean): void => {
  preferences.set(TRANSCRIPT_COLLAPSED_PREFERENCE_KEY, String(collapsed));
};
