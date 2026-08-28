//! Persistence port for meetings: the [`MeetingStore`] trait and its
//! filesystem-backed implementation ([`fs_store::FsMeetingStore`]).

pub mod fs_store;

use std::path::PathBuf;

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

    /// Returns the path at which a meeting's audio recording should live.
    fn audio_path(&self, id: MeetingId) -> PathBuf;

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
}
