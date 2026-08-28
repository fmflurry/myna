import { TestBed } from '@angular/core/testing';

import { toMeetingId } from '../../core/models/meeting.model';
import { MeetingsError } from '../../core/models/recording-state.model';
import { MeetingRepositoryPort } from '../../core/ports/meeting-repository.port';
import { InMemoryMeetingRepositoryFake } from '../testing/in-memory-meeting-repository.fake';
import { OpenMeetingUseCase } from './open-meeting.usecase';

describe('OpenMeetingUseCase', () => {
  let useCase: OpenMeetingUseCase;
  let repository: InMemoryMeetingRepositoryFake;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        OpenMeetingUseCase,
        InMemoryMeetingRepositoryFake,
        { provide: MeetingRepositoryPort, useExisting: InMemoryMeetingRepositoryFake },
      ],
    });
    useCase = TestBed.inject(OpenMeetingUseCase);
    repository = TestBed.inject(InMemoryMeetingRepositoryFake);
  });

  it('returns the meeting matching the given id', async () => {
    const id = toMeetingId('m-42');
    repository.seed([{ id, title: 'Retro', createdAt: new Date(), durationSec: 120, summaries: [] }]);

    const meeting = await useCase.open(id);

    expect(meeting.title).toBe('Retro');
  });

  it('returns a NotFound error when the meeting does not exist', async () => {
    let caught: unknown;
    try {
      await useCase.open(toMeetingId('missing'));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MeetingsError);
    expect((caught as MeetingsError).code).toBe('NOT_FOUND');
  });
});
