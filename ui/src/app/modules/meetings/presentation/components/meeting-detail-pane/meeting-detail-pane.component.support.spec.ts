import { diarizeDisabledReason, isDiarizeDisabled } from './meeting-detail-pane.component.support';

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
