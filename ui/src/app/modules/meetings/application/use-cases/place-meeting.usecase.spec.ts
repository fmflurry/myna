import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { toFolderId } from '../../core/models/folder.model';
import { toMeetingId } from '../../core/models/meeting.model';
import { MeetingRepositoryPort } from '../../core/ports/meeting-repository.port';
import { InMemoryMeetingRepositoryFake } from '../testing/in-memory-meeting-repository.fake';
import { PlaceMeetingUseCase } from './place-meeting.usecase';

describe('PlaceMeetingUseCase', () => {
  let useCase: PlaceMeetingUseCase;
  let repository: InMemoryMeetingRepositoryFake;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        PlaceMeetingUseCase,
        InMemoryMeetingRepositoryFake,
        { provide: MeetingRepositoryPort, useExisting: InMemoryMeetingRepositoryFake },
      ],
    });
    useCase = TestBed.inject(PlaceMeetingUseCase);
    repository = TestBed.inject(InMemoryMeetingRepositoryFake);
  });

  it('delegates to MeetingRepositoryPort.place exactly once with the given id, folderId, archived, previousId and nextId', async () => {
    // Arrange
    const id = toMeetingId('m-1');
    const folderId = toFolderId('f-1');
    const previousId = toMeetingId('m-0');
    const nextId = toMeetingId('m-2');
    repository.seed([
      {
        id,
        title: 'Standup',
        createdAt: new Date(),
        durationSec: 0,
        summaries: [],
        archived: false,
        hasAudio: false,
        hasSystemTrack: false,
        droppedAudioChunks: 0,
      },
    ]);
    const placeSpy = vi.spyOn(repository, 'place');

    // Act
    const meeting = await useCase.execute(id, folderId, true, previousId, nextId);

    // Assert
    expect(placeSpy).toHaveBeenCalledTimes(1);
    expect(placeSpy).toHaveBeenCalledWith(id, folderId, true, previousId, nextId);
    expect(meeting.id).toBe(id);
  });
});
