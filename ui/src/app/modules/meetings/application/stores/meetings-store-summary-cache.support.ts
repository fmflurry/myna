import type { MeetingId } from '../../core/models/meeting.model';
import type { Summary } from '../../core/models/summary.model';
import { summaryCacheKey } from './summary-cache.model';
import type { SummaryCacheEntry } from './summary-cache.model';
import type { MeetingsSlots } from './meetings.store';

/**
 * Extracted from `MeetingsStore` to keep the class under the project's
 * `max-lines` limit (see `meetings.store.support.ts`'s docblock for the
 * pattern this follows) — free functions operating on `slots` directly,
 * mirrored 1:1 by thin `MeetingsStore` wrapper methods of the same name.
 */
function readSummaryCache(slots: MeetingsSlots): ReadonlyMap<string, SummaryCacheEntry> {
  return slots.get('SUMMARY_CACHE')().data ?? new Map();
}

export function readSummaryCacheEntry(
  slots: MeetingsSlots,
  meetingId: MeetingId,
  template: string,
  language: string,
): SummaryCacheEntry | undefined {
  return readSummaryCache(slots).get(summaryCacheKey(meetingId, template, language));
}

export function applySummaryCacheLoading(slots: MeetingsSlots, meetingId: MeetingId, template: string, language: string): void {
  const next = new Map(readSummaryCache(slots));
  next.set(summaryCacheKey(meetingId, template, language), { status: 'loading' });
  slots.update('SUMMARY_CACHE', { data: next, status: 'Success', isLoading: false });
}

/** `summary === null` records the deliberate `'empty'` outcome — never treated as an error. */
export function applySummaryCacheResult(
  slots: MeetingsSlots,
  meetingId: MeetingId,
  template: string,
  language: string,
  summary: Summary | null,
): void {
  const next = new Map(readSummaryCache(slots));
  next.set(summaryCacheKey(meetingId, template, language), summary ? { status: 'loaded', summary } : { status: 'empty' });
  slots.update('SUMMARY_CACHE', { data: next, status: 'Success', isLoading: false });
}

/** Records the terminal `'failed'` outcome of a rejected fetch; the key stays present so the pane's effect never re-requests it on its own. */
export function applySummaryCacheFailed(slots: MeetingsSlots, meetingId: MeetingId, template: string, language: string): void {
  const next = new Map(readSummaryCache(slots));
  next.set(summaryCacheKey(meetingId, template, language), { status: 'failed' });
  slots.update('SUMMARY_CACHE', { data: next, status: 'Success', isLoading: false });
}

/**
 * Removes a cache entry outright. NOT used on fetch failure (that records
 * `'failed'` instead — deleting the key is what made the detail pane's effect
 * re-request in a loop); reserved for an explicit, user-driven retry.
 */
export function removeSummaryCacheEntry(slots: MeetingsSlots, meetingId: MeetingId, template: string, language: string): void {
  const next = new Map(readSummaryCache(slots));
  next.delete(summaryCacheKey(meetingId, template, language));
  slots.update('SUMMARY_CACHE', { data: next, status: 'Success', isLoading: false });
}
