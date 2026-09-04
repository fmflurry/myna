import { toMeetingId } from '../../core/models/meeting.model';
import { InMemoryPreferencesFake } from '../testing/in-memory-preferences.fake';
import {
  DEFAULT_SUMMARY_INSTRUCTIONS_DRAFT,
  readDraft,
  summaryInstructionsKey,
  writeDraft,
} from './summary-instructions-preferences.util';

describe('summary-instructions-preferences util', () => {
  const preferences = new InMemoryPreferencesFake();

  it('builds the key as meetings.summaryInstructions.{meetingId}.{template}', () => {
    expect(summaryInstructionsKey(toMeetingId('m-1'), 'key-points')).toBe('meetings.summaryInstructions.m-1.key-points');
  });

  it('defaults to empty text with general guidelines included when nothing is stored', () => {
    expect(readDraft(preferences, summaryInstructionsKey(toMeetingId('missing'), 'key-points'))).toEqual({
      text: '',
      includeGeneral: true,
    });
  });

  it('returns the default on corrupt JSON instead of throwing', () => {
    const key = summaryInstructionsKey(toMeetingId('u-1'), 'key-points');
    preferences.set(key, '{not json');

    expect(() => readDraft(preferences, key)).not.toThrow();
    expect(readDraft(preferences, key)).toEqual(DEFAULT_SUMMARY_INSTRUCTIONS_DRAFT);
  });

  it('returns the default on well-formed JSON with the wrong field types', () => {
    const key = summaryInstructionsKey(toMeetingId('u-2'), 'key-points');
    preferences.set(key, JSON.stringify({ text: 42 }));

    expect(readDraft(preferences, key)).toEqual(DEFAULT_SUMMARY_INSTRUCTIONS_DRAFT);
  });

  it('returns the default on a JSON array (not an object)', () => {
    const key = summaryInstructionsKey(toMeetingId('u-3'), 'key-points');
    preferences.set(key, '[]');

    expect(readDraft(preferences, key)).toEqual(DEFAULT_SUMMARY_INSTRUCTIONS_DRAFT);
  });

  it('round-trips a draft through the fake PreferencesPort', () => {
    const key = summaryInstructionsKey(toMeetingId('u-4'), 'action-items');
    const draft = { text: 'Focus on decisions', includeGeneral: false };

    writeDraft(preferences, key, draft);

    expect(readDraft(preferences, key)).toEqual(draft);
  });
});
