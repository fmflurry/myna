import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { toFolderId } from '../../core/models/folder.model';
import { FolderRepositoryPort } from '../../core/ports/folder-repository.port';
import { InMemoryFolderRepositoryFake } from '../testing/in-memory-folder-repository.fake';
import { DeleteFolderUseCase } from './delete-folder.usecase';

describe('DeleteFolderUseCase', () => {
  let useCase: DeleteFolderUseCase;
  let repository: InMemoryFolderRepositoryFake;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        DeleteFolderUseCase,
        InMemoryFolderRepositoryFake,
        { provide: FolderRepositoryPort, useExisting: InMemoryFolderRepositoryFake },
      ],
    });
    useCase = TestBed.inject(DeleteFolderUseCase);
    repository = TestBed.inject(InMemoryFolderRepositoryFake);
  });

  it('delegates to FolderRepositoryPort.delete exactly once with the given id', async () => {
    // Arrange
    const id = toFolderId('f-1');
    repository.seed([{ id, name: 'Work', createdAt: new Date(), position: 0 }]);
    const deleteSpy = vi.spyOn(repository, 'delete');

    // Act
    await useCase.execute(id);

    // Assert
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith(id);
    expect(await repository.list()).toEqual([]);
  });
});
