import { Injectable } from '@angular/core';

import { PreferencesPort } from '../core/ports/preferences.port';

/**
 * `PreferencesPort` implementation backed by the browser's `localStorage`.
 * `localStorage` is a plain Web API — not a Tauri import — so this adapter
 * lives outside `infrastructure/tauri/` and needs no `invokeCommand` seam.
 *
 * Every access is guarded: `localStorage` can throw (private browsing,
 * exhausted quota, or a webview configuration that disables storage), and
 * a preference read/write must never crash the app — it just falls back to
 * "nothing stored" for that call.
 */
@Injectable()
export class LocalStoragePreferencesAdapter extends PreferencesPort {
  override get(key: string): string | null {
    try {
      return globalThis.localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  override set(key: string, value: string): void {
    try {
      globalThis.localStorage.setItem(key, value);
    } catch {
      // Storage unavailable — silently no-op. The caller's in-memory state
      // (the flurryx slot) remains authoritative for the rest of this session.
    }
  }
}
