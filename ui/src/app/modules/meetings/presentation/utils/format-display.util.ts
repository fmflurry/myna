import type { SummaryTemplate } from '../../core/models/summary-template.model';

const SECONDS_PER_MINUTE = 60;

/** Formats a non-negative duration in seconds as zero-padded `mm:ss`. */
export const formatMmSs = (totalSeconds: number): string => {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(clamped / SECONDS_PER_MINUTE);
  const seconds = clamped % SECONDS_PER_MINUTE;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

/** Formats a non-negative duration in seconds as a short whole-minute label, e.g. `32m`. */
export const formatMinutesShort = (durationSec: number): string => {
  const minutes = Math.max(0, Math.round(durationSec / SECONDS_PER_MINUTE));
  return `${minutes}m`;
};

/** Formats a non-negative duration in seconds as a long whole-minute label, e.g. `32 min`. */
export const formatMinutesLong = (durationSec: number): string => {
  const minutes = Math.max(0, Math.round(durationSec / SECONDS_PER_MINUTE));
  return `${minutes} min`;
};

const MONTH_ABBREVIATIONS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

const isSameCalendarDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

const formatHhMm = (date: Date): string =>
  `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

/** Formats a date as `27 Aug` — deterministic, locale-independent (never `toLocaleDateString`). */
export const formatShortDate = (date: Date): string => `${date.getDate()} ${MONTH_ABBREVIATIONS[date.getMonth()]}`;

/**
 * Relative day label for the sidebar's secondary line: `HH:MM` when `date` falls
 * on `now`'s calendar day, `Yest.` for the previous calendar day, else a short date.
 */
export const formatRelativeDay = (date: Date, now: Date): string => {
  if (isSameCalendarDay(date, now)) {
    return formatHhMm(date);
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameCalendarDay(date, yesterday)) {
    return 'Yest.';
  }
  return formatShortDate(date);
};

/** Sidebar row secondary line, e.g. `14:02 · 32m` or `Yest. · 24m`. */
export const formatMeetingListMeta = (createdAt: Date, durationSec: number, now: Date = new Date()): string =>
  `${formatRelativeDay(createdAt, now)} · ${formatMinutesShort(durationSec)}`;

/** Detail-pane heading date, e.g. `27 Aug, 14:02`. */
export const formatMeetingHeadingDate = (createdAt: Date): string => `${formatShortDate(createdAt)}, ${formatHhMm(createdAt)}`;

/** Fallback label shown in place of a blank meeting title (e.g. a freshly started, not-yet-renamed recording). */
export const UNTITLED_MEETING_LABEL = 'Untitled meeting';

/** Renders `title` as-is, or {@link UNTITLED_MEETING_LABEL} when it is empty/whitespace-only. */
export const formatMeetingTitle = (title: string): string => (title.trim().length > 0 ? title : UNTITLED_MEETING_LABEL);

/** Title-cases a kebab-case slug, e.g. `meeting-notes` -> `Meeting Notes`. */
const titleCaseFromSlug = (slug: string): string =>
  slug
    .split('-')
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

/** Fallback emoji for a summary template tab when the template specifies none. */
const GENERIC_TEMPLATE_EMOJI = '🗒️';

/** Static label for the always-present transcript tab. */
export const TRANSCRIPT_TAB_LABEL = '📄 Transcript';

const composeTabLabel = (emoji: string, text: string): string => `${emoji} ${text}`;

/**
 * Compact label for a summary template tab. Never uses `description` — that
 * field is a full sentence meant for a tooltip, not the tab strip. Order of
 * preference:
 * 1. `emoji` + `label` when both are present.
 * 2. `emoji` + title-cased `name` when only `emoji` is present.
 * 3. {@link GENERIC_TEMPLATE_EMOJI} + `label` when only `label` is present.
 * 4. {@link GENERIC_TEMPLATE_EMOJI} + title-cased `name` when neither is present.
 */
export const formatTemplateLabel = (template: SummaryTemplate): string => {
  const emoji = template.emoji?.trim();
  const label = template.label?.trim();
  const nameLabel = titleCaseFromSlug(template.name);

  if (emoji && label) {
    return composeTabLabel(emoji, label);
  }
  if (emoji) {
    return composeTabLabel(emoji, nameLabel);
  }
  if (label) {
    return composeTabLabel(GENERIC_TEMPLATE_EMOJI, label);
  }
  return composeTabLabel(GENERIC_TEMPLATE_EMOJI, nameLabel);
};
