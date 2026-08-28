import { TestBed } from '@angular/core/testing';

import { toMeetingId } from '../../core/models/meeting.model';
import { PreferencesPort } from '../../core/ports/preferences.port';
import { RecorderPort } from '../../core/ports/recorder.port';
import { SummarizerPort } from '../../core/ports/summarizer.port';
import { TranscriberPort } from '../../core/ports/transcriber.port';
import { InMemoryPreferencesFake } from '../testing/in-memory-preferences.fake';
import { InMemoryRecorderFake } from '../testing/in-memory-recorder.fake';
import { InMemorySummarizerFake } from '../testing/in-memory-summarizer.fake';
import { InMemoryTranscriberFake } from '../testing/in-memory-transcriber.fake';
import { MeetingsStore } from './meetings.store';

describe('MeetingsStore meetings-list mutators', () => {
  let store: MeetingsStore;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        MeetingsStore,
        InMemoryRecorderFake,
        { provide: RecorderPort, useExisting: InMemoryRecorderFake },
        InMemoryTranscriberFake,
        { provide: TranscriberPort, useExisting: InMemoryTranscriberFake },
        { provide: SummarizerPort, useClass: InMemorySummarizerFake },
        { provide: PreferencesPort, useClass: InMemoryPreferencesFake },
      ],
    });
    store = TestBed.inject(MeetingsStore);
  });

  it('never mutates the meetings signal in place', () => {
    const previous = store.meetings();

    store.setMeetings([
      { id: toMeetingId('m-1'), title: 'Standup', createdAt: new Date(), durationSec: 0, summaries: [], archived: false, hasAudio: false },
    ]);

    expect(store.meetings()).not.toBe(previous);
  });

  it('updateMeeting replaces the matching entry in the meetings list without mutating it in place', () => {
    const original = [
      { id: toMeetingId('m-1'), title: 'Standup', createdAt: new Date(), durationSec: 0, summaries: [], archived: false, hasAudio: false },
      { id: toMeetingId('m-2'), title: 'Planning', createdAt: new Date(), durationSec: 0, summaries: [], archived: false, hasAudio: false },
    ];
    store.setMeetings(original);
    const previous = store.meetings();

    store.updateMeeting({ ...original[1]!, title: 'Roadmap planning' });

    expect(store.meetings()).not.toBe(previous);
    expect(store.meetings().map((meeting) => meeting.title)).toEqual(['Standup', 'Roadmap planning']);
  });

  it('updateMeeting mirrors onto selectedMeeting when it matches the selected id', () => {
    const meeting = {
      id: toMeetingId('m-1'),
      title: 'Standup',
      createdAt: new Date(),
      durationSec: 0,
      summaries: [],
      archived: false,
      hasAudio: false,
    };
    store.setMeetings([meeting]);
    store.setSelectedMeeting(meeting);

    store.updateMeeting({ ...meeting, title: 'Renamed standup' });

    expect(store.selectedMeeting()?.title).toBe('Renamed standup');
  });

  it('updateMeeting leaves selectedMeeting untouched when it belongs to a different meeting', () => {
    const selected = {
      id: toMeetingId('m-1'),
      title: 'Standup',
      createdAt: new Date(),
      durationSec: 0,
      summaries: [],
      archived: false,
      hasAudio: false,
    };
    const other = { ...selected, id: toMeetingId('m-2'), title: 'Planning' };
    store.setMeetings([selected, other]);
    store.setSelectedMeeting(selected);

    store.updateMeeting({ ...other, title: 'Roadmap planning' });

    expect(store.selectedMeeting()?.title).toBe('Standup');
  });

  it('addMeeting prepends a new meeting ahead of the existing list without mutating it in place', () => {
    const existing = [
      { id: toMeetingId('m-1'), title: 'Standup', createdAt: new Date(), durationSec: 0, summaries: [], archived: false, hasAudio: false },
    ];
    store.setMeetings(existing);
    const previous = store.meetings();
    const fresh = {
      id: toMeetingId('m-2'),
      title: 'Planning',
      createdAt: new Date(),
      durationSec: 0,
      summaries: [],
      archived: false,
      hasAudio: false,
    };

    store.addMeeting(fresh);

    expect(store.meetings()).not.toBe(previous);
    expect(store.meetings().map((meeting) => meeting.id)).toEqual([toMeetingId('m-2'), toMeetingId('m-1')]);
  });

  it('addMeeting upserts by id: replaces the existing entry in place of the list rather than duplicating it', () => {
    const original = {
      id: toMeetingId('m-1'),
      title: 'Standup',
      createdAt: new Date(),
      durationSec: 0,
      summaries: [],
      archived: false,
      hasAudio: false,
    };
    store.setMeetings([original]);

    store.addMeeting({ ...original, title: 'Standup (updated)' });

    expect(store.meetings().length).toBe(1);
    expect(store.meetings()[0]?.title).toBe('Standup (updated)');
  });
});
