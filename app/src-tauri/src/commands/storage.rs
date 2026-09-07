//! Storage-location commands: query, change, and reset the data root,
//! plus the data migration that moves an archive between roots.
//!
//! The effective data root is resolved by [`crate::paths::effective_data_root_for_app`]
//! (`MYNA_DATA_DIR` > persisted pointer > `~/myna`); these commands only ever
//! read or rewrite the persisted-pointer layer via [`crate::storage_prefs`].
//! Validation reuses [`crate::paths::validate_storage_location`], and the
//! busy guard reuses [`crate::state::AppState::guard_storage_change`] — a
//! live session, a stop/cancel finalization, an import/re-transcribe, or a
//! summarization refuses with [`crate::error::AppError::Busy`].
//!
//! Change policy (simplest safe): migrate the bytes now, persist the pointer,
//! and report `restart_required: true` — the live stores are never re-rooted,
//! so the next process boots on the new root where startup recovery replays
//! any orphans. Only a no-op (the new location already is the effective
//! root) reports `restart_required: false`.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::error::AppError;
use crate::paths::{self, PathError};
use crate::state::AppState;
use crate::storage_prefs::StoragePrefs;

/// `MYNA_DATA_DIR` override key, read directly (rather than through
/// [`crate::paths`]) so `reset_storage_location` can tell "the override pins
/// the effective root" apart from "the pointer does" — a reset cannot move
/// the effective root while the override is set.
const DATA_DIR_ENV: &str = "MYNA_DATA_DIR";

/// Outcome of [`set_storage_location`]/[`reset_storage_location`],
/// IPC-facing (`camelCase` like every DTO in [`crate::dto`]).
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StorageLocationResult {
    /// The new effective storage location, as a string path.
    pub path: String,
    /// Whether the app must restart before the new location takes effect.
    /// Always `true` when the location actually changed (the live stores are
    /// never re-rooted); `false` for a no-op set/reset.
    pub restart_required: bool,
}

/// Returns the current effective storage location (the data root the app
/// booted on: `MYNA_DATA_DIR` > persisted pointer > `~/myna`).
///
/// A persisted pointer naming a missing directory surfaces
/// [`AppError::StorageMissing`] — never a silent fallback — so the UI can
/// offer its Reset affordance.
///
/// `async fn`: resolving the effective root creates it when missing and
/// hardens pre-existing entries, so it runs inside
/// [`tauri::async_runtime::spawn_blocking`] rather than the main thread.
#[tauri::command]
pub async fn get_storage_location(app: AppHandle) -> Result<String, AppError> {
    tauri::async_runtime::spawn_blocking(move || get_storage_location_blocking(&app))
        .await
        .unwrap_or_else(|_| {
            Err(AppError::Store(
                "get_storage_location worker thread panicked".to_string(),
            ))
        })
}

/// Maps a data-root resolution failure to the IPC error surface, preserving
/// the loud missing-pointer case: [`PathError::StorageMissing`] becomes
/// [`AppError::StorageMissing`] (with its `STORAGE_MISSING` code and Reset
/// affordance) rather than collapsing into a generic [`AppError::Path`].
fn map_root_error(err: PathError) -> AppError {
    match err {
        PathError::StorageMissing { path } => {
            AppError::StorageMissing(path.to_string_lossy().into_owned())
        }
        other => AppError::Path(other.to_string()),
    }
}

/// Refuses a set/reset while `MYNA_DATA_DIR` pins the effective root: the
/// override always wins over the persisted pointer, so migrating and
/// rewriting the pointer could never move the live root — it would only
/// strand migrated bytes the app never reads.
fn refuse_when_data_dir_pinned() -> Result<(), AppError> {
    refuse_when_data_dir_pinned_with(std::env::var_os(DATA_DIR_ENV).as_deref())
}

/// Test-seam core of [`refuse_when_data_dir_pinned`], parameterized on the
/// already-read override so tests can exercise the pinned refusal without
/// mutating process-global environment state (`std::env::set_var` requires
/// `unsafe`, forbidden workspace-wide).
pub fn refuse_when_data_dir_pinned_with(
    override_dir: Option<&std::ffi::OsStr>,
) -> Result<(), AppError> {
    if override_dir.is_some() {
        return Err(AppError::Path(format!(
            "storage location is pinned by {DATA_DIR_ENV} — unset the override to change it from Settings"
        )));
    }
    Ok(())
}

