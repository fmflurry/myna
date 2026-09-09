import { Injectable, inject } from '@angular/core';

import type { StorageLocation } from '../../core/ports/storage-location.port';
import { StorageLocationPort } from '../../core/ports/storage-location.port';

/**
 * Moves the archive to a new location (`set`) or back to the default root
 * (`reset`). Thin over the port — the store slot updates only once the port
 * write succeeds, so callers stay retry-safe.
 */
@Injectable()
export class SetStorageLocationUseCase {
  private readonly storageLocation = inject(StorageLocationPort);

  async set(path: string, moveExisting = true): Promise<StorageLocation> {
    return this.storageLocation.set(path, moveExisting);
  }

  async reset(moveExisting = true): Promise<StorageLocation> {
    return this.storageLocation.reset(moveExisting);
  }
}
