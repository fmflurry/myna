import { Injectable, inject } from '@angular/core';

import { StorageLocationPort } from '../../core/ports/storage-location.port';

/** Reads the current effective storage location; the server is the source of truth. */
@Injectable()
export class GetStorageLocationUseCase {
  private readonly storageLocation = inject(StorageLocationPort);

  async get(): Promise<string> {
    return this.storageLocation.get();
  }
}
