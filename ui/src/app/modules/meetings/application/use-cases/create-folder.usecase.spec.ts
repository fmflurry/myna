import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { FolderRepositoryPort } from '../../core/ports/folder-repository.port';
import { InMemoryFolderRepositoryFake } from '../testing/in-memory-folder-repository.fake';
import { CreateFolderUseCase } from './create-folder.usecase';

describe('CreateFolderUseCase', () => {
  let useCase: CreateFolderUseCase;
  let repository: InMemoryFolderRepositoryFake;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        CreateFolderUseCase,
        InMemoryFolderRepositoryFake,
        { provide: FolderRepositoryPort, useExisting: InMemoryFolderRepositoryFake },
      ],
    });
    useCase = TestBed.inject(CreateFolderUseCase);
    repository = TestBed.inject(InMemoryFolderRepositoryFake);
  });

  it('delegates to FolderRepositoryPort.create exactly once with the given name', async () => {
    // Arrange
    const createSpy = vi.spyOn(repository, 'create');

    // Act
    const folder = await useCase.execute('Personal');

    // Assert
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith('Personal');
    expect(folder.name).toBe('Personal');
  });
});
