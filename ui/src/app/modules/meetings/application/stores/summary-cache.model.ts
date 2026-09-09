import type { MeetingId } from '../../core/models/meeting.model';
import type { Summary } from '../../core/models/summary.model';

/**
 * Load state of one persisted summary the UI has asked for by (meeting,
 * template, language). `'empty'` means `get_summary` resolved `null` — a
 * normal, deliberate "nothing saved" outcome, kept distinct from `'loading'`
 * so the UI never shows the empty state while a fetch is still in flight.
 * `'failed'` means `get_summary` REJECTED; it is a terminal state that keeps
 * the key present, so the detail pane's effect (which re-requests any key
 * missing from the cache) never turns one failure into an IPC loop. Retrying
 * a failed load is a deliberate user action, never automatic.
 */
export type SummaryCacheStatus = 'loading' | 'loaded' | 'empty' | 'failed';

export interface SummaryCacheEntry {
  readonly status: SummaryCacheStatus;
  readonly summary?: Summary;
}

/** Cache key a persisted summary is looked up and stored by. */
export const summaryCacheKey = (meetingId: MeetingId, template: string, language: string): string =>
  `${meetingId}::${template}::${language}`;
