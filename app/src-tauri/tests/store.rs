//! Integration tests for [`FsMeetingStore`], exercised against real
//! temporary directories so atomicity and layout guarantees are verified
//! end-to-end rather than mocked.

use std::fs;
use std::path::PathBuf;

use myna_app::commands::meetings::apply_segment_edit;
use myna_app::domain::{Meeting, MeetingId, SummaryRef};
use myna_app::error::AppError;
use myna_app::store::fs_store::FsMeetingStore;
use myna_app::store::MeetingStore;
use myna_stt::{Transcript, TranscriptSegment};
use time::{Duration, OffsetDateTime};

fn store_at(root: &std::path::Path) -> FsMeetingStore {
    FsMeetingStore::new(root)
}

#[test]
fn create_get_save_and_delete_round_trip_a_meeting() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_at(dir.path());

    // Act: create persists immediately and returns the new meeting.
    let created = store.create("Weekly sync").expect("create");
    let fetched = store.get(created.id).expect("get after create");

    // Assert
    assert_eq!(fetched, created);
    assert_eq!(fetched.title, "Weekly sync");

    // Act: save an updated copy.
    let updated = created.with_title("Weekly sync (updated)");
    store.save(&updated).expect("save");
    let refetched = store.get(created.id).expect("get after save");

    // Assert
    assert_eq!(refetched.title, "Weekly sync (updated)");

    // Act: delete removes it entirely.
    store.delete(created.id).expect("delete");

    // Assert
    let err = store.get(created.id).expect_err("meeting should be gone");
    assert!(matches!(err, AppError::NotFound(_)));
}

#[test]
fn save_is_atomic_and_leaves_no_tmp_file_behind() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_at(dir.path());
    let meeting = Meeting::new("Atomic write check");

    // Act
    store.save(&meeting).expect("save");

    // Assert
    let meeting_dir = dir.path().join("meetings").join(meeting.id.to_string());
    assert!(meeting_dir.join("meeting.json").exists());
    assert!(!meeting_dir.join("meeting.json.tmp").exists());
}

#[test]
fn list_returns_meetings_newest_first() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_at(dir.path());
    let now = OffsetDateTime::now_utc();

    let oldest = Meeting {
        created_at: now - Duration::seconds(20),
        ..Meeting::new("Oldest")
    };
    let middle = Meeting {
        created_at: now - Duration::seconds(10),
        ..Meeting::new("Middle")
    };
    let newest = Meeting {
        created_at: now,
        ..Meeting::new("Newest")
    };

    for meeting in [&oldest, &middle, &newest] {
        store.save(meeting).expect("save");
    }

    // Act
    let listed = store.list().expect("list");

    // Assert
    let titles: Vec<&str> = listed
        .iter()
        .map(|meeting| meeting.title.as_str())
        .collect();
    assert_eq!(titles, vec!["Newest", "Middle", "Oldest"]);
}

#[test]
fn delete_removes_the_entire_meeting_directory() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_at(dir.path());
    let meeting = store.create("To be deleted").expect("create");
    let meeting_dir = dir.path().join("meetings").join(meeting.id.to_string());
    assert!(meeting_dir.exists());

    // Act
    store.delete(meeting.id).expect("delete");

    // Assert
    assert!(!meeting_dir.exists());
}

#[test]
fn get_of_unknown_id_yields_not_found() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_at(dir.path());
    let unknown_id = MeetingId::new();

    // Act
    let result = store.get(unknown_id);

    // Assert
    assert!(matches!(result, Err(AppError::NotFound(_))));
}

#[test]
fn list_skips_a_corrupt_meeting_json_without_erroring() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_at(dir.path());
    let valid = store.create("Valid meeting").expect("create");

    let corrupt_dir = dir.path().join("meetings").join("not-a-real-uuid");
    fs::create_dir_all(&corrupt_dir).expect("create corrupt dir");
    fs::write(corrupt_dir.join("meeting.json"), "{ this is not json").expect("write corrupt file");

    // Act
    let listed = store
        .list()
        .expect("list should not error on corrupt entries");

    // Assert
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, valid.id);
}

