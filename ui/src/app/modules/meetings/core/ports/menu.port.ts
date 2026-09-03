import type { Observable } from 'rxjs';

/**
 * Maps onto the frozen Rust event `menu://settings`
 * (`app/src-tauri/src/events.rs` `MENU_SETTINGS`), emitted whenever the
 * user clicks the native application-menu "Settings…" item. The payload
 * carries no information (Rust sends `()`), so the stream is a pure
 * signal: each emission is one request to open settings. Navigation and
 * dialog decisions belong to the presentation layer — this port only
 * surfaces the event.
 */
export abstract class MenuPort {
  abstract settingsRequests(): Observable<void>;
}
