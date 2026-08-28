import { Injectable } from '@angular/core';

import { FileDialogPort } from '../../core/ports/file-dialog.port';

/** In-memory FileDialogPort implementation for specs and the placeholder providers. */
@Injectable()
export class InMemoryFileDialogFake extends FileDialogPort {
  private nextPath: string | null = '/tmp/meeting-export.md';

  override async save(suggestedName: string, extension: string): Promise<string | null> {
    void suggestedName;
    void extension;
    return this.nextPath;
  }

  /** Test helper: control the next save() result (a path, or null to simulate cancel). */
  seed(path: string | null): void {
    this.nextPath = path;
  }
}
