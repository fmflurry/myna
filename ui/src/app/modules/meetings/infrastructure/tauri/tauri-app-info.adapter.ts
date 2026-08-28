import { Injectable } from '@angular/core';

import { AppInfoPort } from '../../core/ports/app-info.port';
import { invokeCommand } from './ipc';

/** `AppInfoPort` implementation backed by the Tauri IPC command surface. */
@Injectable()
export class TauriAppInfoAdapter extends AppInfoPort {
  override async version(): Promise<string> {
    return invokeCommand('app_version', {});
  }
}
