# ADR 0015: User-Configurable Meetings Storage Location

**Status**: Decided (Phase 6)
**Date**: 2026-09-07
**Builds on**: [ADR 0003: Filesystem JSON Storage over SQLite](0003-meeting-storage.md), [ADR 0011: Disk-Backed Session State](0011-session-resilience.md)
**Context**: Meetings live under a fixed `~/myna/` data root. Users with small system disks — or who want meetings on iCloud Drive — have no supported way to move them. The dev-only `MYNA_DATA_DIR` override exists but is invisible in the UI, unvalidated, and can silently split data across two roots. Phase 6 makes the storage location user-configurable with a precedence chain, safe migration, and loud failure instead of silent split.

> **Numbering note:** formerly filed as `0012-storage-location.md`; renumbered to `0015` on 2026-09-07 because `0012` is taken by user-initiated-in-app-update (`0013` summarization-model, `0014` live-transcript-flags).

## Decision

A single **effective data root** resolves at boot. Everything user-visible moves with it; models stay put.

- **Precedence**: `MYNA_DATA_DIR` env var > persisted pointer > `~/myna` fallback.
- **Persisted pointer**: `~/Library/Application Support/app.myna.desktop/storage.json`, written atomically (tmp+rename), mode `0600`. Holds one field: the custom directory path.
- **Whole data root moves**: `meetings/`, `preferences.json`, `folders.json` all live under the effective root. Setting a new location migrates all three.
- **Models stay fixed at `~/myna/models` (`MYNA_MODELS_DIR` only override)**: model weights (Parakeet, Qwen, Silero) resolve independently of the meetings data root and never migrate with meetings — migration skips top-level `models/`, and neither `MYNA_DATA_DIR` nor the Settings storage location ever affects models. Users on a full disk move meetings, not the ~5.4 GB of models.
- **Set/reset refused while busy**: `set_storage_location` and `reset_storage_location` return `Busy` while recording, stopping, import, or summarize is in flight. The UI disables Change/Reset during those states.
- **Restart-required policy**: stores are built once at boot from the effective root. After a successful set/reset + migration, the UI prompts for restart; the new location takes effect on relaunch. No live store rebinding.
- **Missing custom dir loud-errors**: if the persisted pointer targets a directory that no longer exists (unplugged drive, deleted folder, revoked iCloud), startup does not silently fall back to `~/myna` — that would split the library across two roots. It surfaces an error with a **Reset** affordance that clears the pointer back to `~/myna`.
- **Validation**: accepts `~/Library/Mobile Documents/` (iCloud Drive) paths. Rejects file paths (must be a directory), symlink escapes, and unwritable locations with a `Path` error before anything moves.
- **Move-vs-stay choice**: `set_storage_location` and `reset_storage_location` take a `moveExisting` bool (missing → `true` for back-compat). `true` = migrate (rename, `EXDEV` copy-verify-delete); `false` = stay — ensure the destination exists (mode `0700`) and save the pointer, with no delete and no merge of the old root. Guards, validation, and asset scope are identical on both branches. A no-op set to the current path returns `restartRequired: false` regardless of the flag; the old root is left intact on stay; both modes return `restartRequired: true` on a real change. A `MYNA_DATA_DIR`-pinned session refuses both modes. `StorageMissing` behaviour is unchanged.

## Migration

- **Move mode (`moveExisting: true`)**:
  - **Fast path**: `rename` when source and destination share a filesystem. Atomic from the user's point of view.
  - **`EXDEV` fallback**: cross-volume moves (e.g. local disk → iCloud Drive) copy, verify, then delete. The source is never deleted until the copy verifies — a failed or interrupted migration leaves the original intact.
- **Stay mode (`moveExisting: false`)**: ensure the destination directory exists (`0700`), save the pointer, no delete, no merge. The old root stays on disk untouched; the new location starts empty after restart.
- Migration runs before the pointer is persisted, so a crash mid-migration still resolves to the old root on next boot.

## Asset scope

The Tauri filesystem allowlist covers `$HOME/myna` and `$HOME/Library/Mobile Documents`, plus the platform app-data dirs (`$APPDATA` / `$RESOURCE` for the persisted pointer and bundled resources), so recordings, transcripts, and summaries load from either location. Nothing else is widened — the webview cannot reach arbitrary paths (validator option a: scope restricted to these roots; anything outside is rejected with a `Path` error). A persisted pointer whose target no longer exists surfaces `StorageMissing` as a loud error with a Reset affordance — never a silent fallback.

## Consequences

### Positive

- Users can move the library to a larger disk or iCloud Drive from Settings, with migration handled for them.
- `MYNA_DATA_DIR` keeps working for dev/test and wins over the UI pointer, so automation never fights persisted state.
- No silent split: one effective root at a time, and a missing directory fails loudly with a one-click Reset.

### Negative

- Restart is required after a move — accepted because stores are boot-built singletons; live rebinding risks half-migrated reads.
- iCloud Drive locations inherit iCloud semantics (eviction, sync delay, conflict copies). Myna does not manage those; large `audio.wav` files may take time to sync.
- Set/reset is unavailable mid-operation by design; a user mid-recording must stop first.

## Manual QA (iCloud round-trip)

1. Settings → Change → pick a folder under `~/Library/Mobile Documents/` → confirm migration (**Move** checked) → restart → meetings list intact, new recording lands in the iCloud folder.
2. Reset → restart → root back at `~/myna/`.
3. With a custom location set, rename the target folder in Finder → relaunch → loud error with Reset affordance (library does **not** silently show the old `~/myna/` contents as current).
4. Attempt set while recording → refused with `Busy`; Change/Reset disabled in the UI.
5. Attempt set to a file path and to an unwritable directory → refused with `Path`, nothing moved.
6. Stay round-trip: Settings → Change → pick an empty folder → uncheck **Move** → confirm source→destination text names the stay (no delete/merge) → restart → new location lands empty, old root untouched on disk. Reset asks the same move-vs-stay choice. The UI checkbox defaults to **Move** checked.

## References

- **ADR 0003**: per-meeting directory layout and tmp+rename atomic writes.
- **ADR 0011**: `session.json` manifest and journal paths resolve under the effective root.
- Commands: `get_storage_location`, `set_storage_location`, `reset_storage_location`.
- UI: Settings cogwheel section with Change/Reset + restart prompt.

## Revision History

- **2026-09-07**: Phase 6 decision finalized. Precedence (`MYNA_DATA_DIR` > persisted pointer at `~/Library/Application Support/app.myna.desktop/storage.json`, 0600 > `~/myna`), whole-root migration (rename + copy-verify-delete `EXDEV` fallback), `Busy`/`Path` refusals, restart-required policy, loud-error on missing custom dir, asset scope `$HOME/myna` + `$HOME/Library/Mobile Documents`, iCloud round-trip QA.
