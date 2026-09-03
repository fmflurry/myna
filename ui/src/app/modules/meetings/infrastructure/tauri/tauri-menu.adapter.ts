import { Injectable } from '@angular/core';
import { map } from 'rxjs';
import type { Observable } from 'rxjs';

import { MenuPort } from '../../core/ports/menu.port';
import { onEvent } from './ipc';

/**
 * `MenuPort` implementation backed by the frozen Tauri event surface.
 * `menu://settings` carries a `null` wire payload (Rust emits `()`), so
 * the adapter maps every event to `undefined` and the port exposes a
 * pure `Observable<void>` signal stream.
 */
@Injectable()
export class TauriMenuAdapter extends MenuPort {
  override settingsRequests(): Observable<void> {
    return onEvent('menu://settings').pipe(map(() => undefined));
  }
}
