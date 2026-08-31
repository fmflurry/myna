import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { toFolderId } from '../../core/models/folder.model';
import { FolderRepositoryPort } from '../../core/ports/folder-repository.port';
import { InMemoryFolderRepositoryFake } from '../testing/in-memory-folder-repository.fake';
import { ListFoldersUseCase } from './list-folders.usecase';

describe('ListFoldersUseCase', () => {
  let useCase: ListFoldersUseCase;
  let repository: InMemoryFolderRepositoryFake;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        ListFoldersUseCase,
        InMemoryFolderRepositoryFake,
        { provide: FolderRepositoryPort, useExisting: InMemoryFolderRepositoryFake },
      ],
    });
    useCase = TestBed.inject(ListFoldersUseCase);
    repository = TestBed.inject(InMemoryFolderRepositoryFake);
  });

  it('delegates to FolderRepositoryPort.list exactly once', async () => {
    // Arrange
    const listSpy = vi.spyOn(repository, 'list');
    repository.seed([{ id: toFolderId('f-1'), name: 'Work', createdAt: new Date(), position: 0 }]);

    // Act
    const folders = await useCase.execute();

    // Assert
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(folders.length).toBe(1);
    expect(folders[0]?.name).toBe('Work');
  });
});
