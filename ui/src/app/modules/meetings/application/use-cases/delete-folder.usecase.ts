import { Injectable, inject } from '@angular/core';

import type { FolderId } from '../../core/models/folder.model';
import { FolderRepositoryPort } from '../../core/ports/folder-repository.port';

@Injectable()
export class DeleteFolderUseCase {
  private readonly repository = inject(FolderRepositoryPort);

  async execute(id: FolderId): Promise<void> {
    await this.repository.delete(id);
  }
}
