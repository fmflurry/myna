import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { toFolderId } from '../../core/models/folder.model';
import { toMeetingId } from '../../core/models/meeting.model';
import { MeetingRepositoryPort } from '../../core/ports/meeting-repository.port';
import { InMemoryMeetingRepositoryFake } from '../testing/in-memory-meeting-repository.fake';
import { SetMeetingFolderUseCase } from './set-meeting-folder.usecase';

describe('SetMeetingFolderUseCase', () => {
  let useCase: SetMeetingFolderUseCase;
  let repository: InMemoryMeetingRepositoryFake;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        SetMeetingFolderUseCase,
        InMemoryMeetingRepositoryFake,
        { provide: MeetingRepositoryPort, useExisting: InMemoryMeetingRepositoryFake },
      ],
    });
    useCase = TestBed.inject(SetMeetingFolderUseCase);
    repository = TestBed.inject(InMemoryMeetingRepositoryFake);
  });

  it('delegates to MeetingRepositoryPort.setFolder exactly once with the given id and folderId', async () => {
    // Arrange
    const id = toMeetingId('m-1');
    const folderId = toFolderId('f-1');
    repository.seed([
      { id, title: 'Standup', createdAt: new Date(), durationSec: 0, summaries: [], archived: false, hasAudio: false, hasSystemTrack: false, droppedAudioChunks: 0 },
    ]);
    const setFolderSpy = vi.spyOn(repository, 'setFolder');

    // Act
    const meeting = await useCase.execute(id, folderId);

    // Assert
    expect(setFolderSpy).toHaveBeenCalledTimes(1);
    expect(setFolderSpy).toHaveBeenCalledWith(id, folderId);
    expect(meeting.folderId).toBe(folderId);
  });

  it('delegates a null folderId (clearing the folder) through to the repository', async () => {
    // Arrange
    const id = toMeetingId('m-1');
    repository.seed([
      { id, title: 'Standup', createdAt: new Date(), durationSec: 0, summaries: [], archived: false, hasAudio: false, hasSystemTrack: false, droppedAudioChunks: 0 },
    ]);
    const setFolderSpy = vi.spyOn(repository, 'setFolder');

    // Act
    await useCase.execute(id, null);

    // Assert
    expect(setFolderSpy).toHaveBeenCalledWith(id, null);
  });
});
