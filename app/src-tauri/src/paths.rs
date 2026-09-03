//! On-disk locations used by the rest of the app: the user's data root and
//! the model/template resource directories.

use std::path::{Path, PathBuf};
use std::{env, fs};

use tauri::Manager;
use thiserror::Error;

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
}

const DATA_DIR_ENV: &str = "MYNA_DATA_DIR";
const MODELS_DIR_ENV: &str = "MYNA_MODELS_DIR";
const TEMPLATES_DIR_ENV: &str = "MYNA_TEMPLATES_DIR";
const DATA_DIR_NAME: &str = "myna";
const MEETINGS_DIR_NAME: &str = "meetings";
const MODELS_DIR_NAME: &str = "models";
const TEMPLATES_DIR_NAME: &str = "templates";

/// Resolves the Myna data root path (`~/myna` by default) without creating
/// it, given an explicit `MYNA_DATA_DIR` override (or `None` to fall back
/// to the home-directory default).
///
/// Takes the override as a parameter — rather than reading
/// `MYNA_DATA_DIR` from the process environment directly — so callers that
/// need to resolve it for a hypothetical override (e.g. tests exercising
/// [`resolve_models_root`]'s precedence) can do so without mutating real
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
/// they live in the user's data area (`<data_root>/models`, i.e.
/// `~/myna/models` by default) in release builds, downloaded there by
/// `scripts/download-models.sh`.
///
/// In dev builds, resolves the repo-relative `models/` directory (so the
/// existing CLI/integration-test workflow keeps working) unless that
/// directory is absent and `<data_root>/models` already exists, in which
/// case the latter is preferred so a dev build behaves sanely against
/// models fetched via the release-style flow.
///
/// Honours `MYNA_MODELS_DIR` as an override, which takes precedence over
/// both of the above.
pub fn models_root(_app: &tauri::AppHandle) -> PathBuf {
    resolve_models_root(
        env::var_os(MODELS_DIR_ENV).map(PathBuf::from),
        env::var_os(DATA_DIR_ENV).map(PathBuf::from),
        cfg!(debug_assertions),
    )
}

