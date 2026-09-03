import type { SummaryTemplate } from '../../../core/models/summary-template.model';
import {
  BUILT_IN_TEMPLATE_TAB_ORDER,
  diarizeDisabledReason,
  isDiarizeDisabled,
  sortTemplatesForDisplay,
} from './meeting-detail-pane.component.support';

const template = (name: string): SummaryTemplate => ({ name, description: `${name} desc`, prompt: 'p' });

describe('sortTemplatesForDisplay', () => {
  it('renders the four built-ins as Notes, Key Points, Decisions, Action Items from the backend alphabetical order', () => {
    // The Rust backend lists templates sorted by name: action-items, decisions, key-points, meeting-notes.
    const sorted = sortTemplatesForDisplay([
      template('action-items'),
      template('decisions'),
      template('key-points'),
      template('meeting-notes'),
    ]);

    expect(sorted.map((candidate) => candidate.name)).toEqual([
      'meeting-notes',
      'key-points',
      'decisions',
      'action-items',
    ]);
  });

  it('keeps custom templates after the built-ins in their incoming relative order', () => {
    const sorted = sortTemplatesForDisplay([
      template('weekly-recap'),
      template('action-items'),
      template('custom-follow-ups'),
      template('meeting-notes'),
    ]);

    expect(sorted.map((candidate) => candidate.name)).toEqual([
      'meeting-notes',
      'action-items',
      'weekly-recap',
      'custom-follow-ups',
    ]);
  });

  it('leaves the order untouched when no built-ins are present', () => {
    const sorted = sortTemplatesForDisplay([template('zeta'), template('alpha'), template('mid')]);

    expect(sorted.map((candidate) => candidate.name)).toEqual(['zeta', 'alpha', 'mid']);
  });

  it('returns a copy and never mutates the caller array', () => {
    const input = [template('action-items'), template('meeting-notes')];

    sortTemplatesForDisplay(input);

    expect(input.map((candidate) => candidate.name)).toEqual(['action-items', 'meeting-notes']);
  });

  it('orders exactly the four known built-in names', () => {
    expect(BUILT_IN_TEMPLATE_TAB_ORDER).toEqual(['meeting-notes', 'key-points', 'decisions', 'action-items']);
  });
});

describe('isDiarizeDisabled', () => {
  it('is disabled, not crashing, when the diarization models are missing', () => {
    // Arrange / Act
    const disabled = isDiarizeDisabled(false, true, false, false, false, false);

    // Assert
    expect(disabled).toBe(true);
  });

  it('is disabled when the meeting has no system-audio track', () => {
    expect(isDiarizeDisabled(true, false, false, false, false, false)).toBe(true);
  });

  it('is disabled while a recording, import, or diarize is already in flight', () => {
    expect(isDiarizeDisabled(true, true, true, false, false, false)).toBe(true);
    expect(isDiarizeDisabled(true, true, false, true, false, false)).toBe(true);
    expect(isDiarizeDisabled(true, true, false, false, true, false)).toBe(true);
  });

  it('is disabled while a recording is in progress, even when everything else is otherwise ready', () => {
    expect(isDiarizeDisabled(true, true, false, false, false, true)).toBe(true);
  });

  it('is enabled once models are present, a system track exists, and nothing else is running', () => {
    expect(isDiarizeDisabled(true, true, false, false, false, false)).toBe(false);
  });
});

describe('diarizeDisabledReason', () => {
  it('returns the in-app download prompt when the diarization models are missing', () => {
    // Arrange / Act
    const reason = diarizeDisabledReason(false, true, '/Users/me/myna/models', false);

    // Assert
    expect(reason).toBe('Speaker detection needs ~45 MB extra models.');
  });

  it('explains a missing system-audio track once models are present', () => {
    expect(diarizeDisabledReason(true, false, '/Users/me/myna/models', false)).toBe(
      'No system audio was captured for this meeting.',
    );
  });

  it('is undefined once models are present and a system track exists — nothing durable to explain', () => {
    expect(diarizeDisabledReason(true, true, '/Users/me/myna/models', false)).toBeUndefined();
  });

  it('explains that speaker detection waits for the recording to stop while one is in progress', () => {
    expect(diarizeDisabledReason(true, true, '/Users/me/myna/models', true)).toBe(
      'Speaker detection runs on the finished recording — available once you stop recording.',
    );
  });

  it('the recording reason wins over missing models or a missing system track while recording', () => {
    expect(diarizeDisabledReason(false, false, '/Users/me/myna/models', true)).toBe(
      'Speaker detection runs on the finished recording — available once you stop recording.',
    );
  });
});
