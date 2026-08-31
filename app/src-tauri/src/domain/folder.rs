//! The `Folder` aggregate: a user-defined grouping of meetings.
//!
//! Every mutation returns a new `Folder` rather than mutating in place —
//! there are no `&mut self` setters on this type, mirroring
//! `crate::domain::meeting::Meeting`.

use std::str::FromStr;

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

/// Stable identifier for a [`Folder`].
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct FolderId(Uuid);

impl FolderId {
    /// Generates a new, random folder id.
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for FolderId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for FolderId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl FromStr for FolderId {
    type Err = uuid::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Uuid::from_str(s).map(Self)
    }
}

/// A user-defined folder used to group meetings.
///
/// Serialized directly to `folders.json` (see
/// `crate::store::folder_store::FsFolderStore`), so field names are
/// `camelCase` on disk — unlike `crate::domain::meeting::Meeting`, which has
/// a separate `camelCase` DTO (`crate::dto::MeetingDto`) for the IPC
/// boundary and stays `snake_case` on disk.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: FolderId,
    pub name: String,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    pub position: u32,
}

impl Folder {
    /// Creates a new folder with a fresh id and the current time.
    pub fn new(name: &str, position: u32) -> Self {
        Self {
            id: FolderId::new(),
            name: name.to_string(),
            created_at: OffsetDateTime::now_utc(),
            position,
        }
    }

    /// Returns a copy of this folder with `name` replaced.
    pub fn with_name(&self, name: &str) -> Folder {
        Folder {
            name: name.to_string(),
            ..self.clone()
        }
    }

    /// Returns a copy of this folder with `position` replaced.
    pub fn with_position(&self, position: u32) -> Folder {
        Folder {
            position,
            ..self.clone()
        }
    }
}
