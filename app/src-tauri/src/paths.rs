//! On-disk locations used by the rest of the app: the user's data root and
//! the model/template resource directories.

use std::path::{Path, PathBuf};
use std::{env, fs};

use tauri::Manager;
use thiserror::Error;

use crate::error::AppError;
use crate::storage_prefs::StoragePrefs;

/// Errors resolving or preparing on-disk paths.
#[derive(Debug, Error)]
pub enum PathError {
    #[error("could not resolve the user home directory")]
    HomeDirUnavailable,
    #[error("failed to create directory {path}: {source}")]
    CreateDir {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    /// The persisted storage pointer names a directory that no longer
    /// exists. Loud by design (see [`effective_data_root`]): silently
    /// recreating it or falling back to `~/myna` would split the library
    /// across two roots.
    #[error("storage location is missing: {}", path.display())]
    StorageMissing { path: PathBuf },
}

const DATA_DIR_ENV: &str = "MYNA_DATA_DIR";
const MODELS_DIR_ENV: &str = "MYNA_MODELS_DIR";
const TEMPLATES_DIR_ENV: &str = "MYNA_TEMPLATES_DIR";
const DATA_DIR_NAME: &str = "myna";
const MEETINGS_DIR_NAME: &str = "meetings";
pub(crate) const MODELS_DIR_NAME: &str = "models";
const TEMPLATES_DIR_NAME: &str = "templates";

/// Resolves the Myna data root path (`~/myna` by default) without creating
/// it, given an explicit `MYNA_DATA_DIR` override (or `None` to fall back
/// to the home-directory default).
///
/// Takes the override as a parameter — rather than reading
/// `MYNA_DATA_DIR` from the process environment directly — so callers that
/// need to resolve it for a hypothetical override (e.g. tests exercising
/// [`effective_data_root`]'s precedence) can do so without mutating real
/// process environment variables, which requires `unsafe` and is forbidden
/// workspace-wide.
fn data_root_path_with(data_dir_override: Option<PathBuf>) -> Result<PathBuf, PathError> {
    match data_dir_override {
        Some(dir) => Ok(dir),
        None => Ok(home_dir()?.join(DATA_DIR_NAME)),
    }
}

/// Resolves the Myna data root path (`~/myna` by default) without creating
/// it. Honours `MYNA_DATA_DIR` as an override for dev/tests, which takes
/// precedence over the home-directory default.
fn data_root_path() -> Result<PathBuf, PathError> {
    data_root_path_with(env::var_os(DATA_DIR_ENV).map(PathBuf::from))
}

/// Resolves the Myna data root (`~/myna` by default), creating it if missing.
///
/// Honours `MYNA_DATA_DIR` as an override for dev/tests, which takes
/// precedence over the home-directory default.
pub fn data_root() -> Result<PathBuf, PathError> {
    let root = data_root_path()?;
    ensure_dir(&root)?;
    Ok(root)
}

/// Resolves `<data_root>/meetings`, creating it if missing.
pub fn meetings_root() -> Result<PathBuf, PathError> {
    let root = data_root()?.join(MEETINGS_DIR_NAME);
    ensure_dir(&root)?;
    Ok(root)
}

/// Resolves the models directory.
///
/// Models are ~5.4 GB of weights that must never be bundled into the app;
/// they live at the fixed user path `~/myna/models`, downloaded there by
/// `scripts/download-models.sh` (default `${MYNA_MODELS_DIR:-$HOME/myna/models}`).
///
/// Meetings follow the effective data root (dev override > persisted
/// pointer > `~/myna`); models never do — a storage-location move or a
/// data-dir override must not drag the multi-GB weights along or
/// strand the app looking for them under a custom root.
///
/// In dev builds, the repo-relative `models/` directory is only a legacy
/// fallback, honoured when it holds actual weights (a subdirectory) but the
/// fixed `~/myna/models` does not exist yet — a git-kept placeholder
/// (README only) must never shadow a populated `~/myna/models`.
///
/// Honours `MYNA_MODELS_DIR` as an override, which takes precedence over
/// both of the above.
pub fn models_root(_app: &tauri::AppHandle) -> PathBuf {
    resolve_models_root(
        env::var_os(MODELS_DIR_ENV).map(PathBuf::from),
        cfg!(debug_assertions),
    )
}

/// Testable core of [`models_root`], parameterized on the `MYNA_MODELS_DIR`
/// override and debug-vs-release — rather than reading process env vars or
/// `cfg!(debug_assertions)` directly — so every precedence branch is
/// unit-testable without mutating process-global state (which
/// `std::env::set_var`/`remove_var` require `unsafe` for, and this workspace
/// forbids `unsafe_code` outright).
pub fn resolve_models_root(models_dir_override: Option<PathBuf>, is_debug_build: bool) -> PathBuf {
    if let Some(dir) = models_dir_override {
        return dir;
    }

    if is_debug_build {
        resolve_dev_models_root(
            repo_root().join(MODELS_DIR_NAME),
            fixed_models_root().unwrap_or_else(|| repo_root().join(MODELS_DIR_NAME)),
        )
    } else {
        resolve_release_models_root()
    }
}

/// Resolves the templates directory: repo-relative `templates/` in dev
/// builds, the bundled resource directory in release builds (templates are
/// small enough to ship inside the app bundle).
///
/// Honours `MYNA_TEMPLATES_DIR` as an override.
pub fn templates_root(app: &tauri::AppHandle) -> PathBuf {
    resolve_resource_dir(app, TEMPLATES_DIR_ENV, TEMPLATES_DIR_NAME)
}

/// Fixed models path (`~/myna/models`), ensuring the parent `~/myna`
/// exists (`0700`). Returns `None` only when the home directory itself
/// cannot be resolved. Deliberately ignores the effective data root — a
/// custom storage location or data-dir override must never move the
/// weights as a side effect.
fn fixed_models_root() -> Option<PathBuf> {
    let root = home_dir().ok()?.join(DATA_DIR_NAME);
    ensure_dir(&root).ok()?;
    Some(root.join(MODELS_DIR_NAME))
}

/// Dev-mode models root: prefers the fixed `~/myna/models` directory (the
/// downloader's canonical destination) when it exists; falls back to the
/// repo's `models/` directory only when that holds actual weights (a
/// subdirectory — not the git-kept README placeholder) and the fixed
/// directory does not exist yet; otherwise returns the (possibly
/// not-yet-existing) fixed path so fresh downloads land in the canonical
/// location. Takes both paths as parameters so each branch is unit-testable
/// without touching the real (multi-GB) repo `models/` directory or the
/// real home directory.
fn resolve_dev_models_root(repo_models: PathBuf, fixed_models: PathBuf) -> PathBuf {
    if fixed_models.exists() {
        return fixed_models;
    }

    if repo_models.exists() && dir_contains_subdirectory(&repo_models) {
        return repo_models;
    }

    fixed_models
}

/// Whether `dir` contains at least one subdirectory — i.e. actual model
/// weights rather than the git-kept placeholder files (`README.md`) that
/// keep an otherwise-empty `models/` directory checked in. Unreadable
/// directories conservatively report no content so callers fall through
/// to the canonical user path.
fn dir_contains_subdirectory(dir: &Path) -> bool {
    fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .any(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        })
        .unwrap_or(false)
}