/// Whether `path` lies inside the Tauri asset-protocol scope: `~/myna`,
/// iCloud Drive (`~/Library/Mobile Documents/`), or one of `extra_roots`
/// (the app-data parent/dir and resource dir in production).
///
/// Pure over explicit parameters — rather than resolving the home directory
/// and Tauri dirs internally — so the scope decision is unit-testable
/// against tempdirs without booting Tauri.
pub fn storage_path_in_scope(path: &Path, home: &Path, extra_roots: &[PathBuf]) -> bool {
    if path.starts_with(home.join("myna")) {
        return true;
    }
    if path.starts_with(home.join("Library").join("Mobile Documents")) {
        return true;
    }
    extra_roots.iter().any(|root| path.starts_with(root))
}

/// Rejects a candidate storage location outside the Tauri asset-protocol
/// scope (`tauri.conf.json`: `$RESOURCE`, `$APPDATA`, `$HOME/myna`,
/// `$HOME/Library/Mobile Documents`). Migrating the archive somewhere the
/// webview cannot read would move the bytes and then break every
/// recording/transcript/summary load — including audio playback — with no
/// error at move time, so the move itself must refuse with a clear
/// [`AppError::Path`] naming the scope.
fn check_storage_scope(app: &AppHandle, path: &Path) -> Result<(), AppError> {
    let home = match paths::home_dir_for_export() {
        Ok(home) => home,
        Err(err) => return Err(AppError::Path(err.to_string())),
    };
    let mut extra_roots = Vec::new();
    if let Ok(dir) = app.path().app_data_dir() {
        if let Some(parent) = dir.parent() {
            extra_roots.push(parent.to_path_buf());
        }
        extra_roots.push(dir);
    }
    if let Ok(dir) = app.path().resource_dir() {
        extra_roots.push(dir);
    }
    if storage_path_in_scope(path, &home, &extra_roots) {
        return Ok(());
    }
    Err(AppError::Path(format!(
        "storage location must be inside ~/myna, iCloud Drive (~/Library/Mobile Documents/), \
         or the app data directory — {} is outside the readable scope",
        path.display()
    )))
}

/// Synchronous body of [`get_storage_location`], run on a blocking-pool thread.
fn get_storage_location_blocking(app: &AppHandle) -> Result<String, AppError> {
    let root = paths::effective_data_root_for_app(app).map_err(map_root_error)?;
    Ok(root.to_string_lossy().into_owned())
}

/// Moves the archive to `path` and remembers it as the storage location.
///
/// `move_existing` selects the branch: `true` migrates the previous root's
/// data via [`migrate_data_root`] *before* the pointer is saved, so a failed
/// migration leaves the pointer (and the boot root) untouched — the source
/// is never deleted until the copy verifies; `false` stays in place, only
/// ensuring the destination exists (`0700`) and saving the pointer without
/// deleting or merging the source. A missing flag is treated as `true` for
/// back-compat with callers that predate the flag.
///
/// Refuses with [`AppError::Busy`] while recording-adjacent work is in
/// flight (see [`AppState::guard_storage_change`]) or a concurrent
/// set/reset holds the storage guard, with [`AppError::Path`] while
/// `MYNA_DATA_DIR` pins the effective root, when `path` fails
/// [`paths::validate_storage_location`], or when `path` lies outside the
/// Tauri asset-protocol scope (see `check_storage_scope`). All of those
/// guards run on both branches before the branch. A no-op (the new location
/// already is the effective root) reports `restart_required: false`
/// regardless of the flag. Otherwise reports `restart_required: true`
/// whenever the location actually changed.
///
/// `async fn`: the migration can move gigabytes, so the whole body runs
/// inside [`tauri::async_runtime::spawn_blocking`].
#[tauri::command]
pub async fn set_storage_location(
    app: AppHandle,
    path: PathBuf,
    move_existing: Option<bool>,
) -> Result<StorageLocationResult, AppError> {
    let move_existing = move_existing.unwrap_or(true);
    tauri::async_runtime::spawn_blocking(move || {
        set_storage_location_blocking(&app, &path, move_existing)
    })
    .await
    .unwrap_or_else(|_| {
        Err(AppError::Store(
            "set_storage_location worker thread panicked".to_string(),
        ))
    })
}

