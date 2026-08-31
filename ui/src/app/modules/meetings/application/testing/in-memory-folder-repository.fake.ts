import { Injectable } from '@angular/core';

import type { Folder, FolderId } from '../../core/models/folder.model';
import { toFolderId, withName } from '../../core/models/folder.model';
import { MeetingsError } from '../../core/models/recording-state.model';
import { FolderRepositoryPort } from '../../core/ports/folder-repository.port';

/** In-memory FolderRepositoryPort implementation for specs and the placeholder providers. */
@Injectable()
export class InMemoryFolderRepositoryFake extends FolderRepositoryPort {
  private folders: readonly Folder[] = [];
  private nextId = 1;
  private nextPosition = 0;
  private createError: MeetingsError | null = null;

  override async list(): Promise<readonly Folder[]> {
    return this.folders;
  }

  override async create(name: string): Promise<Folder> {
    if (this.createError) {
      const error = this.createError;
      this.createError = null;
      throw error;
    }
    const created: Folder = {
      id: toFolderId(`f-${this.nextId++}`),
      name,
      createdAt: new Date(),
      position: this.nextPosition++,
    };
    this.folders = [...this.folders, created];
    return created;
  }

  override async rename(id: FolderId, name: string): Promise<Folder> {
    const found = this.folders.find((folder) => folder.id === id);
    if (!found) {
      throw new MeetingsError('NOT_FOUND', `Folder ${id} was not found.`);
    }
    const renamed = withName(found, name);
    this.folders = this.folders.map((folder) => (folder.id === id ? renamed : folder));
    return renamed;
  }

  override async delete(id: FolderId): Promise<void> {
    this.folders = this.folders.filter((folder) => folder.id !== id);
  }

  /** Test helper: replace the in-memory folder collection. */
  seed(folders: readonly Folder[]): void {
    this.folders = folders;
  }

  /** Test helper: makes the NEXT create() call reject with the given error, then resets to normal behavior. */
  failNextCreate(error: MeetingsError): void {
    this.createError = error;
  }
}
