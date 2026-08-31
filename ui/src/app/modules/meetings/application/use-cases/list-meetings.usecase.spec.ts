import { TestBed } from '@angular/core/testing';

import { toMeetingId } from '../../core/models/meeting.model';
import { MeetingRepositoryPort } from '../../core/ports/meeting-repository.port';
import { InMemoryMeetingRepositoryFake } from '../testing/in-memory-meeting-repository.fake';
import { ListMeetingsUseCase } from './list-meetings.usecase';

describe('ListMeetingsUseCase', () => {
  let useCase: ListMeetingsUseCase;
  let repository: InMemoryMeetingRepositoryFake;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        ListMeetingsUseCase,
        InMemoryMeetingRepositoryFake,
        { provide: MeetingRepositoryPort, useExisting: InMemoryMeetingRepositoryFake },
      ],
    });
    useCase = TestBed.inject(ListMeetingsUseCase);
    repository = TestBed.inject(InMemoryMeetingRepositoryFake);
  });

  it('returns an empty list when no meetings have been recorded', async () => {
    expect(await useCase.list()).toEqual([]);
  });

  it('returns every seeded meeting', async () => {
    repository.seed([
      { id: toMeetingId('m-1'), title: 'Standup', createdAt: new Date(), durationSec: 60, summaries: [], archived: false, hasAudio: false, hasSystemTrack: false, droppedAudioChunks: 0 },
    ]);

    const meetings = await useCase.list();

    expect(meetings.length).toBe(1);
    expect(meetings[0]?.title).toBe('Standup');
  });
});
