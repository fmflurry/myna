//! Persistence ports for meetings and folders: the [`MeetingStore`] and
//! [`FolderStore`] traits and their filesystem-backed implementations
//! ([`fs_store::FsMeetingStore`], [`folder_store::FsFolderStore`]).

pub mod folder_store;
pub mod fs_store;

use std::path::PathBuf;

use crate::domain::folder::{Folder, FolderId};
use crate::domain::meeting::{Meeting, MeetingId};
use crate::domain::summary::Summary;
use crate::error::AppError;

/// Persistence port for meetings and their summaries.
///
/// Implementations own the on-disk (or otherwise durable) layout; callers
/// interact only through this trait so the storage backend can be swapped
/// without touching domain logic.
pub trait MeetingStore {
    /// Creates and persists a new meeting with the given title.
    fn create(&self, title: &str) -> Result<Meeting, AppError>;

    /// Loads a single meeting by id. Returns [`AppError::NotFound`] when the
    /// meeting does not exist.
    fn get(&self, id: MeetingId) -> Result<Meeting, AppError>;

    /// Lists all meetings, newest-first. Entries that fail to parse are
    /// skipped rather than failing the whole call.
    fn list(&self) -> Result<Vec<Meeting>, AppError>;

    /// Persists a (possibly updated) meeting, overwriting any prior state.
    fn save(&self, meeting: &Meeting) -> Result<(), AppError>;

    /// Deletes a meeting and all of its associated files.
    fn delete(&self, id: MeetingId) -> Result<(), AppError>;

    /// Returns the path at which a meeting's device-native-rate stereo
    /// playback/export recording should live.
    fn audio_path(&self, id: MeetingId) -> PathBuf;

    /// Returns the path at which a meeting's 16 kHz mono microphone STT
    /// track should live. Only ever written when the recording's capture
    /// source could populate a mic track — see
    /// `crate::session::source_has_mic`.
    fn mic_track_path(&self, id: MeetingId) -> PathBuf;

    /// Returns the path at which a meeting's 16 kHz mono system-audio STT
    /// track should live. Only ever written when the recording's capture
    /// source could populate a system track — see
    /// `crate::session::source_has_system`.
    fn system_track_path(&self, id: MeetingId) -> PathBuf;

    /// Returns the path at which a live recording's session durability
    /// manifest (`session.json`) lives. Its existence is the recovery
    /// invariant "a recording is in progress" (see
    /// `crate::session_manifest`); it is written when a session starts and
    /// deleted once the finished meeting has been saved.
    fn session_manifest_path(&self, id: MeetingId) -> PathBuf;

    /// Returns the path at which a live recording's transcript journal
    /// (`transcript-journal.jsonl`) lives — one finalized segment per line,
    /// appended by the decode worker so finals survive a crash (see
    /// `crate::session_manifest`). Deleted once the finished meeting has
    /// been saved.
    fn transcript_journal_path(&self, id: MeetingId) -> PathBuf;

    /// Persists a generated summary's markdown for a meeting/template/
    /// language triple, returning the path it was written to. Different
    /// languages for the same template are stored independently so they do
    /// not overwrite each other.
    fn save_summary(
        &self,
        id: MeetingId,
        template: &str,
        language: &str,
        markdown: &str,
    ) -> Result<PathBuf, AppError>;

    /// Loads a previously saved summary's markdown for a meeting/template/
    /// language triple.
    fn read_summary(
        &self,
        id: MeetingId,
        template: &str,
        language: &str,
    ) -> Result<Summary, AppError>;

    /// Deletes a previously saved summary's markdown for a
    /// meeting/template/language triple (`{template}__{language}.md`) and
    /// removes its entry from the meeting's summary list. Returns
    /// [`AppError::NotFound`] when the meeting or the summary does not
    /// exist.
    ///
    /// Provided with a placeholder default so the filesystem backend can
    /// land separately (see `fs_store` follow-up); backends must override.
    fn delete_summary(
        &self,
        id: MeetingId,
        template: &str,
        language: &str,
    ) -> Result<(), AppError> {
        let _ = (id, template, language);
        Err(AppError::Store(
            "delete_summary not implemented".to_string(),
        ))
    }
}

/// Persistence port for folders.
///
/// Implementations own the on-disk (or otherwise durable) layout; callers
/// interact only through this trait so the storage backend can be swapped
/// without touching domain logic.
pub trait FolderStore {
    /// Lists all folders, sorted by `(position, created_at)`.
    fn list(&self) -> Result<Vec<Folder>, AppError>;

    /// Creates and persists a new folder with the given name.
    fn create(&self, name: &str) -> Result<Folder, AppError>;

    /// Persists a (possibly updated) folder, overwriting any prior state.
    fn save(&self, folder: &Folder) -> Result<(), AppError>;

    /// Deletes a folder by id.
    fn delete(&self, id: FolderId) -> Result<(), AppError>;
}
