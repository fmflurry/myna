import { Injectable } from '@angular/core';
import { save } from '@tauri-apps/plugin-dialog';

import { FileDialogPort } from '../../core/ports/file-dialog.port';

/**
 * The second (and last) file in `ui/src` allowed to import a Tauri
 * package directly, alongside `ipc.ts`. The dialog plugin's JS client
 * (`@tauri-apps/plugin-dialog`) issues its own `invoke()` call under the
 * hood, entirely separate from this module's `ipc.ts` command surface, so
 * it cannot be routed through {@link invokeCommand}.
 */
@Injectable()
export class TauriFileDialogAdapter extends FileDialogPort {
  override async save(suggestedName: string, extension: string): Promise<string | null> {
    return save({
      defaultPath: `${suggestedName}.${extension}`,
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
    });
  }
}