/// Release-mode models root: the fixed `~/myna/models`. The directory
/// itself is populated by `scripts/download-models.sh`, not created eagerly
/// here — only the parent `~/myna` is ensured to exist (see
/// [`fixed_models_root`]).
fn resolve_release_models_root() -> PathBuf {
    fixed_models_root().unwrap_or_else(|| PathBuf::from(MODELS_DIR_NAME))
}

/// Detects model weights stranded under a custom storage location: returns
/// `Some(<effective_root>/models)` when the fixed `~/myna/models` is missing
/// or incomplete AND `<effective_root>/models` holds the complete core set
/// (Parakeet + Qwen + Silero) — i.e. a past migration dragged the multi-GB
/// weights along before the migration learned to skip them.
///
/// Pure and read-only (stats files, creates nothing): the boot hook in
/// `lib.rs` logs the result loudly, while `models_status` keeps reporting
/// the fixed path — stranded weights are never read back silently.
pub fn stranded_models_at(effective_root: &Path) -> Option<PathBuf> {
    let fixed_models = home_dir().ok()?.join(DATA_DIR_NAME).join(MODELS_DIR_NAME);
    stranded_models_between(&effective_root.join(MODELS_DIR_NAME), &fixed_models)
}

/// Testable core of [`stranded_models_at`], parameterized on both models
/// dirs so tests can exercise every branch against tempdirs without
/// touching the real home directory.
fn stranded_models_between(stranded: &Path, fixed_models: &Path) -> Option<PathBuf> {
    if paths_equal(fixed_models, stranded) {
        return None;
    }
    if models_dir_complete(stranded) && !models_dir_complete(fixed_models) {
        Some(stranded.to_path_buf())
    } else {
        None
    }
}

/// Whether `models_root` holds the complete core weights set (Parakeet +
/// Qwen + Silero). Mirrors the expected-file lists in
/// [`crate::commands::models::models_status_at`] — duplicated here (rather
/// than calling into `commands`) so this low-level module keeps its
/// dependency direction (`commands` depends on `paths`, never the reverse).
/// Keep the two in sync.
fn models_dir_complete(models_root: &Path) -> bool {
    const PARAKEET_DIR: &str = "parakeet-tdt-0.6b-v3-int8";
    const PARAKEET_FILES: [&str; 4] = [
        "encoder.int8.onnx",
        "decoder.int8.onnx",
        "joiner.int8.onnx",
        "tokens.txt",
    ];
    const QWEN_DIR: &str = "qwen2.5-7b-instruct";
    const QWEN_FILES: [&str; 2] = [
        "qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf",
        "qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf",
    ];
    const SILERO_DIR: &str = "silero-vad";
    const SILERO_FILES: [&str; 1] = ["silero_vad.onnx"];

    fn slot_complete(models_root: &Path, dir_name: &str, expected_files: &[&str]) -> bool {
        let dir = models_root.join(dir_name);
        expected_files.iter().all(|file| dir.join(file).is_file())
    }

    slot_complete(models_root, PARAKEET_DIR, &PARAKEET_FILES)
        && slot_complete(models_root, QWEN_DIR, &QWEN_FILES)
        && slot_complete(models_root, SILERO_DIR, &SILERO_FILES)
}

