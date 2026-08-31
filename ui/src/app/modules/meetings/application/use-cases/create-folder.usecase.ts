import { Injectable, inject } from '@angular/core';

import type { Folder } from '../../core/models/folder.model';
import { FolderRepositoryPort } from '../../core/ports/folder-repository.port';

@Injectable()
export class CreateFolderUseCase {
  private readonly repository = inject(FolderRepositoryPort);

  async execute(name: string): Promise<Folder> {
    return this.repository.create(name);
  }
}
