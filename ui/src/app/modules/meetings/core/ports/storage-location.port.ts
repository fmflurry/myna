/**
 * The effective meetings data root the app booted on (`MYNA_DATA_DIR` >
 * persisted pointer > `~/myna` — meetings/preferences/folders only;
 * models always resolve to `~/myna/models` regardless of storage
 * location), plus whether applying it still needs an app restart.
 * `restartRequired` is true only right after a `set`/`reset` that actually
 * moved the location (the live stores are never re-rooted); a fresh `get`
 * always reports false — nothing is pending.
 */
export interface StorageLocation {
  readonly path: string;
  readonly restartRequired: boolean;
}

/** Maps onto the frozen Rust commands get_storage_location, set_storage_location, reset_storage_location. */
export abstract class StorageLocationPort {
  /** Returns the current effective storage location as a string path. */
  abstract get(): Promise<string>;
  /**
   * Moves the archive to `path`, remembers it, and resolves the new
   * location. Rejects while recording-adjacent work is in flight or `path`
   * fails validation — the persisted pointer is untouched on failure.
   * `moveExisting` selects migrate (`true`) vs ensure-dest + save
   * (`false`); omitted maps to `true` for back-compat.
   */
  abstract set(path: string, moveExisting?: boolean): Promise<StorageLocation>;
  /**
   * Moves the archive back to the default root and resolves the new
   * location. Same in-flight/validation contract as `set`. Idempotent.
   * `moveExisting` selects migrate (`true`) vs ensure-dest + save
   * (`false`); omitted maps to `true` for back-compat.
   */
  abstract reset(moveExisting?: boolean): Promise<StorageLocation>;
}
