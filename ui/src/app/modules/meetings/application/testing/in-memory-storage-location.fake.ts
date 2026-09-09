import { Injectable } from '@angular/core';

import type { StorageLocation } from '../../core/ports/storage-location.port';
import { StorageLocationPort } from '../../core/ports/storage-location.port';

const DEFAULT_PATH = '/tmp/myna-data';

/** In-memory StorageLocationPort implementation for specs and the placeholder providers. */
@Injectable()
export class InMemoryStorageLocationFake extends StorageLocationPort {
  private location: StorageLocation = { path: DEFAULT_PATH, restartRequired: false };
  /** Last `moveExisting` flag received via `set` or `reset`; `undefined` until either runs. */
  lastMoveExisting: boolean | undefined;

  override async get(): Promise<string> {
    return this.location.path;
  }

  override async set(path: string, moveExisting = true): Promise<StorageLocation> {
    this.lastMoveExisting = moveExisting;
    this.location = { path, restartRequired: path !== this.location.path };
    return this.location;
  }

  override async reset(moveExisting = true): Promise<StorageLocation> {
    this.lastMoveExisting = moveExisting;
    this.location = { path: DEFAULT_PATH, restartRequired: this.location.path !== DEFAULT_PATH };
    return this.location;
  }

  /** Test helper: replace the in-memory location. */
  seed(location: StorageLocation): void {
    this.location = location;
  }
}
