import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { toFolderId } from '../../core/models/folder.model';
import { FolderRepositoryPort } from '../../core/ports/folder-repository.port';
import { InMemoryFolderRepositoryFake } from '../testing/in-memory-folder-repository.fake';
import { RenameFolderUseCase } from './rename-folder.usecase';

describe('RenameFolderUseCase', () => {
  let useCase: RenameFolderUseCase;
  let repository: InMemoryFolderRepositoryFake;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        RenameFolderUseCase,
        InMemoryFolderRepositoryFake,
        { provide: FolderRepositoryPort, useExisting: InMemoryFolderRepositoryFake },
      ],
    });
    useCase = TestBed.inject(RenameFolderUseCase);
    repository = TestBed.inject(InMemoryFolderRepositoryFake);
  });

  it('delegates to FolderRepositoryPort.rename exactly once with the given id and name', async () => {
    // Arrange
    const id = toFolderId('f-1');
    repository.seed([{ id, name: 'Work', createdAt: new Date(), position: 0 }]);
    const renameSpy = vi.spyOn(repository, 'rename');

    // Act
    const folder = await useCase.execute(id, 'Work renamed');

    // Assert
    expect(renameSpy).toHaveBeenCalledTimes(1);
    expect(renameSpy).toHaveBeenCalledWith(id, 'Work renamed');
    expect(folder.name).toBe('Work renamed');
  });
});
