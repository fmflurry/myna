//! Integration tests for the "folders" backend feature: the `Folder`
//! domain type, `FsFolderStore` persistence, and the pure blocking command
//! helpers in `commands::folders`. Exercised against real temporary
//! directories, mirroring the idiom in `tests/store.rs` and
//! `tests/session.rs`.

use std::fs;

use myna_app::commands::folders::{
    create_folder_blocking, delete_folder_blocking, normalize_folder_name, rename_folder_blocking,
    set_meeting_folder_blocking, MAX_FOLDER_NAME_LENGTH,
};
use myna_app::domain::{Folder, FolderId, MeetingId};
use myna_app::error::AppError;
use myna_app::store::folder_store::FsFolderStore;
use myna_app::store::fs_store::FsMeetingStore;
use myna_app::store::{FolderStore, MeetingStore};
use time::{Duration, OffsetDateTime};

fn folder_store_at(root: &std::path::Path) -> FsFolderStore {
    FsFolderStore::new(root.to_path_buf())
}

fn meeting_store_at(root: &std::path::Path) -> FsMeetingStore {
    FsMeetingStore::new(root)
}

// ---- Folder domain ---------------------------------------------------

#[test]
fn folder_new_assigns_fresh_id_and_position() {
    // Act
    let a = Folder::new("Design reviews", 0);
    let b = Folder::new("Design reviews", 1);

    // Assert
    assert_eq!(a.name, "Design reviews");
    assert_eq!(a.position, 0);
    assert_eq!(b.position, 1);
    assert_ne!(a.id.to_string(), b.id.to_string());
}

#[test]
fn with_name_returns_new_folder_and_leaves_original_untouched() {
    // Arrange
    let original = Folder::new("Old name", 0);

    // Act
    let renamed = original.with_name("New name");

    // Assert: immutability — the original is untouched, the copy carries
    // the new name but keeps the same identity.
    assert_eq!(original.name, "Old name");
    assert_eq!(renamed.name, "New name");
    assert_eq!(renamed.id.to_string(), original.id.to_string());
}

// ---- normalize_folder_name --------------------------------------------

#[test]
fn normalize_folder_name_trims_caps_at_100_chars_and_never_splits_multibyte() {
    // Arrange: 101 "é" (a two-byte UTF-8 scalar) surrounded by whitespace —
    // capping by bytes rather than `chars()` would land mid-character.
    let input = format!("  {}  ", "é".repeat(MAX_FOLDER_NAME_LENGTH + 1));

    // Act
    let result = normalize_folder_name(&input);

    // Assert
    let normalized = result.expect("over-length name should still normalize, just capped");
    assert_eq!(normalized.chars().count(), MAX_FOLDER_NAME_LENGTH);
    assert_eq!(normalized, "é".repeat(MAX_FOLDER_NAME_LENGTH));
}

#[test]
fn normalize_folder_name_returns_none_for_whitespace_only() {
    // Arrange
    let input = "   \t\n  ";

    // Act
    let result = normalize_folder_name(input);

    // Assert
    assert_eq!(result, None);
}

// ---- Meeting <-> folder_id compatibility -------------------------------

/// Critical regression test: a `meeting.json` written before the "folders"
/// feature existed has no `folder_id` key anywhere in the JSON. Adding a
/// required (non-`Option` or non-`#[serde(default)]`) field would break
/// every meeting recorded before this feature shipped.
#[test]
fn meeting_json_without_folder_id_field_still_deserializes() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let store = meeting_store_at(dir.path());
    let id = MeetingId::new();
    let meeting_dir = dir.path().join("meetings").join(id.to_string());
    fs::create_dir_all(&meeting_dir).expect("create meeting dir");
    let legacy_json = format!(
        r#"{{
            "id": "{id}",
            "title": "Pre-folders meeting",
            "created_at": "2024-01-01T00:00:00Z",
            "duration_sec": 0.0,
            "audio_path": null,
            "transcript": null,
            "summaries": []
        }}"#
    );
    fs::write(meeting_dir.join("meeting.json"), legacy_json).expect("write legacy meeting.json");

    // Act
    let fetched = store
        .get(id)
        .expect("get should succeed on a legacy meeting.json missing folder_id");

    // Assert
    assert_eq!(fetched.folder_id, None);
}

