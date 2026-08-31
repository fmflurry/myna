import { Injectable, inject } from '@angular/core';

import type { Folder, FolderId } from '../../core/models/folder.model';
import { FolderRepositoryPort } from '../../core/ports/folder-repository.port';

@Injectable()
export class RenameFolderUseCase {
  private readonly repository = inject(FolderRepositoryPort);

  async execute(id: FolderId, name: string): Promise<Folder> {
    return this.repository.rename(id, name);
  }
}