/// Synchronous body of [`set_storage_location`], run on a blocking-pool thread.
fn set_storage_location_blocking(
    app: &AppHandle,
    path: &Path,
    move_existing: bool,
) -> Result<StorageLocationResult, AppError> {
    refuse_when_data_dir_pinned()?;
    let state = app.state::<AppState>();
    let _storage_guard = state.storage_guard()?;
    state.guard_storage_change()?;
    paths::validate_storage_location(path)?;

    let current = paths::effective_data_root_for_app(app).map_err(map_root_error)?;
    // Canonicalized comparison with a lexical fallback (see
    // [`paths::paths_equal`]): a no-op must not migrate, and it must not
    // be rejected by the scope check below for a location already in use.
    // The flag is ignored here — a no-op never moves and never stays.
    if paths::paths_equal(current.as_path(), path) {
        StoragePrefs::new(Some(path.to_path_buf())).save_for_app(app)?;
        return Ok(StorageLocationResult {
            path: path.to_string_lossy().into_owned(),
            restart_required: false,
        });
    }

    check_storage_scope(app, path)?;
    if move_existing {
        // No pre-create of `path` here: `migrate_data_root` must see a
        // missing destination to take its atomic `rename` fast path —
        // creating it first would force every move through the per-entry
        // copy fallback.
        migrate_data_root(&current, path)?;
    } else {
        // Stay in place: ensure a usable empty root at the destination and
        // leave the source archive untouched (no delete, no merge).
        paths::create_dir_all_0700(path)?;
    }
    StoragePrefs::new(Some(path.to_path_buf())).save_for_app(app)?;
    Ok(StorageLocationResult {
        path: path.to_string_lossy().into_owned(),
        restart_required: true,
    })
}

/// Clears the custom storage location, moving the archive back to the default
/// root (`~/myna`) so the next boot lands there. Refuses with
/// [`AppError::Path`] while `MYNA_DATA_DIR` pins the effective root — the
/// override would win over the cleared pointer, so a reset could never move
/// the live root.
///
/// `move_existing` selects the branch, mirroring [`set_storage_location`]:
/// `true` migrates via [`migrate_data_root`] before the pointer is cleared;
/// `false` stays in place, only ensuring the default root exists (`0700`)
/// and clearing the pointer without deleting or merging the source. A
/// missing flag is treated as `true` for back-compat. All guards
/// (`refuse_when_data_dir_pinned`, the storage guard,
/// [`AppState::guard_storage_change`], [`paths::validate_storage_location`],
/// the asset-scope check) run on both branches before the branch; a no-op
/// reports `restart_required: false` regardless of the flag.
///
/// Same [`AppError::Busy`]/[`AppError::Path`] contract as
/// [`set_storage_location`]: guarded while recording-adjacent work is in
/// flight, `restart_required: true` whenever the location actually changed.
///
/// `async fn`: same large-IO rationale as [`set_storage_location`].
#[tauri::command]
pub async fn reset_storage_location(
    app: AppHandle,
    move_existing: Option<bool>,
) -> Result<StorageLocationResult, AppError> {
    let move_existing = move_existing.unwrap_or(true);
    tauri::async_runtime::spawn_blocking(move || {
        reset_storage_location_blocking(&app, move_existing)
    })
    .await
    .unwrap_or_else(|_| {
        Err(AppError::Store(
            "reset_storage_location worker thread panicked".to_string(),
        ))
    })
}