/// A meeting filed under a folder id that no longer exists is legal: folder
/// assignment never validates referential integrity against the folder
/// store, so a deleted folder must never brick loading its former meetings.
#[test]
fn meeting_with_dangling_folder_id_still_loads() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let meetings = meeting_store_at(dir.path());
    let vanished_folder_id = FolderId::new();
    let created = meetings
        .create("Filed under a deleted folder")
        .expect("create");
    let filed = created.with_folder(Some(vanished_folder_id));
    meetings.save(&filed).expect("save");

    // Act
    let fetched = meetings
        .get(filed.id)
        .expect("get should succeed despite the dangling folder id");

    // Assert
    assert_eq!(fetched.folder_id, Some(vanished_folder_id));
}

// ---- FsFolderStore persistence -----------------------------------------

#[test]
fn list_returns_empty_when_folders_json_absent() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let store = folder_store_at(dir.path());

    // Act
    let listed = store.list().expect("list");

    // Assert
    assert!(listed.is_empty());
}

#[test]
fn create_then_list_round_trips_and_leaves_no_tmp_file() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let store = folder_store_at(dir.path());

    // Act
    let created = store.create("Design reviews").expect("create");
    let listed = store.list().expect("list");

    // Assert
    assert_eq!(listed, vec![created]);
    assert!(dir.path().join("folders.json").exists());
    assert!(!dir.path().join("folders.json.tmp").exists());
}

#[test]
fn list_is_sorted_by_position_then_created_at() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let store = folder_store_at(dir.path());
    let now = OffsetDateTime::now_utc();

    let position_1_older = Folder {
        created_at: now - Duration::seconds(20),
        ..Folder::new("Position 1, older", 1)
    };
    let position_1_newer = Folder {
        created_at: now,
        ..Folder::new("Position 1, newer", 1)
    };
    let position_0 = Folder {
        created_at: now - Duration::seconds(5),
        ..Folder::new("Position 0", 0)
    };

    for folder in [&position_1_older, &position_1_newer, &position_0] {
        store.save(folder).expect("save");
    }

    // Act
    let listed = store.list().expect("list");

    // Assert: position 0 sorts first; within position 1, older created_at
    // sorts before newer.
    let names: Vec<&str> = listed.iter().map(|folder| folder.name.as_str()).collect();
    assert_eq!(
        names,
        vec!["Position 0", "Position 1, older", "Position 1, newer"]
    );
}

#[test]
fn corrupt_folders_json_is_quarantined_and_list_returns_empty() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let store = folder_store_at(dir.path());
    fs::write(dir.path().join("folders.json"), "{ this is not json").expect("write corrupt file");

    // Act
    let listed = store
        .list()
        .expect("list should not error on a corrupt folders.json");

    // Assert: the corrupt file is quarantined, not left in place.
    assert!(listed.is_empty());
    assert!(!dir.path().join("folders.json").exists());
    let quarantined = fs::read_dir(dir.path())
        .expect("read temp dir")
        .filter_map(|entry| entry.ok())
        .any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("folders.json.corrupt-")
        });
    assert!(
        quarantined,
        "expected a quarantined folders.json.corrupt-<epoch> file"
    );
}

#[test]
fn unknown_version_is_rejected_with_store_error() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let store = folder_store_at(dir.path());
    let future_schema = r#"{ "version": 2, "folders": [] }"#;
    fs::write(dir.path().join("folders.json"), future_schema).expect("write future-versioned file");

    // Act
    let result = store.list();

    // Assert
    assert!(matches!(result, Err(AppError::Store(_))));
}

