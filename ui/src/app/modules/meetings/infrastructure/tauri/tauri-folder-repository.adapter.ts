import { Injectable } from '@angular/core';

import type { Folder, FolderId } from '../../core/models/folder.model';
import { FolderRepositoryPort } from '../../core/ports/folder-repository.port';
import { mapFolderDtoToDomain } from '../mappers/folder.mapper';
import { invokeCommand } from './ipc';

/** `FolderRepositoryPort` implementation backed by the Tauri IPC command surface. */
@Injectable()
export class TauriFolderRepositoryAdapter extends FolderRepositoryPort {
  override async list(): Promise<readonly Folder[]> {
    const dtos = await invokeCommand('list_folders', {});
    return dtos.map(mapFolderDtoToDomain);
  }

  override async create(name: string): Promise<Folder> {
    const dto = await invokeCommand('create_folder', { name });
    return mapFolderDtoToDomain(dto);
  }

  override async rename(id: FolderId, name: string): Promise<Folder> {
    const dto = await invokeCommand('rename_folder', { folderId: id, name });
    return mapFolderDtoToDomain(dto);
  }

  override async delete(id: FolderId): Promise<void> {
    await invokeCommand('delete_folder', { folderId: id });
  }
}
