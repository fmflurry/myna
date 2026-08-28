//! Integration tests for [`get_summary_from`], the store-facing function
//! behind the `get_summary` Tauri command.
//!
//! These exist to prove BUG 1 is fixed: summaries were persisted to disk
//! (`FsMeetingStore::save_summary`/`read_summary` already round-tripped),
//! but no command exposed `read_summary` to the UI, so after a restart the
//! in-memory summary text was gone and the markdown was unreachable even
//! though the file was still on disk.

use myna_app::commands::summary::get_summary_from;
use myna_app::domain::MeetingId;
use myna_app::error::AppError;
use myna_app::store::fs_store::FsMeetingStore;
use myna_app::store::MeetingStore;

fn store_at(root: &std::path::Path) -> FsMeetingStore {
    FsMeetingStore::new(root)
}

#[test]
fn round_trips_a_saved_summary_across_a_fresh_store_instance_simulating_a_restart() {
    // Arrange: save through one store instance.
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_at(dir.path());
    let meeting = store.create("Restart check").expect("create");
    store
        .save_summary(meeting.id, "key-points", "en", "# Key points")
        .expect("save_summary");

    // Act: a brand new `FsMeetingStore` rooted at the same directory
    // simulates the app restarting and losing all in-memory state.
    let restarted_store = store_at(dir.path());
    let result = get_summary_from(&restarted_store, meeting.id, "key-points", "en")
        .expect("get_summary_from should succeed after a simulated restart");

    // Assert
    let summary = result.expect("summary should survive the simulated restart");
    assert_eq!(summary.markdown, "# Key points");
    assert_eq!(summary.template, "key-points");
    assert_eq!(summary.language, "en");
}

#[test]
fn returns_none_when_the_template_language_pair_has_no_saved_summary() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_at(dir.path());
    let meeting = store.create("No summary yet").expect("create");

    // Act
    let result = get_summary_from(&store, meeting.id, "key-points", "en")
        .expect("get_summary_from should succeed for a known meeting");

    // Assert: a missing (template, language) pair is a normal state, not
    // an error.
    assert_eq!(result, None);
}

#[test]
fn unknown_meeting_id_yields_not_found() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_at(dir.path());
    let unknown_id = MeetingId::new();

    // Act
    let result = get_summary_from(&store, unknown_id, "key-points", "en");

    // Assert
    assert!(matches!(result, Err(AppError::NotFound(_))));
}

#[test]
fn a_path_traversal_attempt_in_the_template_is_sanitized_not_escaped() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_at(dir.path());
    let meeting = store.create("Traversal check").expect("create");
    store
        .save_summary(meeting.id, "key-points", "en", "# Key points")
        .expect("save_summary");

    // Act: a malicious template value that would climb out of the meeting
    // directory entirely if it were used unsanitized to build a path.
    let result = get_summary_from(&store, meeting.id, "../../etc/passwd", "en")
        .expect("get_summary_from should not error on a sanitized, missing pair");

    // Assert: the traversal segment is sanitized to something that matches
    // no saved summary, so it reads back as "no summary" rather than
    // escaping the sandbox or erroring in a way that leaks path info.
    assert_eq!(result, None);
}

#[test]
fn french_and_english_summaries_for_the_same_template_are_read_back_independently() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_at(dir.path());
    let meeting = store.create("Bilingual check").expect("create");
    store
        .save_summary(meeting.id, "key-points", "en", "English body")
        .expect("save_summary en");
    store
        .save_summary(meeting.id, "key-points", "fr", "Corps français")
        .expect("save_summary fr");

    // Act
    let en = get_summary_from(&store, meeting.id, "key-points", "en")
        .expect("get_summary_from en")
        .expect("en summary should exist");
    let fr = get_summary_from(&store, meeting.id, "key-points", "fr")
        .expect("get_summary_from fr")
        .expect("fr summary should exist");

    // Assert
    assert_eq!(en.markdown, "English body");
    assert_eq!(fr.markdown, "Corps français");
    assert_ne!(en.markdown, fr.markdown);
}