#[test]
fn edited_segment_text_and_timestamps_survive_a_save_and_get_json_round_trip() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_at(dir.path());
    let transcript = Transcript::default()
        .with_segment(TranscriptSegment {
            start_sec: 0.0,
            end_sec: 1.5,
            text: "hello team".to_string(),
        })
        .with_segment(TranscriptSegment {
            start_sec: 1.5,
            end_sec: 3.0,
            text: "let's begin".to_string(),
        });
    let created = store.create("Needs an edit").expect("create");
    let with_transcript = created.with_transcript(transcript);
    store.save(&with_transcript).expect("save with transcript");

    // Act: load, edit segment 0, save, reload.
    let loaded = store.get(created.id).expect("get before edit");
    let loaded_transcript = loaded.transcript.clone().expect("transcript present");
    let edited_transcript =
        apply_segment_edit(&loaded_transcript, 0, "hi everyone").expect("apply_segment_edit");
    let updated = loaded.with_transcript(edited_transcript);
    store.save(&updated).expect("save edited transcript");
    let refetched = store.get(created.id).expect("get after edit");

    // Assert
    let refetched_transcript = refetched
        .transcript
        .expect("transcript present after reload");
    assert_eq!(refetched_transcript.segments[0].text, "hi everyone");
    assert_eq!(refetched_transcript.segments[0].start_sec, 0.0);
    assert_eq!(refetched_transcript.segments[0].end_sec, 1.5);
    assert_eq!(refetched_transcript.segments[1].text, "let's begin");
    assert_eq!(refetched_transcript.segments[1].start_sec, 1.5);
    assert_eq!(refetched_transcript.segments[1].end_sec, 3.0);
}

#[test]
fn with_transcript_returns_a_new_meeting_and_leaves_the_original_untouched() {
    // Arrange
    let original = Meeting::new("Needs a transcript");
    let transcript = Transcript::default().with_segment(TranscriptSegment {
        start_sec: 0.0,
        end_sec: 1.5,
        text: "hello team".to_string(),
    });

    // Act
    let updated = original.with_transcript(transcript.clone());

    // Assert
    assert_eq!(original.transcript, None);
    assert_eq!(updated.transcript, Some(transcript));
}

#[test]
fn save_and_read_summary_round_trips_markdown_and_language() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_at(dir.path());
    let meeting = store.create("Round trip check").expect("create");

    // Act
    store
        .save_summary(meeting.id, "key-points", "fr", "# Points clés")
        .expect("save_summary");
    let summary = store
        .read_summary(meeting.id, "key-points", "fr")
        .expect("read_summary");

    // Assert
    assert_eq!(summary.markdown, "# Points clés");
    assert_eq!(summary.language, "fr");
}

#[test]
fn save_summary_in_two_languages_for_the_same_template_coexist_on_disk() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_at(dir.path());
    let meeting = store.create("Bilingual coexistence check").expect("create");

    // Act
    store
        .save_summary(meeting.id, "key-points", "en", "English body")
        .expect("save_summary en");
    store
        .save_summary(meeting.id, "key-points", "fr", "Corps français")
        .expect("save_summary fr");
    let en_summary = store
        .read_summary(meeting.id, "key-points", "en")
        .expect("read_summary en");
    let fr_summary = store
        .read_summary(meeting.id, "key-points", "fr")
        .expect("read_summary fr");

    // Assert
    assert_eq!(en_summary.markdown, "English body");
    assert_eq!(fr_summary.markdown, "Corps français");
    assert_ne!(en_summary.markdown, fr_summary.markdown);
}

#[test]
fn read_summary_of_an_unsaved_language_yields_not_found() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_at(dir.path());
    let meeting = store.create("Missing language check").expect("create");
    store
        .save_summary(meeting.id, "key-points", "en", "English body")
        .expect("save_summary en");

    // Act
    let result = store.read_summary(meeting.id, "key-points", "fr");

    // Assert
    assert!(matches!(result, Err(AppError::NotFound(_))));
}

