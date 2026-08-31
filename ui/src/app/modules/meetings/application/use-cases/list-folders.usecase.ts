import { Injectable, inject } from '@angular/core';

import type { Folder } from '../../core/models/folder.model';
import { FolderRepositoryPort } from '../../core/ports/folder-repository.port';

@Injectable()
export class ListFoldersUseCase {
  private readonly repository = inject(FolderRepositoryPort);

  async execute(): Promise<readonly Folder[]> {
    return this.repository.list();
  }
}
