import { TestBed } from '@angular/core/testing';

import { toMeetingId } from '../../core/models/meeting.model';
import { MeetingsError } from '../../core/models/recording-state.model';
import { InMemoryMeetingRepositoryFake } from './in-memory-meeting-repository.fake';

describe('InMemoryMeetingRepositoryFake — removeSpeaker parity with Rust remove_speaker', () => {
  let fake: InMemoryMeetingRepositoryFake;

  const seedMeeting = (): void => {
    fake.seed([
      {
        id: toMeetingId('m-1'),
        title: 'Standup',
        createdAt: new Date('2026-01-15T09:00:00Z'),
        durationSec: 60,
        summaries: [],
        archived: false,
        hasAudio: false,
        hasSystemTrack: false,
        droppedAudioChunks: 0,
        speakerNames: { 'others:1': 'Jean', 'others:2': 'Marie' },
        transcript: {
          segments: [
            { startSec: 0, endSec: 5, text: 'Hello', speaker: 'others:1' },
            { startSec: 5, endSec: 10, text: 'Hi', speaker: 'me' },
            { startSec: 10, endSec: 15, text: 'Hey', speaker: 'others:1' },
            { startSec: 15, endSec: 20, text: 'Bye', speaker: 'others:2' },
          ],
        },
      },
    ]);
  };

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [InMemoryMeetingRepositoryFake] });
    fake = TestBed.inject(InMemoryMeetingRepositoryFake);
  });

  it('drops the name entry and unassigns only the matching segments to bare "others"', async () => {
    seedMeeting();

    const updated = await fake.removeSpeaker(toMeetingId('m-1'), 'others:1');

    expect(updated.speakerNames).toEqual({ 'others:2': 'Marie' });
    expect(updated.transcript?.segments.map((segment) => segment.speaker)).toEqual([
      'others',
      'me',
      'others',
      'others:2',
    ]);
  });

  it('persists the removal in the fake store and is idempotent', async () => {
    seedMeeting();
    await fake.removeSpeaker(toMeetingId('m-1'), 'others:1');

    const reloaded = await fake.get(toMeetingId('m-1'));
    expect(reloaded.speakerNames).toEqual({ 'others:2': 'Marie' });

    const second = await fake.removeSpeaker(toMeetingId('m-1'), 'others:1');
    expect(second.speakerNames).toEqual({ 'others:2': 'Marie' });
    expect(second.transcript?.segments.map((segment) => segment.speaker)).toEqual([
      'others',
      'me',
      'others',
      'others:2',
    ]);
  });

  // Parity note: the Rust backend also clears `speaker_pinned` flags and
  // marks summaries stale. The Angular domain model has no per-segment pin
  // field (pins live only backend-side) and summary staleness is derived
  // from the returned Meeting, so there is nothing further to assert here.
  it('leaves other speakers and their names untouched', async () => {
    seedMeeting();

    const updated = await fake.removeSpeaker(toMeetingId('m-1'), 'others:1');

    expect(updated.transcript?.segments[1]).toEqual({ startSec: 5, endSec: 10, text: 'Hi', speaker: 'me' });
    expect(updated.transcript?.segments[3]).toEqual({ startSec: 15, endSec: 20, text: 'Bye', speaker: 'others:2' });
  });

  it('rejects with NOT_FOUND for an unknown meeting', async () => {
    seedMeeting();

    let caught: unknown;
    try {
      await fake.removeSpeaker(toMeetingId('missing'), 'others:1');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MeetingsError);
    expect((caught as MeetingsError).code).toBe('NOT_FOUND');
  });
});