#[test]
fn with_summary_replaces_only_the_matching_template_and_language_pair() {
    // Arrange
    let original = Meeting::new("Bilingual summaries");
    let en_ref = SummaryRef {
        template: "key-points".to_string(),
        language: "en".to_string(),
        created_at: OffsetDateTime::now_utc(),
        path: PathBuf::from("summaries/key-points.en.md"),
    };
    let fr_ref = SummaryRef {
        template: "key-points".to_string(),
        language: "fr".to_string(),
        created_at: OffsetDateTime::now_utc(),
        path: PathBuf::from("summaries/key-points.fr.md"),
    };
    let en_ref_updated = SummaryRef {
        created_at: OffsetDateTime::now_utc() + Duration::seconds(10),
        path: PathBuf::from("summaries/key-points.en.updated.md"),
        ..en_ref.clone()
    };

    // Act
    let with_en = original.with_summary(en_ref.clone());
    let with_en_and_fr = with_en.with_summary(fr_ref.clone());
    let with_en_updated = with_en_and_fr.with_summary(en_ref_updated.clone());

    // Assert: each step returns a distinct new value (immutability)
    assert_eq!(original.summaries.len(), 0);
    assert_eq!(with_en.summaries, vec![en_ref.clone()]);
    assert_eq!(
        with_en_and_fr.summaries,
        vec![en_ref.clone(), fr_ref.clone()]
    );
    assert_ne!(with_en_and_fr, with_en_updated);

    // Assert: final state has exactly 2 summaries, fr untouched, en replaced (not duplicated)
    assert_eq!(with_en_updated.summaries.len(), 2);
    let fr_final = with_en_updated
        .summaries
        .iter()
        .find(|summary| summary.language == "fr")
        .expect("fr summary should still be present");
    assert_eq!(fr_final, &fr_ref);
    let en_final = with_en_updated
        .summaries
        .iter()
        .find(|summary| summary.language == "en")
        .expect("en summary should still be present");
    assert_eq!(en_final, &en_ref_updated);
}

#[test]
fn defaults_archived_to_false_for_a_legacy_meeting_json_without_the_field() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_at(dir.path());
    let meeting = Meeting::new("Legacy");
    store.save(&meeting).expect("save");

    let meeting_json_path = dir
        .path()
        .join("meetings")
        .join(meeting.id.to_string())
        .join("meeting.json");
    let raw = fs::read_to_string(&meeting_json_path).expect("read meeting.json");
    let mut value: serde_json::Value = serde_json::from_str(&raw).expect("parse meeting.json");
    value
        .as_object_mut()
        .expect("meeting.json is an object")
        .remove("archived");
    fs::write(
        &meeting_json_path,
        serde_json::to_string(&value).expect("serialize meeting.json"),
    )
    .expect("rewrite meeting.json without archived field");

    // Act
    let fetched = store
        .get(meeting.id)
        .expect("get should succeed on a legacy meeting.json missing archived");

    // Assert
    assert!(!fetched.archived);
}

#[test]
fn save_and_get_round_trip_the_archived_flag() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_at(dir.path());
    let created = store.create("Archivable meeting").expect("create");

    // Act: archive it.
    let archived = created.with_archived(true);
    store.save(&archived).expect("save archived");
    let fetched_archived = store.get(created.id).expect("get after archiving");

    // Assert
    assert!(fetched_archived.archived);

    // Act: unarchive it.
    let unarchived = fetched_archived.with_archived(false);
    store.save(&unarchived).expect("save unarchived");
    let fetched_unarchived = store.get(created.id).expect("get after unarchiving");

    // Assert
    assert!(!fetched_unarchived.archived);
}

#[test]
fn meeting_json_predating_the_language_field_still_deserializes_with_default_en() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_at(dir.path());
    let id = MeetingId::new();
    let meeting_dir = dir.path().join("meetings").join(id.to_string());
    fs::create_dir_all(&meeting_dir).expect("create meeting dir");
    let legacy_json = format!(
        r#"{{
            "id": "{id}",
            "title": "Legacy meeting",
            "created_at": "2024-01-01T00:00:00Z",
            "duration_sec": 0.0,
            "audio_path": null,
            "transcript": null,
            "summaries": [
                {{
                    "template": "key-points",
                    "created_at": "2024-01-01T00:00:00Z",
                    "path": "summaries/key-points.md"
                }}
            ]
        }}"#
    );
    fs::write(meeting_dir.join("meeting.json"), legacy_json).expect("write legacy meeting.json");

    // Act
    let fetched = store.get(id).expect("get should succeed on legacy schema");

    // Assert
    assert_eq!(fetched.summaries.len(), 1);
    assert_eq!(fetched.summaries[0].language, "en");
}
