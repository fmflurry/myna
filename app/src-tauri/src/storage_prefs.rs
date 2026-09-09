//! Persisted data-root pointer: remembers a user-chosen storage location
//! across restarts.
//!
//! The pointer lives in the Tauri app config directory
//! (`~/Library/Application Support/app.myna.desktop/` on macOS) — it cannot
//! live inside the data root itself, which would be a chicken-and-egg
//! problem (the pointer is what tells us where the data root is).
//!
//! Mirrors [`crate::update_prefs`]'s storage contract: loads never fail (a
//! missing, corrupt, or unreadable file yields [`StoragePrefs::default`] —
//! no custom location), and saves merge into the existing top-level object
//! so unrelated keys survive, writing via the owner-only (`0600`) helper.
//! The pointer gets its own dedicated file (`storage.json`) rather than
//! sharing `preferences.json`, so concurrent settings writers in the data
//! root can never clobber it (and vice versa).

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::Manager;

use crate::error::AppError;
use crate::paths;

/// File holding the pointer, directly under the app config directory.
const STORAGE_FILE: &str = "storage.json";
/// Alternate file layout: a shared preferences file read under the
/// `"storage"` key (mirrors [`crate::update_prefs`]'s namespacing).
/// Accepted on load so a pointer written in either layout is honoured;
/// saves always target [`STORAGE_FILE`].
const PREFERENCES_FILE: &str = "preferences.json";
/// Namespaced key used inside [`PREFERENCES_FILE`].
const STORAGE_KEY: &str = "storage";
/// Canonical top-level key naming the custom data directory.
const DATA_DIR_KEY: &str = "data_dir";

/// Persisted pointer to a user-chosen data root.
///
/// `None` (the default) means "no custom location" — callers fall back to
/// `~/myna` (see [`crate::paths::effective_data_root`]).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct StoragePrefs {
    /// Custom data root chosen by the user, if any. Aliases accept pointers
    /// written under alternate key names.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "location",
        alias = "data_root",
        alias = "path"
    )]
    pub data_dir: Option<PathBuf>,
}

impl StoragePrefs {
    /// Creates a pointer for `data_dir` (`None` clears it).
    pub fn new(data_dir: Option<PathBuf>) -> Self {
        let mut prefs = Self::default();
        prefs.set_data_dir(data_dir);
        prefs
    }

    /// Loads the pointer from `config_dir` (the Tauri app config dir in
    /// production, any directory in tests).
    ///
    /// Never errors and never panics: a missing file, a file that isn't
    /// valid JSON, a file whose shape doesn't match, or an unreadable path
    /// all yield [`StoragePrefs::default`]. An empty-string path is treated
    /// as unset.
    pub fn load(config_dir: impl AsRef<Path>) -> Self {
        let config_dir = config_dir.as_ref();
        read_pointer_file(&config_dir.join(STORAGE_FILE))
            .or_else(|| read_namespaced_pointer(&config_dir.join(PREFERENCES_FILE)))
            .unwrap_or_default()
            .normalized()
    }

    /// Persists the pointer into `config_dir`, preserving any unrelated
    /// top-level keys already present in the file (a missing or corrupt file
    /// is treated as an empty object rather than failing the save). Creates
    /// `config_dir` (`0700`) if missing and writes the file atomically —
    /// content goes to a `.tmp` sibling (`0600` from creation, so the
    /// pointer never has a world- or group-readable window) followed by a
    /// same-directory rename, so a crash mid-save leaves either the old or
    /// the new pointer, never a half-written file. A `None` pointer
    /// removes the key instead of writing null.
    pub fn save(&self, config_dir: impl AsRef<Path>) -> Result<(), AppError> {
        let config_dir = config_dir.as_ref();
        let path = config_dir.join(STORAGE_FILE);

        let mut root_map = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|value| match value {
                Value::Object(map) => Some(map),
                _ => None,
            })
            .unwrap_or_default();

        match &self.data_dir {
            Some(dir) if !dir.as_os_str().is_empty() => {
                root_map.insert(
                    DATA_DIR_KEY.to_string(),
                    Value::String(dir.to_string_lossy().into_owned()),
                );
            }
            _ => {
                root_map.remove(DATA_DIR_KEY);
            }
        }

