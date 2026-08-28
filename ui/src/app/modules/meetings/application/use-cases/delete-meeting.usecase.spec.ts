import { TestBed } from '@angular/core/testing';

import { toMeetingId } from '../../core/models/meeting.model';
import { MeetingRepositoryPort } from '../../core/ports/meeting-repository.port';
import { InMemoryMeetingRepositoryFake } from '../testing/in-memory-meeting-repository.fake';
import { DeleteMeetingUseCase } from './delete-meeting.usecase';

describe('DeleteMeetingUseCase', () => {
  let useCase: DeleteMeetingUseCase;
  let repository: InMemoryMeetingRepositoryFake;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        DeleteMeetingUseCase,
        InMemoryMeetingRepositoryFake,
        { provide: MeetingRepositoryPort, useExisting: InMemoryMeetingRepositoryFake },
      ],
    });
    useCase = TestBed.inject(DeleteMeetingUseCase);
    repository = TestBed.inject(InMemoryMeetingRepositoryFake);
  });

  it('removes the meeting matching the given id', async () => {
    const id = toMeetingId('m-7');
    repository.seed([{ id, title: 'Planning', createdAt: new Date(), durationSec: 30, summaries: [], archived: false }]);

    await useCase.delete(id);

    expect(await repository.list()).toEqual([]);
  });

  it('leaves other meetings untouched', async () => {
    const keep = toMeetingId('keep');
    const remove = toMeetingId('remove');
    repository.seed([
      { id: keep, title: 'Keep me', createdAt: new Date(), durationSec: 10, summaries: [], archived: false },
      { id: remove, title: 'Remove me', createdAt: new Date(), durationSec: 10, summaries: [], archived: false },
    ]);

    await useCase.delete(remove);

    const remaining = await repository.list();
    expect(remaining.length).toBe(1);
    expect(remaining[0]?.id).toBe(keep);
  });
});