#[test]
fn create_folder_rejects_the_two_hundred_and_first_folder() {
    // Arrange
    const MAX_FOLDERS: usize = 200;
    let dir = tempfile::tempdir().expect("tempdir");
    let store = folder_store_at(dir.path());
    for i in 0..MAX_FOLDERS {
        store
            .create(&format!("Folder {i}"))
            .expect("create up to the cap");
    }

    // Act
    let result = store.create("One folder too many");

    // Assert
    assert!(matches!(result, Err(AppError::Store(_))));
    assert_eq!(store.list().expect("list").len(), MAX_FOLDERS);
}

// ---- commands::folders blocking helpers --------------------------------

#[test]
fn create_folder_rejects_blank_name() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let folders = folder_store_at(dir.path());

    // Act
    let result = create_folder_blocking(&folders, "   ");

    // Assert
    assert!(matches!(result, Err(AppError::Store(_))));
    assert!(folders.list().expect("list").is_empty());
}

#[test]
fn rename_folder_treats_blank_as_no_change() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let folders = folder_store_at(dir.path());
    let created = folders.create("Original name").expect("create");

    // Act
    let result = rename_folder_blocking(&folders, created.id, "   ")
        .expect("rename_folder_blocking with a blank name is a no-op, not an error");

    // Assert
    assert_eq!(result.name, "Original name");
    let refetched = folders
        .list()
        .expect("list")
        .into_iter()
        .find(|folder| folder.id.to_string() == created.id.to_string())
        .expect("folder still present");
    assert_eq!(refetched.name, "Original name");
}

#[test]
fn delete_folder_reassigns_contained_meetings_to_none_and_keeps_them() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let folders = folder_store_at(dir.path());
    let meetings = meeting_store_at(dir.path());
    let folder = folders.create("Archived projects").expect("create folder");
    let contained = meetings.create("In the folder").expect("create meeting");
    let contained = contained.with_folder(Some(folder.id));
    meetings.save(&contained).expect("save meeting in folder");
    let outside = meetings
        .create("Not in the folder")
        .expect("create outside meeting");

    // Act
    delete_folder_blocking(&folders, &meetings, folder.id, None).expect("delete_folder_blocking");

    // Assert: the folder record is gone.
    assert!(folders.list().expect("list folders").is_empty());

    // Assert: the meeting that was filed under it still exists but is now
    // unassigned; the untouched meeting is unaffected.
    let refetched_contained = meetings.get(contained.id).expect("get contained meeting");
    assert_eq!(refetched_contained.folder_id, None);
    let refetched_outside = meetings.get(outside.id).expect("get outside meeting");
    assert_eq!(refetched_outside.folder_id, None);
}

#[test]
fn set_meeting_folder_is_idempotent_and_skips_the_write() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let meetings = meeting_store_at(dir.path());
    let folder_id = FolderId::new();
    let created = meetings.create("Already filed").expect("create");
    let filed = created.with_folder(Some(folder_id));
    meetings.save(&filed).expect("save");
    let meeting_json_path = dir
        .path()
        .join("meetings")
        .join(filed.id.to_string())
        .join("meeting.json");
    let mtime_before = fs::metadata(&meeting_json_path)
        .expect("metadata before")
        .modified()
        .expect("mtime before");

    // Act: request the same folder id it is already filed under.
    let result = set_meeting_folder_blocking(&meetings, filed.id, Some(folder_id), None)
        .expect("set_meeting_folder_blocking");

    // Assert: returns the unchanged meeting and never rewrites the file.
    assert_eq!(result, filed);
    let mtime_after = fs::metadata(&meeting_json_path)
        .expect("metadata after")
        .modified()
        .expect("mtime after");
    assert_eq!(mtime_before, mtime_after);
}

#[test]
fn set_meeting_folder_on_the_recording_meeting_yields_busy() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let meetings = meeting_store_at(dir.path());
    let recording = meetings.create("Currently recording").expect("create");
    let folder_id = FolderId::new();

    // Act: `recording.id` is passed as the currently-recording meeting.
    let result =
        set_meeting_folder_blocking(&meetings, recording.id, Some(folder_id), Some(recording.id));

    // Assert
    assert!(matches!(result, Err(AppError::Busy(_))));
}