fn resolve_resource_dir(app: &tauri::AppHandle, env_override: &str, dir_name: &str) -> PathBuf {
    if let Some(dir) = env::var_os(env_override) {
        return PathBuf::from(dir);
    }

    if cfg!(debug_assertions) {
        return repo_root().join(dir_name);
    }

    app.path()
        .resource_dir()
        .map(|resource_dir| resource_dir.join(dir_name))
        .unwrap_or_else(|_| PathBuf::from(dir_name))
}

/// Repo root in dev builds, derived from the crate's compile-time manifest
/// directory (`app/src-tauri` -> repo root is two levels up).
pub(crate) fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn home_dir() -> Result<PathBuf, PathError> {
    #[cfg(windows)]
    let key = "USERPROFILE";
    #[cfg(not(windows))]
    let key = "HOME";

    env::var_os(key)
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or(PathError::HomeDirUnavailable)
}

fn ensure_dir(path: &Path) -> Result<(), PathError> {
    if path.exists() {
        return Ok(());
    }

    create_dir_all_0700(path).map_err(|source| PathError::CreateDir {
        path: path.to_path_buf(),
        source,
    })
}

/// Creates `path` and every missing parent directory, restricting each
/// newly created directory to owner-only access (`0700`) on Unix from the
/// moment it is created — there is no window where a meeting's directory is
/// world- or group-readable. `~/myna` is not a TCC-protected location, so
/// this is the only thing standing between an unsandboxed process on the
/// same machine and a user's full meeting archive.
///
/// Exposed `pub(crate)` so `store::fs_store` and `store::folder_store` can
/// apply the same policy to the per-meeting and summaries directories they
/// create, without duplicating the `cfg(unix)` split.
///
/// Non-Unix targets fall back to the platform default permissions — Myna is
/// macOS-first and Windows/Linux ACL handling is deferred (see
/// `docs/stack-proposal.md`).
#[cfg(unix)]
pub(crate) fn create_dir_all_0700(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
}

#[cfg(not(unix))]
pub(crate) fn create_dir_all_0700(path: &Path) -> std::io::Result<()> {
    fs::create_dir_all(path)
}

/// Writes `contents` to `path`, restricting the file to owner-only access
/// (`0600`) on Unix from the moment it is created — the file never has a
/// world- or group-readable window between `create` and a later `chmod`.
/// Used for every meeting-scoped artifact written at rest (`meeting.json`,
/// summaries, `folders.json`); intentionally does *not* handle atomic
/// tmp-then-rename — callers that need that write to a `.tmp` path with
/// this function and rename separately.
#[cfg(unix)]
pub(crate) fn write_0600(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    use std::os::unix::fs::OpenOptionsExt;

    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(contents)
}

#[cfg(not(unix))]
pub(crate) fn write_0600(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    fs::write(path, contents)
}

/// The user's home directory, exposed `pub(crate)` so
/// `commands::export`'s destination-confinement check can resolve `$HOME`
/// without duplicating the `HOME`/`USERPROFILE` platform split.
pub(crate) fn home_dir_for_export() -> Result<PathBuf, PathError> {
    home_dir()
}

/// Walks `root` once and tightens the permissions of every pre-existing
/// directory and regular file that is looser than the policy already
/// applied to newly created paths (`0700` for directories via
/// [`create_dir_all_0700`], `0600` for files via [`write_0600`]).
///
/// Those two helpers only take effect the moment a path is *created* —
/// `ensure_dir` short-circuits on `path.exists()` — so any meeting recorded
/// before this hardening shipped is stuck at the process umask default
/// (typically `0755`/`0644`, world- and group-readable). `~/myna` is not a
/// TCC-protected location, so this migration is the only thing standing
/// between the pre-existing archive and any other local account or
/// unsandboxed process on the machine.
///
/// Covers `root` itself, `meetings/`, every per-meeting directory, and
/// everything under them (`audio.wav`, `track-*.wav`, `meeting.json`,
/// `transcript*.json`, `summaries/**`, `folders.json`). `models/` directly
/// under `root` is skipped entirely — multi-GB of public model weights, not
/// meeting data, and out of scope for this hardening pass.
///
/// Symlinks are never followed: neither their own permissions are changed
/// nor is their target descended into. Entries already at or tighter than
/// the target mode are left untouched, so repeat launches after the first
/// are a cheap no-op walk. Failures on individual entries (permission
/// denied, a concurrent delete, etc.) are logged to stderr and skipped —
/// never fatal, since one stray unreadable file must not block the app
/// from starting.
#[cfg(unix)]
pub(crate) fn harden_existing_data_root(root: &Path) -> std::io::Result<()> {
    if !root.is_dir() {
        return Ok(());
    }

    tighten_mode_if_looser(root, 0o700);
    harden_dir_contents(root, true);
    Ok(())
}

