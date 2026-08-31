//! Filesystem-backed [`FolderStore`]: a single `folders.json` file at the
//! store's root, holding every folder record.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::domain::folder::{Folder, FolderId};
use crate::error::AppError;
use crate::store::FolderStore;

const FOLDERS_FILE: &str = "folders.json";
const FOLDERS_TMP_FILE: &str = "folders.json.tmp";
const CURRENT_VERSION: u32 = 1;
const MAX_FOLDERS: usize = 200;

/// On-disk shape of `folders.json`.
#[derive(Serialize, Deserialize)]
struct FoldersFile {
    version: u32,
    folders: Vec<Folder>,
}

/// Filesystem-backed folder store rooted at an arbitrary directory.
///
/// Production code roots this at the user's data directory (see
/// `crate::paths::data_root`), the same root `FsMeetingStore` uses; tests
/// root it at a `tempfile::tempdir()` so persistence is exercised without
/// touching the user's real `~/myna`.
pub struct FsFolderStore {
    root: PathBuf,
    write_lock: Mutex<()>,
}

impl FsFolderStore {
    /// Creates a store rooted at `root`. Does not create any directories
    /// eagerly; they are created lazily on first write.
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            write_lock: Mutex::new(()),
        }
    }

    fn folders_json_path(&self) -> PathBuf {
        self.root.join(FOLDERS_FILE)
    }

    fn folders_tmp_path(&self) -> PathBuf {
        self.root.join(FOLDERS_TMP_FILE)
    }

    /// Reads and parses `folders.json`, returning an empty list when the
    /// file is absent. A corrupt file is quarantined (renamed to
    /// `folders.json.corrupt-<epoch_secs>`) and treated as empty, rather
    /// than failing — an unrecoverable read error here would break launch
    /// forever. A recognized-but-unsupported schema version is a hard
    /// error, since silently ignoring newer data would be surprising.
    fn read_all(&self) -> Result<Vec<Folder>, AppError> {
        let path = self.folders_json_path();
        if !path.exists() {
            return Ok(Vec::new());
        }

        let raw = fs::read_to_string(&path)?;
        let parsed: FoldersFile = match serde_json::from_str(&raw) {
            Ok(parsed) => parsed,
            Err(_) => {
                self.quarantine(&path)?;
                return Ok(Vec::new());
            }
        };

        if parsed.version > CURRENT_VERSION {
            return Err(AppError::Store(format!(
                "unsupported folders.json schema version {}",
                parsed.version
            )));
        }

        Ok(parsed.folders)
    }

    /// Renames a corrupt `folders.json` out of the way so it doesn't keep
    /// failing every future launch, while preserving it for inspection.
    fn quarantine(&self, path: &Path) -> Result<(), AppError> {
        let epoch_secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or(0);
        let quarantine_path = self.root.join(format!("folders.json.corrupt-{epoch_secs}"));
        fs::rename(path, quarantine_path)?;
        Ok(())
    }

    /// Serializes `folders` and writes them atomically (tmp file + rename).
    fn write_all(&self, folders: &[Folder]) -> Result<(), AppError> {
        let _guard = self
            .write_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        fs::create_dir_all(&self.root)?;
        let file = FoldersFile {
            version: CURRENT_VERSION,
            folders: folders.to_vec(),
        };
        let json =
            serde_json::to_string_pretty(&file).map_err(|err| AppError::Store(err.to_string()))?;
        let tmp_path = self.folders_tmp_path();
        fs::write(&tmp_path, json)?;
        fs::rename(&tmp_path, self.folders_json_path())?;
        Ok(())
    }
}

impl FolderStore for FsFolderStore {
    fn list(&self) -> Result<Vec<Folder>, AppError> {
        let mut folders = self.read_all()?;
        folders.sort_by(|a, b| {
            a.position
                .cmp(&b.position)
                .then_with(|| a.created_at.cmp(&b.created_at))
        });
        Ok(folders)
    }

    fn create(&self, name: &str) -> Result<Folder, AppError> {
        let mut folders = self.read_all()?;
        if folders.len() >= MAX_FOLDERS {
            return Err(AppError::Store(format!(
                "cannot create more than {MAX_FOLDERS} folders"
            )));
        }
        let position = folders.len() as u32;
        let folder = Folder::new(name, position);
        folders.push(folder.clone());
        self.write_all(&folders)?;
        Ok(folder)
    }

    fn save(&self, folder: &Folder) -> Result<(), AppError> {
        let mut folders = self.read_all()?;
        match folders.iter_mut().find(|existing| existing.id == folder.id) {
            Some(existing) => *existing = folder.clone(),
            None => folders.push(folder.clone()),
        }
        self.write_all(&folders)
    }

    fn delete(&self, id: FolderId) -> Result<(), AppError> {
        let mut folders = self.read_all()?;
        folders.retain(|folder| folder.id != id);
        self.write_all(&folders)
    }
}