/// Synchronous body of [`reset_storage_location`], run on a blocking-pool thread.
fn reset_storage_location_blocking(
    app: &AppHandle,
    move_existing: bool,
) -> Result<StorageLocationResult, AppError> {
    refuse_when_data_dir_pinned()?;
    let state = app.state::<AppState>();
    let _storage_guard = state.storage_guard()?;
    state.guard_storage_change()?;

    let current = paths::effective_data_root_for_app(app).map_err(map_root_error)?;
    // While `MYNA_DATA_DIR` is unset the reset target is always the
    // `~/myna` default (the pinned-override case refused above, so the
    // target can never be an override that wins over the cleared pointer).
    let target = paths::default_data_root().map_err(|err| AppError::Path(err.to_string()))?;
    if paths::paths_equal(&current, &target) {
        StoragePrefs::new(None).save_for_app(app)?;
        return Ok(StorageLocationResult {
            path: target.to_string_lossy().into_owned(),
            restart_required: false,
        });
    }

    paths::validate_storage_location(&target)?;
    // The target is inside the asset scope by construction, but it is
    // checked symmetrically with `set` so both branches refuse before
    // branching.
    check_storage_scope(app, &target)?;
    if move_existing {
        // Same as `set`: no pre-create — `migrate_data_root` needs a
        // missing destination for its atomic `rename` fast path.
        migrate_data_root(&current, &target)?;
    } else {
        // Stay in place: ensure a usable empty default root and leave the
        // source archive untouched (no delete, no merge).
        paths::create_dir_all_0700(&target)?;
    }
    StoragePrefs::new(None).save_for_app(app)?;
    Ok(StorageLocationResult {
        path: target.to_string_lossy().into_owned(),
        restart_required: true,
    })
}

/// Moves the archive at `from` to `to`, returning the number of files moved.
///
/// Strategy, in order:
/// 1. Same path (canonicalized, with a lexical fallback — see
///    [`paths::paths_equal`]) or a missing source is a trivial no-op
///    (`Ok(0)`): the destination is ensured to exist so the caller always
///    lands on a usable root.
/// 2. Fast path: [`fs::rename`] of the whole tree (same volume — instant
///    even for multi-GB archives). Callers must NOT pre-create `to`: a
///    pre-existing destination skips this branch and forces every move
///    through the per-entry copy fallback.
/// 3. Fallback: per-entry move, where each entry first retries
///    [`fs::rename`] and, on `EXDEV` (iCloud Drive, external volumes), does a
///    recursive copy, verifies the copy matches the source by file count
///    AND total byte size, and only then deletes the source — a failed
///    verify leaves the source untouched and surfaces [`AppError::Store`].
///    Copied directories are created `0700` and copied files are tightened
///    to `0600`, matching the at-rest policy of the rest of the app.
///
/// Merge behavior: when `to` already holds entries, directories merge
/// recursively and pre-existing destination files are left untouched (never
/// overwritten); the colliding source file is likewise left in place and
/// skipped. Every `EXDEV` copy inside the merge goes through the same
/// count-and-size verify as the top-level fallback. Symlinks are never
/// followed or copied — they are skipped — so a link inside the archive
/// can neither redirect the migration nor escape it.
///
/// A top-level `models/` entry is never migrated on any path: model weights
/// live at the fixed `~/myna/models` (see [`crate::paths::models_root`]) and
/// must not be dragged along with the meetings archive. The entry is skipped
/// with a stderr log and contributes 0 to the moved count; the destination
/// never gains a `models/` dir.
pub fn migrate_data_root(from: &Path, to: &Path) -> Result<u64, AppError> {
    migrate_data_root_with_test_options(from, to, false, false)
}

