import { Injectable } from '@angular/core';

import type { StorageLocation } from '../../core/ports/storage-location.port';
import { StorageLocationPort } from '../../core/ports/storage-location.port';
import { invokeCommand } from './ipc';

/**
 * `StorageLocationPort` implementation backed by the Tauri IPC command
 * surface. Reaches the runtime exclusively through `invokeCommand`, so the
 * Tauri boundary stays inside the two allowlisted files.
 */
@Injectable()
export class TauriStorageLocationAdapter extends StorageLocationPort {
  override async get(): Promise<string> {
    return invokeCommand('get_storage_location', {});
  }

  override async set(path: string, moveExisting?: boolean): Promise<StorageLocation> {
    const dto = await invokeCommand(
      'set_storage_location',
      moveExisting === undefined ? { path } : { path, moveExisting },
    );
    return { path: dto.path, restartRequired: dto.restartRequired };
  }

  override async reset(moveExisting?: boolean): Promise<StorageLocation> {
    const dto = await invokeCommand(
      'reset_storage_location',
      moveExisting === undefined ? {} : { moveExisting },
    );
    return { path: dto.path, restartRequired: dto.restartRequired };
  }
}