        paths::create_dir_all_0700(config_dir)?;
        let json = serde_json::to_string_pretty(&Value::Object(root_map))
            .map_err(|err| AppError::Store(err.to_string()))?;
        let tmp = path.with_extension("json.tmp");
        paths::write_0600(&tmp, json.as_bytes())?;
        if let Err(err) = fs::rename(&tmp, &path) {
            let _ = fs::remove_file(&tmp);
            return Err(AppError::Io(err));
        }
        Ok(())
    }

    /// Loads via the live app config dir. Never fails: when the config dir
    /// itself cannot be resolved there is no pointer to consult, so this
    /// yields [`StoragePrefs::default`] and callers fall back to `~/myna`.
    pub fn load_for_app(app: &tauri::AppHandle) -> Self {
        app_config_dir(app)
            .map(|dir| Self::load(&dir))
            .unwrap_or_default()
    }

    /// Saves via the live app config dir.
    pub fn save_for_app(&self, app: &tauri::AppHandle) -> Result<(), AppError> {
        self.save(app_config_dir(app)?)
    }

    /// Resolves the Tauri app config dir — see [`app_config_dir`].
    pub fn config_dir(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
        app_config_dir(app)
    }

    /// The pointed-to directory, if any.
    pub fn data_dir(&self) -> Option<&Path> {
        self.data_dir.as_deref()
    }

    /// Sets (or clears, with `None` or an empty path) the pointed-to
    /// directory.
    pub fn set_data_dir(&mut self, dir: Option<PathBuf>) {
        self.data_dir = dir.filter(|dir| !dir.as_os_str().is_empty());
    }

    /// Clears any pointed-to directory.
    pub fn clear(&mut self) {
        self.data_dir = None;
    }

    /// Collapses empty-string pointers to unset so every load path agrees on
    /// what "no pointer" looks like.
    fn normalized(mut self) -> Self {
        if self
            .data_dir
            .as_ref()
            .is_some_and(|dir| dir.as_os_str().is_empty())
        {
            self.data_dir = None;
        }
        self
    }
}

/// Loads the pointer from `config_dir` — free-function mirror of
/// [`StoragePrefs::load`] matching [`crate::update_prefs::load`]'s shape.
pub fn load(config_dir: impl AsRef<Path>) -> StoragePrefs {
    StoragePrefs::load(config_dir)
}

/// Saves the pointer into `config_dir` — free-function mirror of
/// [`StoragePrefs::save`] matching [`crate::update_prefs::save`]'s shape.
pub fn save(config_dir: impl AsRef<Path>, prefs: &StoragePrefs) -> Result<(), AppError> {
    prefs.save(config_dir)
}

/// Resolves the Tauri app config directory
/// (`~/Library/Application Support/app.myna.desktop/` on macOS) — home of
/// the data-root pointer file.
pub fn app_config_dir(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .app_config_dir()
        .map_err(|err| AppError::Path(err.to_string()))
}

/// Reads a pointer from the file at `path`, accepting either the flat layout
/// (`{"data_dir": "..."}`) or the namespaced layout (`{"storage": {...}}`).
/// Returns `None` when the file is missing, unreadable, unparseable, or
/// holds no pointer — all of which mean "no pointer" (see
/// [`StoragePrefs::load`]).
fn read_pointer_file(path: &Path) -> Option<StoragePrefs> {
    let raw = fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    if let Ok(prefs) = serde_json::from_value::<StoragePrefs>(value.clone()) {
        if prefs.data_dir.is_some() {
            return Some(prefs);
        }
    }
    read_namespaced_pointer_value(&value)
}

/// Reads the `"storage"`-namespaced pointer from the file at `path`.
fn read_namespaced_pointer(path: &Path) -> Option<StoragePrefs> {
    let raw = fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    read_namespaced_pointer_value(&value)
}

/// Reads the `"storage"`-namespaced pointer from an already-parsed JSON
/// value.
fn read_namespaced_pointer_value(value: &Value) -> Option<StoragePrefs> {
    value
        .get(STORAGE_KEY)
        .cloned()
        .and_then(|section| serde_json::from_value(section).ok())
}