/// Test-seam core of [`migrate_data_root`]: `force_copy` skips both
/// [`fs::rename`] fast paths (top-level and per-entry) and drives every
/// entry through the copy-verify-delete fallback, so the `EXDEV`
/// (cross-volume) path is exercisable on a single-volume test tempdir.
/// `corrupt_copy_for_test` (only meaningful with `force_copy`) truncates
/// the copy before verification to simulate a short write the file-count
/// check alone would miss — verification must then fail with
/// [`AppError::Store`] leaving the source untouched. Production callers
/// always pass `(false, false)` via [`migrate_data_root`].
pub fn migrate_data_root_with_test_options(
    from: &Path,
    to: &Path,
    force_copy: bool,
    corrupt_copy_for_test: bool,
) -> Result<u64, AppError> {
    if paths::paths_equal(from, to) {
        return Ok(0);
    }
    if !from.exists() {
        paths::create_dir_all_0700(to)?;
        return Ok(0);
    }

    // Models live at the fixed `~/myna/models`, never inside the migrating
    // archive: a top-level `models/` entry forces the per-entry path below
    // (which skips it) instead of the whole-tree `rename`/whole-tree-copy
    // fast paths, either of which would drag the multi-GB weights along.
    let has_top_level_models = fs::symlink_metadata(from.join(paths::MODELS_DIR_NAME)).is_ok();

    if !to.exists() && !has_top_level_models {
        if force_copy {
            // EXDEV-style whole-tree copy-verify-delete, exercised on one
            // volume for tests.
            return copy_verify_delete(from, to, corrupt_copy_for_test);
        }
        match fs::rename(from, to) {
            Ok(()) => return Ok(dir_stats(to)?.files),
            Err(err) if err.kind() == ErrorKind::CrossesDevices => {
                // Fall through to the per-entry copy fallback below.
            }
            Err(err) => return Err(AppError::Io(err)),
        }
    }

    paths::create_dir_all_0700(to)?;
    let mut moved = 0_u64;
    let entries = fs::read_dir(from)?.collect::<Result<Vec<_>, std::io::Error>>()?;
    for entry in entries {
        let source = entry.path();
        let Some(name) = source.file_name() else {
            continue;
        };
        if name.to_str() == Some(paths::MODELS_DIR_NAME) {
            eprintln!(
                "myna-app: storage migration: skipping models/ — model weights stay at the fixed ~/myna/models"
            );
            continue;
        }
        moved += move_entry(&source, &to.join(name), force_copy, corrupt_copy_for_test)?;
    }
    Ok(moved)
}

/// Copies `from` to `to`, verifies the copy matches the source by file
/// count AND total byte size, and only then deletes the source — returning
/// the number of files moved. A failed verify leaves the source untouched
/// and surfaces [`AppError::Store`]. Shared by the `EXDEV` fallback in
/// [`move_entry`] and the forced-copy test path in
/// [`migrate_data_root_with_test_options`].
fn copy_verify_delete(
    from: &Path,
    to: &Path,
    corrupt_copy_for_test: bool,
) -> Result<u64, AppError> {
    let expected = dir_stats(from)?;
    copy_tree(from, to)?;
    if corrupt_copy_for_test && !corrupt_first_copy_for_test(to)? {
        return Err(AppError::Store(format!(
            "storage migration test seam found no file to corrupt under {}",
            to.display()
        )));
    }
    let actual = dir_stats(to)?;
    if actual != expected {
        return Err(AppError::Store(format!(
            "storage migration copied {} file(s) / {} byte(s), expected {} file(s) / {} byte(s) from {} — \
             leaving the source untouched",
            actual.files,
            actual.bytes,
            expected.files,
            expected.bytes,
            from.display()
        )));
    }
    delete_tree(from)?;
    Ok(actual.files)
}

/// Truncates one byte off the first non-empty regular file found under
/// `root` (depth-first, never following symlinks), simulating a short
/// write for the copy-verify test path. Returns whether a file was
/// corrupted; `false` when the tree holds no non-empty regular file.
fn corrupt_first_copy_for_test(root: &Path) -> Result<bool, AppError> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(next) = stack.pop() {
        let entries = fs::read_dir(&next)?.collect::<Result<Vec<_>, std::io::Error>>()?;
        for entry in entries {
            let path = entry.path();
            if is_symlink(&path) {
                continue;
            }
            let kind = entry.file_type()?;
            if kind.is_dir() {
                stack.push(path);
            } else if kind.is_file() {
                let len = path.metadata()?.len();
                if len > 0 {
                    let file = fs::OpenOptions::new().write(true).open(&path)?;
                    file.set_len(len - 1)?;
                    return Ok(true);
                }
            }
        }
    }
    Ok(false)
}

