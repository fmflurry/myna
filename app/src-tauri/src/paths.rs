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
/// Models are ~2.6 GB of weights that must never be bundled into the app;
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

    fs::create_dir_all(path).map_err(|source| PathError::CreateDir {
        path: path.to_path_buf(),
        source,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
