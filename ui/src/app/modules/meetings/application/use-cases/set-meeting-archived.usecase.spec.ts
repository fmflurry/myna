import { TestBed } from '@angular/core/testing';

import { toMeetingId } from '../../core/models/meeting.model';
import { MeetingRepositoryPort } from '../../core/ports/meeting-repository.port';
import { InMemoryMeetingRepositoryFake } from '../testing/in-memory-meeting-repository.fake';
import { SetMeetingArchivedUseCase } from './set-meeting-archived.usecase';

describe('SetMeetingArchivedUseCase', () => {
  let useCase: SetMeetingArchivedUseCase;
  let repository: InMemoryMeetingRepositoryFake;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        SetMeetingArchivedUseCase,
        InMemoryMeetingRepositoryFake,
        { provide: MeetingRepositoryPort, useExisting: InMemoryMeetingRepositoryFake },
      ],
    });
    useCase = TestBed.inject(SetMeetingArchivedUseCase);
    repository = TestBed.inject(InMemoryMeetingRepositoryFake);
  });

  it('archives a seeded meeting', async () => {
    const id = toMeetingId('m-7');
    repository.seed([
      { id, title: 'Planning', createdAt: new Date(), durationSec: 30, summaries: [], archived: false, hasAudio: false, hasSystemTrack: false, droppedAudioChunks: 0 },
    ]);

    const archived = await useCase.set(id, true);

    expect(archived.archived).toBe(true);
    expect(archived.id).toBe(id);
  });

  it('unarchives back', async () => {
    const id = toMeetingId('m-7');
    repository.seed([
      { id, title: 'Planning', createdAt: new Date(), durationSec: 30, summaries: [], archived: true, hasAudio: false, hasSystemTrack: false, droppedAudioChunks: 0 },
    ]);

    const unarchived = await useCase.set(id, false);

    expect(unarchived.archived).toBe(false);
  });

  it('leaves other meetings untouched', async () => {
    const target = toMeetingId('target');
    const other = toMeetingId('other');
    repository.seed([
      { id: target, title: 'Old name', createdAt: new Date(), durationSec: 10, summaries: [], archived: false, hasAudio: false, hasSystemTrack: false, droppedAudioChunks: 0 },
      { id: other, title: 'Untouched', createdAt: new Date(), durationSec: 10, summaries: [], archived: false, hasAudio: false, hasSystemTrack: false, droppedAudioChunks: 0 },
    ]);

    await useCase.set(target, true);

    const remaining = await repository.list();
    expect(remaining.find((meeting) => meeting.id === other)?.archived).toBe(false);
  });

  it('rejects an unknown id', async () => {
    let caught: unknown;
    try {
      await useCase.set(toMeetingId('missing'), true);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
  });
});
