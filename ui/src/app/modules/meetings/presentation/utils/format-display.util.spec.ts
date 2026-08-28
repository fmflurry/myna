import {
  TRANSCRIPT_TAB_LABEL,
  UNTITLED_MEETING_LABEL,
  formatMeetingHeadingDate,
  formatMeetingListMeta,
  formatMeetingTitle,
  formatMinutesLong,
  formatMinutesShort,
  formatMmSs,
  formatRelativeDay,
  formatShortDate,
  formatTemplateLabel,
} from './format-display.util';

describe('formatMmSs', () => {
  it('zero-pads minutes and seconds', () => {
    expect(formatMmSs(65)).toBe('01:05');
  });

  it('clamps negative durations to zero', () => {
    expect(formatMmSs(-5)).toBe('00:00');
  });
});

describe('formatMinutesShort', () => {
  it('rounds to the nearest whole minute with an m suffix', () => {
    expect(formatMinutesShort(32 * 60 + 10)).toBe('32m');
  });

  it('rounds up at the half-minute boundary', () => {
    expect(formatMinutesShort(90)).toBe('2m');
  });
});

describe('formatMinutesLong', () => {
  it('renders the full "min" word', () => {
    expect(formatMinutesLong(32 * 60)).toBe('32 min');
  });
});

describe('formatShortDate', () => {
  it('renders day-then-month, locale-independent', () => {
    expect(formatShortDate(new Date(2026, 7, 27))).toBe('27 Aug');
  });
});

describe('formatRelativeDay', () => {
  const now = new Date(2026, 7, 27, 16, 0);

  it('renders HH:MM for a date on the same calendar day as now', () => {
    const sameDay = new Date(2026, 7, 27, 14, 2);
    expect(formatRelativeDay(sameDay, now)).toBe('14:02');
  });

  it('renders "Yest." for the previous calendar day', () => {
    const yesterday = new Date(2026, 7, 26, 11, 30);
    expect(formatRelativeDay(yesterday, now)).toBe('Yest.');
  });

  it('renders a short date for anything older than yesterday', () => {
    const lastWeek = new Date(2026, 7, 20, 9, 0);
    expect(formatRelativeDay(lastWeek, now)).toBe('20 Aug');
  });
});

describe('formatMeetingListMeta', () => {
  it('joins the relative day and short duration with a middle dot', () => {
    const now = new Date(2026, 7, 27, 16, 0);
    const createdAt = new Date(2026, 7, 27, 14, 2);
    expect(formatMeetingListMeta(createdAt, 32 * 60, now)).toBe('14:02 · 32m');
  });
});

describe('formatMeetingHeadingDate', () => {
  it('renders short date then HH:MM', () => {
    expect(formatMeetingHeadingDate(new Date(2026, 7, 27, 14, 2))).toBe('27 Aug, 14:02');
  });
});

describe('formatMeetingTitle', () => {
  it('returns the title unchanged when non-empty', () => {
    expect(formatMeetingTitle('Standup')).toBe('Standup');
  });

  it('falls back to the untitled-meeting label when the title is empty', () => {
    expect(formatMeetingTitle('')).toBe(UNTITLED_MEETING_LABEL);
  });

  it('falls back to the untitled-meeting label when the title is whitespace-only', () => {
    expect(formatMeetingTitle('   ')).toBe(UNTITLED_MEETING_LABEL);
  });
});

describe('formatTemplateLabel', () => {
  it('never uses the template description as the tab label — regression for the prose-tab bug', () => {
    const label = formatTemplateLabel({
      name: 'meeting-notes',
      description: 'A long, human-written sentence describing this template in detail.',
      prompt: 'p',
      label: 'Notes',
      emoji: '📝',
    });

    expect(label).not.toContain('long, human-written sentence');
    expect(label).toBe('📝 Notes');
  });

  it('composes emoji + label when both are present', () => {
    expect(
      formatTemplateLabel({ name: 'meeting-notes', description: 'ignored', prompt: 'p', label: 'Notes', emoji: '📝' }),
    ).toBe('📝 Notes');
  });

  it('falls back to emoji + title-cased name when only emoji is present', () => {
    expect(formatTemplateLabel({ name: 'meeting-notes', description: 'ignored', prompt: 'p', emoji: '📝' })).toBe(
      '📝 Meeting Notes',
    );
  });

  it('falls back to the generic emoji + label when only label is present', () => {
    expect(formatTemplateLabel({ name: 'meeting-notes', description: 'ignored', prompt: 'p', label: 'Notes' })).toBe(
      '🗒️ Notes',
    );
  });

  it('falls back to the generic emoji + title-cased name when neither emoji nor label is present', () => {
    expect(formatTemplateLabel({ name: 'action-items', description: 'ignored', prompt: 'p' })).toBe('🗒️ Action Items');
  });

  it('exposes a static, prefixed label for the transcript tab', () => {
    expect(TRANSCRIPT_TAB_LABEL).toBe('📄 Transcript');
  });
});
