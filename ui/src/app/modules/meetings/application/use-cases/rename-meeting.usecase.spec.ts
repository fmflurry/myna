import { TestBed } from '@angular/core/testing';

import { toMeetingId } from '../../core/models/meeting.model';
import { MeetingRepositoryPort } from '../../core/ports/meeting-repository.port';
import { InMemoryMeetingRepositoryFake } from '../testing/in-memory-meeting-repository.fake';
import { RenameMeetingUseCase } from './rename-meeting.usecase';

describe('RenameMeetingUseCase', () => {
  let useCase: RenameMeetingUseCase;
  let repository: InMemoryMeetingRepositoryFake;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        RenameMeetingUseCase,
        InMemoryMeetingRepositoryFake,
        { provide: MeetingRepositoryPort, useExisting: InMemoryMeetingRepositoryFake },
      ],
    });
    useCase = TestBed.inject(RenameMeetingUseCase);
    repository = TestBed.inject(InMemoryMeetingRepositoryFake);
  });

  it('returns the renamed meeting with the new title', async () => {
    const id = toMeetingId('m-7');
    repository.seed([{ id, title: 'Planning', createdAt: new Date(), durationSec: 30, summaries: [], archived: false }]);

    const renamed = await useCase.rename(id, 'Roadmap planning');

    expect(renamed.title).toBe('Roadmap planning');
    expect(renamed.id).toBe(id);
  });

  it('leaves other meetings untouched', async () => {
    const target = toMeetingId('target');
    const other = toMeetingId('other');
    repository.seed([
      { id: target, title: 'Old name', createdAt: new Date(), durationSec: 10, summaries: [], archived: false },
      { id: other, title: 'Untouched', createdAt: new Date(), durationSec: 10, summaries: [], archived: false },
    ]);

    await useCase.rename(target, 'New name');

    const remaining = await repository.list();
    expect(remaining.find((meeting) => meeting.id === other)?.title).toBe('Untouched');
  });

  it('rejects renaming a meeting that does not exist', async () => {
    let caught: unknown;
    try {
      await useCase.rename(toMeetingId('missing'), 'New name');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
  });
});