/// Moves one entry (`from`) to (`to`), via rename with an EXDEV
/// copy-verify-delete fallback, merging directories that already exist at the
/// destination. Returns the number of files moved.
///
/// A top-level `models/` entry is never moved (defense in depth with the
/// caller's skip, and a guard for direct calls): model weights live at the
/// fixed `~/myna/models`, so the entry is skipped with a stderr log and
/// contributes 0.
fn move_entry(
    from: &Path,
    to: &Path,
    force_copy: bool,
    corrupt_copy_for_test: bool,
) -> Result<u64, AppError> {
    if from.file_name().and_then(|name| name.to_str()) == Some(paths::MODELS_DIR_NAME) {
        eprintln!(
            "myna-app: storage migration: skipping models/ — model weights stay at the fixed ~/myna/models"
        );
        return Ok(0);
    }

    if is_symlink(from) {
        eprintln!("myna-app: storage migration: skipping symlink {from:?}");
        return Ok(0);
    }

    if !to.exists() {
        if force_copy {
            return copy_verify_delete(from, to, corrupt_copy_for_test);
        }
        match fs::rename(from, to) {
            Ok(()) => return Ok(dir_stats(to)?.files),
            Err(err) if err.kind() == ErrorKind::CrossesDevices => {
                return copy_verify_delete(from, to, false);
            }
            Err(err) => return Err(AppError::Io(err)),
        }
    }

    // Both sides exist: directories merge recursively; anything else is a
    // collision the migration must not resolve by overwriting.
    if from.is_dir() && to.is_dir() {
        let mut merged = 0_u64;
        let entries = fs::read_dir(from)?.collect::<Result<Vec<_>, std::io::Error>>()?;
        for entry in entries {
            let source = entry.path();
            let Some(name) = source.file_name() else {
                continue;
            };
            merged += move_entry(&source, &to.join(name), force_copy, corrupt_copy_for_test)?;
        }
        return Ok(merged);
    }

    eprintln!("myna-app: storage migration: {to:?} already exists — leaving {from:?} in place");
    Ok(0)
}

/// Recursively copies `from` to `to`, returning the number of files copied.
/// Symlinks are skipped, never followed. Created directories are `0700`
/// and copied files are tightened to `0600`, matching the at-rest policy
/// the rest of the app applies to newly created paths.
fn copy_tree(from: &Path, to: &Path) -> Result<u64, AppError> {
    if is_symlink(from) {
        eprintln!("myna-app: storage migration: skipping symlink {from:?}");
        return Ok(0);
    }
    if from.is_file() {
        if let Some(parent) = to.parent() {
            paths::create_dir_all_0700(parent)?;
        }
        fs::copy(from, to)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(to, fs::Permissions::from_mode(0o600))?;
        }
        return Ok(1);
    }
    if from.is_dir() {
        paths::create_dir_all_0700(to)?;
        let mut copied = 0_u64;
        let entries = fs::read_dir(from)?.collect::<Result<Vec<_>, std::io::Error>>()?;
        for entry in entries {
            let source = entry.path();
            let Some(name) = source.file_name() else {
                continue;
            };
            copied += copy_tree(&source, &to.join(name))?;
        }
        return Ok(copied);
    }
    eprintln!("myna-app: storage migration: skipping special file {from:?}");
    Ok(0)
}

/// File count plus total byte size under `path` (a file contributes
/// 1 file / its length, a directory a recursive total, anything else
/// zero) — the verify side of the copy-verify-delete fallback. A
/// count-only check would accept a truncated copy as long as every file
/// exists; comparing byte totals as well catches short writes the count
/// misses. Symlinks contribute 0 and are never followed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DirStats {
    files: u64,
    bytes: u64,
}

fn dir_stats(path: &Path) -> Result<DirStats, AppError> {
    if is_symlink(path) {
        return Ok(DirStats { files: 0, bytes: 0 });
    }
    if path.is_file() {
        let bytes = path.metadata()?.len();
        return Ok(DirStats { files: 1, bytes });
    }
    if path.is_dir() {
        let mut total = DirStats { files: 0, bytes: 0 };
        let entries = fs::read_dir(path)?.collect::<Result<Vec<_>, std::io::Error>>()?;
        for entry in entries {
            let stats = dir_stats(&entry.path())?;
            total.files += stats.files;
            total.bytes += stats.bytes;
        }
        return Ok(total);
    }
    Ok(DirStats { files: 0, bytes: 0 })
}

/// Deletes `path` after a verified copy: files (and symlinks) via
/// [`fs::remove_file`], directories via [`fs::remove_dir_all`].
fn delete_tree(path: &Path) -> Result<(), AppError> {
    if path.is_dir() && !is_symlink(path) {
        fs::remove_dir_all(path)?;
    } else {
        fs::remove_file(path)?;
    }
    Ok(())
}

/// Whether `path` itself is a symlink (never following it) — mirrors
/// [`crate::paths`]' internal check, which is private to that module.
fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
}