#[cfg(not(unix))]
pub(crate) fn harden_existing_data_root(_root: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Recurses into `dir`, tightening every non-symlink child. `is_root`
/// controls whether the top-level `models/` directory is skipped (it is
/// only ever a direct child of the data root, so the skip only needs to
/// apply at that level).
#[cfg(unix)]
fn harden_dir_contents(dir: &Path, is_root: bool) {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) => {
            eprintln!("harden_existing_data_root: failed to read {dir:?}: {err}");
            return;
        }
    };

    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(err) => {
                eprintln!("harden_existing_data_root: failed to read an entry in {dir:?}: {err}");
                continue;
            }
        };

        if is_root && entry.file_name().to_str() == Some(MODELS_DIR_NAME) {
            continue;
        }

        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(err) => {
                eprintln!(
                    "harden_existing_data_root: failed to stat {:?}: {err}",
                    entry.path()
                );
                continue;
            }
        };

        // `DirEntry::file_type` does not traverse symlinks, so this check
        // is enough to guarantee we neither chmod a symlink's target nor
        // recurse through one.
        if file_type.is_symlink() {
            continue;
        }

        let path = entry.path();
        if file_type.is_dir() {
            tighten_mode_if_looser(&path, 0o700);
            harden_dir_contents(&path, false);
        } else if file_type.is_file() {
            tighten_mode_if_looser(&path, 0o600);
        }
    }
}

/// Chmods `path` to exactly `target_mode` only if its current mode carries
/// any permission bit outside `target_mode` (i.e. it is looser than the
/// target). A mode already equal to or tighter than the target is left
/// alone. Errors are logged and swallowed — see
/// [`harden_existing_data_root`].
#[cfg(unix)]
fn tighten_mode_if_looser(path: &Path, target_mode: u32) {
    use std::os::unix::fs::PermissionsExt;

    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(err) => {
            eprintln!("harden_existing_data_root: failed to stat {path:?}: {err}");
            return;
        }
    };

    let current_mode = metadata.permissions().mode() & 0o777;
    if current_mode & !target_mode == 0 {
        return;
    }

    if let Err(err) = fs::set_permissions(path, fs::Permissions::from_mode(target_mode)) {
        eprintln!("harden_existing_data_root: failed to chmod {path:?} to {target_mode:o}: {err}");
    }
}

/// Default data root (`~/myna`), without creating it — the location
/// [`effective_data_root`] falls back to when neither the `MYNA_DATA_DIR`
/// override nor the persisted pointer names a directory. Exposed so
/// `commands::storage::reset_storage_location` can name its migration target
/// without consulting (or clearing) the pointer first.
pub fn default_data_root() -> Result<PathBuf, PathError> {
    Ok(home_dir()?.join(DATA_DIR_NAME))
}

// --- Effective data root: env override > persisted pointer > ~/myna ------

/// Resolves the effective data root, creating it (`0700`, hardened) on first
/// use.
///
/// Precedence, first match wins:
/// 1. `data_dir_override` (`MYNA_DATA_DIR` in production, via
///    [`effective_data_root_for_app`]) — dev/test override, always wins.
/// 2. The persisted pointer ([`StoragePrefs`]) in `config_dir` (the Tauri
///    app config dir in production) — the user's chosen storage location. A
///    corrupt or missing pointer file loads as unset and falls through; a
///    pointer naming an existing non-directory is likewise ignored. A
///    pointer naming a path that does not exist at all fails loudly with
///    [`PathError::StorageMissing`] — it is never silently recreated and
///    never falls through to the default (either would split the library
///    across two roots).
/// 3. Otherwise `~/myna`.
///
/// `config_dir` is a parameter — rather than resolving the Tauri app config
/// dir internally — so every precedence branch is unit-testable against an
/// isolated directory without booting Tauri (the same
/// resolve-the-real-thing-at-the-edge, parameterize-the-core pattern
/// [`resolve_models_root`] uses).
pub fn effective_data_root(
    data_dir_override: Option<PathBuf>,
    config_dir: impl AsRef<Path>,
) -> Result<PathBuf, PathError> {
    let pointed = StoragePrefs::load(config_dir.as_ref()).data_dir;
    effective_data_root_with_pointer(data_dir_override, pointed)
}

/// Edge wrapper around [`effective_data_root`]: reads the live
/// `MYNA_DATA_DIR` override from the process environment and the pointer
/// from the Tauri app config dir, then delegates to the testable core.
pub fn effective_data_root_for_app(app: &tauri::AppHandle) -> Result<PathBuf, PathError> {
    let data_dir_override = env::var_os(DATA_DIR_ENV).map(PathBuf::from);
    let pointed = StoragePrefs::load_for_app(app).data_dir;
    effective_data_root_with_pointer(data_dir_override, pointed)
}

/// Core of [`effective_data_root`]/[`effective_data_root_for_app`],
/// parameterized on the already-loaded pointer so both edges share one
/// precedence implementation.
fn effective_data_root_with_pointer(
    data_dir_override: Option<PathBuf>,
    pointed: Option<PathBuf>,
) -> Result<PathBuf, PathError> {
    if let Some(dir) = data_dir_override {
        return ensure_effective_root(dir);
    }

    if let Some(pointed) = pointed {
        let pointed = absolutize_pointer(pointed)?;
        // A pointer naming a path that no longer exists (unplugged drive,
        // deleted folder, revoked iCloud grant) fails loudly — silently
        // recreating it would resurrect an empty library over the user's
        // real archive, and falling through to the default would split the
        // library across two roots. The UI surfaces this with a Reset
        // affordance that clears the pointer back to `~/myna`.
        if !pointed.exists() {
            return Err(PathError::StorageMissing { path: pointed });
        }
        // A pointer naming an existing file (or other non-directory) can
        // never serve as a data root — treat it like a corrupt pointer and
        // fall through to the default rather than failing the launch.
        if pointed.is_dir() {
            return ensure_effective_root(pointed);
        }
    }

    ensure_effective_root(home_dir()?.join(DATA_DIR_NAME))
}

