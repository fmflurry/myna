import type { Observable } from 'rxjs';

import type { UpdateCheck, UpdateConsent, UpdateInstallResult } from '../models/update.model';

/**
 * One progress tick of an in-flight update install — the NORMALIZED
 * adapter output of `update://progress`, NOT the raw wire shape (that is
 * `UpdateProgressWireDto` in `infrastructure/tauri/events.ts`, where
 * `totalBytes` is also nullable). `percent` is 0..100 when the server
 * sent a usable `Content-Length`, and **`null` when it did not** — an
 * indeterminate tick. Adapters must pass `null` through (deriving a
 * number from the byte counters only when `totalBytes > 0`); coercing it
 * to 0 fabricates progress the backend never reported.
 */
export interface UpdateInstallProgress {
  readonly downloadedBytes: number;
  readonly totalBytes: number;
  readonly percent: number | null;
}

/**
 * Terminal event of an update install, emitted on `update://done`. Same
 * shape as {@link UpdateInstallResult} — the result arrives BOTH as the
 * `install_update` resolve value and as this event (first terminal wins).
 */
export interface UpdateInstallDone {
  readonly success: boolean;
  readonly version: string | null;
  readonly message: string | null;
}

/**
 * Maps onto the frozen Rust commands `update_consent` / `set_update_consent`
 * / `check_for_update` / `install_update` / `restart_app`, plus the
 * `update://progress` / `update://done` events. `install()` resolves with
 * the terminal outcome, but progress and (racy) terminal state also arrive
 * via the event streams — mirroring the `ModelInitializerPort` pattern.
 */
export abstract class UpdatesPort {
  abstract consent(): Promise<UpdateConsent>;
  abstract setConsent(consent: UpdateConsent): Promise<void>;
  abstract check(manual: boolean): Promise<UpdateCheck>;
  abstract install(): Promise<UpdateInstallResult>;
  abstract restart(): Promise<void>;
  abstract installProgress(): Observable<UpdateInstallProgress>;
  abstract installDone(): Observable<UpdateInstallDone>;
}