/// Testable core of [`models_root`], parameterized on the `MYNA_MODELS_DIR`
/// / `MYNA_DATA_DIR` overrides and debug-vs-release — rather than reading
/// process env vars or `cfg!(debug_assertions)` directly — so every
/// precedence branch is unit-testable without mutating process-global
/// state (which `std::env::set_var`/`remove_var` require `unsafe` for, and
/// this workspace forbids `unsafe_code` outright).
pub fn resolve_models_root(
    models_dir_override: Option<PathBuf>,
    data_dir_override: Option<PathBuf>,
    is_debug_build: bool,
) -> PathBuf {
    if let Some(dir) = models_dir_override {
        return dir;
    }

    if is_debug_build {
        resolve_dev_models_root(repo_root().join(MODELS_DIR_NAME), data_dir_override)
    } else {
        resolve_release_models_root(data_dir_override)
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

/// Dev-mode models root: prefers `repo_models` (the repo's `models/`
/// directory in production use); falls back to the user data root's
/// `models/` directory when `repo_models` is absent but the user one
/// already exists on disk. Takes `repo_models` as a parameter so the
/// repo-present and repo-absent branches are both unit-testable without
/// touching the real (multi-GB) repo `models/` directory.
fn resolve_dev_models_root(repo_models: PathBuf, data_dir_override: Option<PathBuf>) -> PathBuf {
    if repo_models.exists() {
        return repo_models;
    }

    match resolve_user_models_dir(data_dir_override) {
        Some(user_models) if user_models.exists() => user_models,
        _ => repo_models,
    }
}

/// Release-mode models root: `<data_root>/models`. The directory itself is
/// populated by `scripts/download-models.sh`, not created eagerly here —
/// only the data root (`~/myna`) is ensured to exist.
fn resolve_release_models_root(data_dir_override: Option<PathBuf>) -> PathBuf {
    resolve_user_models_dir(data_dir_override).unwrap_or_else(|| PathBuf::from(MODELS_DIR_NAME))
}

/// `<data_root>/models` for an explicit (or absent) `MYNA_DATA_DIR`
/// override, ensuring the data root exists. Returns `None` only when the
/// data root itself cannot be resolved (e.g. no home directory).
fn resolve_user_models_dir(data_dir_override: Option<PathBuf>) -> Option<PathBuf> {
    let root = data_root_path_with(data_dir_override).ok()?;
    ensure_dir(&root).ok()?;
    Some(root.join(MODELS_DIR_NAME))
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
    // `MYNA_MODELS_DIR` / `MYNA_DATA_DIR` process environment variables —
    // `std::env::set_var`/`remove_var` require `unsafe`, and this workspace
    // forbids `unsafe_code` outright (see `[workspace.lints]` in the root
    // `Cargo.toml`). This also means these tests are free of the
    // process-global-state races that env-var mutation would otherwise
    // introduce between parallel `#[test]` fns.

    #[test]
    fn models_dir_override_wins_regardless_of_debug_or_release() {
        // Arrange
        let override_dir = PathBuf::from("/override/models");

        // Act / Assert
        assert_eq!(
            resolve_models_root(Some(override_dir.clone()), None, true),
            override_dir
        );
        assert_eq!(
            resolve_models_root(Some(override_dir.clone()), None, false),
            override_dir
        );
    }

    #[test]
    fn release_build_resolves_under_data_root_models_subdir() {
        // Arrange
        let data_root = tempfile::tempdir().expect("tempdir");

        // Act
        let resolved = resolve_models_root(None, Some(data_root.path().to_path_buf()), false);

        // Assert
        assert_eq!(resolved, data_root.path().join(MODELS_DIR_NAME));
    }

    #[test]
    fn dev_build_prefers_repo_models_dir_when_present() {
        // Arrange: the repo's real `models/` directory exists on this
        // machine, so it is preferred even when a data-root override with
        // its own `models/` dir is also supplied.
        let data_root = tempfile::tempdir().expect("tempdir");
        fs::create_dir_all(data_root.path().join(MODELS_DIR_NAME)).expect("create user models");

        // Act
        let resolved = resolve_models_root(None, Some(data_root.path().to_path_buf()), true);

        // Assert
        assert_eq!(resolved, repo_root().join(MODELS_DIR_NAME));
    }

    #[test]
    fn resolve_dev_models_root_prefers_repo_dir_when_present() {
        // Arrange
        let repo_models = tempfile::tempdir().expect("tempdir");

        // Act
        let resolved = resolve_dev_models_root(repo_models.path().to_path_buf(), None);

        // Assert
        assert_eq!(resolved, repo_models.path());
    }

    #[test]
    fn resolve_dev_models_root_falls_back_to_user_data_root_when_repo_dir_absent() {
        // Arrange: a repo models path that does not exist, and a user data
        // root whose `models/` subdirectory does exist.
        let data_root = tempfile::tempdir().expect("tempdir");
        let user_models = data_root.path().join(MODELS_DIR_NAME);
        fs::create_dir_all(&user_models).expect("create user models dir");
        let missing_repo_models = data_root.path().join("does-not-exist-repo-models");

        // Act
        let resolved =
            resolve_dev_models_root(missing_repo_models, Some(data_root.path().to_path_buf()));

        // Assert
        assert_eq!(resolved, user_models);
    }

    #[test]
    fn resolve_dev_models_root_falls_back_to_repo_path_when_neither_exists() {
        // Arrange: neither the repo models dir nor the user data root exists.
        let isolated_root = tempfile::tempdir().expect("tempdir");
        let missing_repo_models = isolated_root.path().join("does-not-exist-repo-models");
        let missing_data_root = isolated_root.path().join("does-not-exist-data-root");

        // Act
        let resolved =
            resolve_dev_models_root(missing_repo_models.clone(), Some(missing_data_root));

        // Assert: falls back to the (non-existent) repo path since nothing
        // else is available.
        assert_eq!(resolved, missing_repo_models);
    }
}