/// Whether two data-root paths name the same location: compares the
/// canonicalized forms when both resolve, falling back to lexical equality
/// otherwise (a not-yet-existing candidate cannot be canonicalized, and on
/// macOS even existing paths may disagree lexically — `/tmp` vs
/// `/private/tmp` — while naming the same directory).
pub(crate) fn paths_equal(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(canonical_a), Ok(canonical_b)) => canonical_a == canonical_b,
        _ => a == b,
    }
}

/// Resolves a persisted pointer to an absolute path: absolute pointers are
/// used as-is, relative ones against the user's home directory.
fn absolutize_pointer(pointed: PathBuf) -> Result<PathBuf, PathError> {
    if pointed.is_absolute() {
        Ok(pointed)
    } else {
        Ok(home_dir()?.join(pointed))
    }
}

/// Creates `root` if missing (`0700` via [`ensure_dir`]) and hardens
/// pre-existing entries, so the first use of a fresh custom location lands
/// under the same at-rest policy as `~/myna`. Hardening failures are logged
/// and swallowed — one stray unreadable file must not block startup (see
/// [`harden_existing_data_root`]).
fn ensure_effective_root(root: PathBuf) -> Result<PathBuf, PathError> {
    ensure_dir(&root)?;
    if let Err(err) = harden_existing_data_root(&root) {
        eprintln!("failed to harden data root permissions for {root:?}: {err}");
    }
    Ok(root)
}

// --- Storage-location validation ------------------------------------------

/// Validates a candidate storage location (a future data root) chosen by the
/// user, e.g. before persisting it via [`StoragePrefs`].
///
/// Accepts an existing writable directory, or a not-yet-existing path under
/// a writable, non-symlinked ancestor (it is created later by
/// [`effective_data_root`], not here — validation itself only writes and
/// immediately removes a short-lived writability probe file).
///
/// Rejects with [`AppError::Path`] when the path is empty, names an existing
/// non-directory (file, socket, …), when the path itself or its nearest
/// existing ancestor is a symlink (which could otherwise redirect the whole
/// archive outside the chosen location), or when the directory is not
/// writable (missing owner write bit, or a failed probe write).
///
/// Notably this does *not* reject anything under `~/Library`: iCloud Drive
/// lives at `~/Library/Mobile Documents/` and is a legitimate storage
/// choice. Do not "harden" this by reusing `commands::export`'s `~/Library`
/// confinement — that reject exists for a different threat (save-dialog
/// destinations) and would lock out iCloud.
pub fn validate_storage_location(path: impl AsRef<Path>) -> Result<(), AppError> {
    use std::io::Write as _;

    let path = path.as_ref();
    if path.as_os_str().is_empty() {
        return Err(AppError::Path(
            "storage location must not be empty".to_string(),
        ));
    }

    // Resolve relative candidates against the process working directory so
    // the ancestor walk below always terminates (at `/` in the worst case).
    let joined;
    let path: &Path = if path.is_absolute() {
        path
    } else {
        joined = std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .map_err(|err| {
                AppError::Path(format!("failed to resolve the storage location: {err}"))
            })?;
        &joined
    };

    // The location itself must not be a symlink: it would redirect the
    // archive wherever the link points.
    if is_symlink(path) {
        return Err(AppError::Path(
            "storage location must not be a symlink".to_string(),
        ));
    }

    if path.exists() && !path.is_dir() {
        return Err(AppError::Path(format!(
            "storage location is not a directory: {}",
            path.display()
        )));
    }

    // Nearest existing ancestor: the writability anchor for not-yet-existing
    // locations. Only this one component is symlink-checked — higher
    // ancestors may legitimately traverse OS symlinks (`/var` →
    // `private/var` on macOS, which every `tempfile::tempdir()` path
    // contains), so walking further up would reject nearly every real path
    // on that platform.
    let anchor = nearest_existing_ancestor(path).ok_or_else(|| {
        AppError::Path(format!(
            "storage location has no resolvable parent directory: {}",
            path.display()
        ))
    })?;
    if is_symlink(anchor) {
        return Err(AppError::Path(
            "storage location is inside a symlinked directory".to_string(),
        ));
    }

    // Directory whose writability proves the candidate is usable: the
    // location itself when it exists, otherwise the ancestor it would be
    // created under.
    let probe_dir = if path.exists() { path } else { anchor };

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(probe_dir)
            .map(|metadata| metadata.permissions().mode())
            .unwrap_or(0);
        if mode & 0o200 == 0 {
            return Err(AppError::Path(format!(
                "storage location is not writable: {}",
                probe_dir.display()
            )));
        }
    }

    // Live probe: permission bits miss ACLs and read-only mounts, so prove
    // the write with a file that is removed immediately afterwards.
    let probe = probe_dir.join(".myna-write-probe");
    match fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&probe)
    {
        Ok(mut file) => {
            let write_result = file.write_all(b"probe");
            drop(file);
            let _ = fs::remove_file(&probe);
            write_result
                .map_err(|err| AppError::Path(format!("storage location is not writable: {err}")))
        }
        Err(err) => Err(AppError::Path(format!(
            "storage location is not writable: {err}"
        ))),
    }
}

