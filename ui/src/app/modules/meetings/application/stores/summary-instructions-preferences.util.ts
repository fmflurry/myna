import type { MeetingId } from '../../core/models/meeting.model';
import type { SummaryInstructionsDraft } from '../../core/models/summary-instructions.model';
import type { PreferencesPort } from '../../core/ports/preferences.port';
import type { MeetingsSlots } from './meetings.store';

/** localStorage key prefix per-(meeting, template) summary-instruction drafts are persisted under. */
export const SUMMARY_INSTRUCTIONS_PREFERENCE_PREFIX = 'meetings.summaryInstructions';

/** The draft assumed when nothing usable is stored: empty focus text, general guidelines included. */
export const DEFAULT_SUMMARY_INSTRUCTIONS_DRAFT: SummaryInstructionsDraft = { text: '', includeGeneral: true };

/** Preference key for one (meeting, template) draft: `meetings.summaryInstructions.{meetingId}.{template}`. */
export const summaryInstructionsKey = (meetingId: MeetingId, template: string): string =>
  `${SUMMARY_INSTRUCTIONS_PREFERENCE_PREFIX}.${meetingId}.${template}`;

/** Reads and parses the stored draft at `key`; anything unusable (absent, corrupt, wrong shape) yields the default — never throws. */
export const readDraft = (preferences: PreferencesPort, key: string): SummaryInstructionsDraft =>
  parseDraft(preferences.get(key));

/** Persists `draft` as JSON under `key`. */
export const writeDraft = (preferences: PreferencesPort, key: string, draft: SummaryInstructionsDraft): void => {
  preferences.set(key, JSON.stringify(draft));
};

/**
 * Reads the (meeting, template) draft from the slot map first, falling back
 * to a lazy `PreferencesPort` read — so drafts survive a store rebuild
 * without enumeration at seed time (`PreferencesPort` has no `keys()`).
 * Pure read; never writes to the slot.
 */
export const readSummaryInstructionDraft = (
  slots: MeetingsSlots,
  preferences: PreferencesPort,
  meetingId: MeetingId,
  template: string,
): SummaryInstructionsDraft => {
  const key = summaryInstructionsKey(meetingId, template);
  return slots.get('SUMMARY_INSTRUCTION_DRAFTS')().data?.get(key) ?? readDraft(preferences, key);
};

/** Writes the draft through `PreferencesPort`, then mirrors it into the slot map (NEW Map — never mutates). */
export const storeSummaryInstructionDraft = (
  slots: MeetingsSlots,
  preferences: PreferencesPort,
  meetingId: MeetingId,
  template: string,
  draft: SummaryInstructionsDraft,
): void => {
  const key = summaryInstructionsKey(meetingId, template);
  writeDraft(preferences, key, draft);
  const next = new Map(slots.get('SUMMARY_INSTRUCTION_DRAFTS')().data ?? []);
  next.set(key, draft);
  slots.update('SUMMARY_INSTRUCTION_DRAFTS', { data: next, status: 'Success', isLoading: false });
};

const parseDraft = (raw: string | null): SummaryInstructionsDraft => {
  if (raw === null) {
    return DEFAULT_SUMMARY_INSTRUCTIONS_DRAFT;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return DEFAULT_SUMMARY_INSTRUCTIONS_DRAFT;
    }
    const { text, includeGeneral } = parsed as { readonly text?: unknown; readonly includeGeneral?: unknown };
    if (typeof text !== 'string' || typeof includeGeneral !== 'boolean') {
      return DEFAULT_SUMMARY_INSTRUCTIONS_DRAFT;
    }
    return { text, includeGeneral };
  } catch {
    return DEFAULT_SUMMARY_INSTRUCTIONS_DRAFT;
  }
};