/// Whether `path` itself is a symlink (never following it).
fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
}

/// Nearest ancestor of `path` (or `path` itself) that exists on disk, or
/// `None` when the walk leaves the path without meeting one (only possible
/// for relative paths, which callers resolve before calling this).
fn nearest_existing_ancestor(path: &Path) -> Option<&Path> {
    let mut current = Some(path);
    while let Some(candidate) = current {
        if candidate.exists() {
            return Some(candidate);
        }
        current = candidate
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- ensure_dir: at-rest permissions (security hardening) ------------

    #[test]
    #[cfg(unix)]
    fn ensure_dir_creates_the_directory_with_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;

        // Arrange: a fresh path that does not exist yet, standing in for
        // `data_root()`'s `~/myna` on a first run.
        let parent = tempfile::tempdir().expect("tempdir");
        let target = parent.path().join("data-root");

        // Act
        ensure_dir(&target).expect("ensure_dir should succeed");

        // Assert: exactly 0700 (owner rwx, no group/other access at all).
        // Confirmed this fails against the pre-fix code, which delegated to
        // plain `fs::create_dir_all` and left the directory at the process
        // umask default (0755 on a typical dev machine) -- i.e. world- and
        // group-readable, even though `~/myna` is not a TCC-protected path.
        let mode = fs::metadata(&target)
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(
            mode, 0o700,
            "expected the data directory to be created 0700, got {mode:o}"
        );
    }

    #[test]
    #[cfg(unix)]
    fn ensure_dir_applies_owner_only_permissions_to_every_created_ancestor() {
        use std::os::unix::fs::PermissionsExt;

        // Arrange: neither `meetings` nor its parent `data-root` exist yet.
        let parent = tempfile::tempdir().expect("tempdir");
        let target = parent.path().join("data-root").join("meetings");

        // Act
        ensure_dir(&target).expect("ensure_dir should succeed");

        // Assert: both the leaf and the newly created intermediate
        // directory are 0700, not just the leaf.
        for dir in [target.parent().expect("has parent"), target.as_path()] {
            let mode = fs::metadata(dir).expect("metadata").permissions().mode() & 0o777;
            assert_eq!(mode, 0o700, "expected {dir:?} to be 0700, got {mode:o}");
        }
    }

    // --- harden_existing_data_root: migrating pre-existing at-rest data --

    #[test]
    #[cfg(unix)]
    fn harden_existing_data_root_tightens_loose_pre_existing_entries() {
        use std::os::unix::fs::PermissionsExt;

        // Arrange: a data-root tree as it would exist on disk before this
        // hardening pass shipped -- created under the process umask
        // default (0755 dirs, 0644 files), not the 0700/0600 policy
        // `create_dir_all_0700`/`write_0600` apply to newly created paths.
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("data-root");
        let meetings_dir = root.join("meetings");
        let meeting_dir = meetings_dir.join("meeting-1");
        fs::create_dir_all(&meeting_dir).expect("create meeting dir");
        for dir in [&root, &meetings_dir, &meeting_dir] {
            fs::set_permissions(dir, fs::Permissions::from_mode(0o755)).expect("chmod dir");
        }
        let audio_path = meeting_dir.join("audio.wav");
        fs::write(&audio_path, b"pcm").expect("write audio");
        fs::set_permissions(&audio_path, fs::Permissions::from_mode(0o644)).expect("chmod audio");

        // Act
        harden_existing_data_root(&root).expect("harden should succeed");

        // Assert: every directory is tightened to 0700 and the file to
        // 0600. Confirmed this fails before the fix: with
        // `harden_existing_data_root` stubbed to a no-op `Ok(())`, this
        // assertion fails with root/meetings/meeting-dir still at 0755 and
        // audio.wav still at 0644.
        for dir in [&root, &meetings_dir, &meeting_dir] {
            let mode = fs::metadata(dir).expect("metadata").permissions().mode() & 0o777;
            assert_eq!(
                mode, 0o700,
                "expected {dir:?} to be tightened to 0700, got {mode:o}"
            );
        }
        let file_mode = fs::metadata(&audio_path)
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(
            file_mode, 0o600,
            "expected {audio_path:?} to be tightened to 0600, got {file_mode:o}"
        );
    }

    #[test]
    #[cfg(unix)]
    fn harden_existing_data_root_leaves_already_tight_entries_untouched() {
        use std::os::unix::fs::PermissionsExt;

        // Arrange: a data root already at the target policy.
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("data-root");
        fs::create_dir_all(&root).expect("create root");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("chmod root");
        let file_path = root.join("meeting.json");
        fs::write(&file_path, b"{}").expect("write file");
        fs::set_permissions(&file_path, fs::Permissions::from_mode(0o600)).expect("chmod file");

        // Act
        let result = harden_existing_data_root(&root);

        // Assert: succeeds, and the already-tight entries are unchanged.
        assert!(result.is_ok(), "expected Ok, got {result:?}");
        let dir_mode = fs::metadata(&root).expect("metadata").permissions().mode() & 0o777;
        assert_eq!(dir_mode, 0o700);
        let file_mode = fs::metadata(&file_path)
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(file_mode, 0o600);
    }

    // Every case below drives `resolve_models_root` / `resolve_dev_models_root`
    // through explicit parameters rather than mutating the real
    // `MYNA_MODELS_DIR` process environment variable —
    // `std::env::set_var`/`remove_var` require `unsafe`, and this workspace
    // forbids `unsafe_code` outright (see `[workspace.lints]` in the root
    // `Cargo.toml`). Models never consult the data-dir override or the persisted
    // storage pointer: meetings follow the effective data root, models stay
    // pinned to the fixed `~/myna/models`. This also means these tests are
    // free of the process-global-state races that env-var mutation would
    // otherwise introduce between parallel `#[test]` fns.

    #[test]
    fn models_dir_override_wins_regardless_of_debug_or_release() {
        // Arrange
        let override_dir = PathBuf::from("/override/models");

        // Act / Assert
        assert_eq!(
            resolve_models_root(Some(override_dir.clone()), true),
            override_dir
        );
        assert_eq!(
            resolve_models_root(Some(override_dir.clone()), false),
            override_dir
        );
    }

    #[test]
    fn models_root_ignores_data_dir_override() {
        // Arrange: a custom data root standing in for a data-dir override
        // or a persisted custom pointer — meetings follow it, models must not.
        let custom_parent = tempfile::tempdir().expect("tempdir");
        let custom_root = custom_parent.path().join("myna-test");
        let config_dir = tempfile::tempdir().expect("tempdir");
        let effective = effective_data_root(Some(custom_root.clone()), config_dir.path())
            .expect("effective root");
        assert_eq!(effective, custom_root);

        let expected_fixed = home_dir()
            .expect("home")
            .join(DATA_DIR_NAME)
            .join(MODELS_DIR_NAME);

        // Act
        let release = resolve_models_root(None, false);

        // Assert: the fixed dir is returned even though the effective data
        // root points at the custom location.
        assert_eq!(release, expected_fixed);
        assert_ne!(release, custom_root.join(MODELS_DIR_NAME));
    }

    #[test]
    fn release_build_resolves_to_fixed_models_root() {
        // Arrange: no MYNA_MODELS_DIR override — the release path is the
        // fixed `~/myna/models`, never `<effective_data_root>/models`.

        // Act
        let resolved = resolve_models_root(None, false);

        // Assert
        let expected_fixed = home_dir()
            .expect("home")
            .join(DATA_DIR_NAME)
            .join(MODELS_DIR_NAME);
        assert_eq!(resolved, expected_fixed);
    }

    #[test]
    fn dev_build_prefers_fixed_models_dir_when_both_exist() {
        // Arrange: the fixed `~/myna/models` stand-in exists (the
        // downloader's canonical destination) while the repo checkout also
        // has one — the fixed dir wins so `npx tauri dev` checks the same
        // place `scripts/download-models.sh` writes.
        let fixed_parent = tempfile::tempdir().expect("tempdir");
        let fixed_models = fixed_parent.path().join(MODELS_DIR_NAME);
        fs::create_dir_all(&fixed_models).expect("create fixed models");
        let repo_models = tempfile::tempdir().expect("tempdir");
        fs::create_dir_all(repo_models.path().join("parakeet-tdt-0.6b-v3-int8"))
            .expect("create repo weights");

        // Act
        let resolved =
            resolve_dev_models_root(repo_models.path().to_path_buf(), fixed_models.clone());

        // Assert
        assert_eq!(resolved, fixed_models);
    }

    #[test]
    fn resolve_dev_models_root_prefers_repo_dir_when_it_holds_weights() {
        // Arrange: a repo models dir holding actual weights (a
        // subdirectory) while the fixed dir does not exist — the legacy
        // pre-migration layout is honoured so existing checkouts are not
        // forced to re-download ~5.4 GB.
        let repo_models = tempfile::tempdir().expect("tempdir");
        fs::create_dir_all(repo_models.path().join("parakeet-tdt-0.6b-v3-int8"))
            .expect("create weights subdir");
        let isolated_root = tempfile::tempdir().expect("tempdir");
        let missing_fixed = isolated_root.path().join("does-not-exist-fixed-models");

        // Act
        let resolved = resolve_dev_models_root(repo_models.path().to_path_buf(), missing_fixed);

        // Assert
        assert_eq!(resolved, repo_models.path());
    }

    #[test]
    fn resolve_dev_models_root_ignores_git_kept_placeholder_repo_dir() {
        // Arrange: a repo models dir with only placeholder files (the
        // checked-in `README.md`, no weights subdirectories) while the
        // fixed dir is absent — the placeholder must never shadow the
        // canonical fixed path. (When the fixed dir exists it wins outright;
        // see `dev_build_prefers_fixed_models_dir_when_both_exist`.)
        let repo_models = tempfile::tempdir().expect("tempdir");
        fs::write(repo_models.path().join("README.md"), b"placeholder").expect("write placeholder");
        let isolated_root = tempfile::tempdir().expect("tempdir");
        let missing_fixed = isolated_root.path().join("does-not-exist-fixed-models");

        // Act
        let resolved =
            resolve_dev_models_root(repo_models.path().to_path_buf(), missing_fixed.clone());

        // Assert: falls back to the fixed path, not the placeholder repo dir.
        assert_eq!(resolved, missing_fixed);
    }

    #[test]
    fn resolve_dev_models_root_falls_back_to_fixed_path_when_repo_dir_absent() {
        // Arrange: a repo models path that does not exist, and a fixed
        // models dir that does exist.
        let fixed_parent = tempfile::tempdir().expect("tempdir");
        let fixed_models = fixed_parent.path().join(MODELS_DIR_NAME);
        fs::create_dir_all(&fixed_models).expect("create fixed models dir");
        let missing_repo_models = fixed_parent.path().join("does-not-exist-repo-models");

        // Act
        let resolved = resolve_dev_models_root(missing_repo_models, fixed_models.clone());

        // Assert
        assert_eq!(resolved, fixed_models);
    }

    #[test]
    fn resolve_dev_models_root_falls_back_to_fixed_path_when_neither_exists() {
        // Arrange: neither the repo models dir nor the fixed models dir
        // exists.
        let isolated_root = tempfile::tempdir().expect("tempdir");
        let missing_repo_models = isolated_root.path().join("does-not-exist-repo-models");
        let missing_fixed = isolated_root.path().join("does-not-exist-fixed-models");

        // Act
        let resolved = resolve_dev_models_root(missing_repo_models.clone(), missing_fixed.clone());

        // Assert: falls back to the (not-yet-existing) canonical fixed path
        // so a fresh download lands where `scripts/download-models.sh`
        // writes by default — not the legacy repo path.
        assert_eq!(resolved, missing_fixed);
    }

    // --- stranded_models_between: detector for weights left under a ------
    // --- custom storage location by a pre-skip migration -------------------

    /// Writes the complete core weights set (Parakeet + Qwen + Silero) under
    /// `models_root`, mirroring `models_dir_complete`'s expectations.
    fn seed_complete_models(models_root: &Path) {
        for (dir_name, files) in [
            (
                "parakeet-tdt-0.6b-v3-int8",
                vec![
                    "encoder.int8.onnx",
                    "decoder.int8.onnx",
                    "joiner.int8.onnx",
                    "tokens.txt",
                ],
            ),
            (
                "qwen2.5-7b-instruct",
                vec![
                    "qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf",
                    "qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf",
                ],
            ),
            ("silero-vad", vec!["silero_vad.onnx"]),
        ] {
            let dir = models_root.join(dir_name);
            fs::create_dir_all(&dir).expect("create model dir fixture");
            for file in files {
                fs::write(dir.join(file), b"model").expect("write model fixture file");
            }
        }
    }

    #[test]
    fn stranded_models_detected_when_stranded_complete_and_fixed_missing() {
        // Arrange: a custom root holding complete weights while the fixed
        // root does not exist at all.
        let sandbox = tempfile::tempdir().expect("tempdir");
        let stranded = sandbox.path().join("custom-models");
        seed_complete_models(&stranded);
        let fixed = sandbox.path().join("does-not-exist-fixed-models");

        // Act
        let detected = stranded_models_between(&stranded, &fixed);

        // Assert
        assert_eq!(detected, Some(stranded));
    }

    #[test]
    fn stranded_models_detected_when_fixed_only_incomplete() {
        // Arrange: the fixed root exists but holds only a partial set
        // (Parakeet alone), while the custom root is complete.
        let sandbox = tempfile::tempdir().expect("tempdir");
        let stranded = sandbox.path().join("custom-models");
        seed_complete_models(&stranded);
        let fixed = sandbox.path().join("fixed-models");
        let partial = fixed.join("parakeet-tdt-0.6b-v3-int8");
        fs::create_dir_all(&partial).expect("create partial fixture");
        fs::write(partial.join("encoder.int8.onnx"), b"model").expect("write fixture");

        // Act
        let detected = stranded_models_between(&stranded, &fixed);

        // Assert
        assert_eq!(detected, Some(stranded));
    }

    #[test]
    fn stranded_models_absent_when_fixed_complete() {
        // Arrange: both roots hold complete weights — nothing is stranded,
        // the fixed root serves the app.
        let sandbox = tempfile::tempdir().expect("tempdir");
        let stranded = sandbox.path().join("custom-models");
        seed_complete_models(&stranded);
        let fixed = sandbox.path().join("fixed-models");
        seed_complete_models(&fixed);

        // Act / Assert
        assert_eq!(stranded_models_between(&stranded, &fixed), None);
    }

    #[test]
    fn stranded_models_absent_when_stranded_incomplete() {
        // Arrange: the custom root holds only a partial set — not a usable
        // weights dir worth flagging.
        let sandbox = tempfile::tempdir().expect("tempdir");
        let stranded = sandbox.path().join("custom-models");
        fs::create_dir_all(stranded.join("silero-vad")).expect("create partial fixture");
        fs::write(
            stranded.join("silero-vad").join("silero_vad.onnx"),
            b"model",
        )
        .expect("write fixture");
        let fixed = sandbox.path().join("does-not-exist-fixed-models");

        // Act / Assert
        assert_eq!(stranded_models_between(&stranded, &fixed), None);
    }

    #[test]
    fn stranded_models_absent_when_effective_is_the_fixed_location() {
        // Arrange: the effective root IS the fixed location (same dir) —
        // complete weights there are home, not stranded.
        let sandbox = tempfile::tempdir().expect("tempdir");
        let fixed = sandbox.path().join("fixed-models");
        seed_complete_models(&fixed);

        // Act / Assert
        assert_eq!(stranded_models_between(&fixed, &fixed), None);
    }
}
