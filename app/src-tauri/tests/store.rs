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

/// Required test (c): discarding/deleting a recording must remove all
/// THREE audio files — the device-native-rate playback copy and both
/// per-track STT WAVs — never leaking a 690 MB/h orphan. `delete` removes
/// the whole meeting directory, so this also guards against a future
/// change that moves any of these three files outside it.
#[test]
fn delete_removes_all_three_audio_files() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_at(dir.path());
    let meeting = store.create("Has three audio files").expect("create");

    let playback_path = store.audio_path(meeting.id);
    let mic_path = store.mic_track_path(meeting.id);
    let system_path = store.system_track_path(meeting.id);
    fs::write(&playback_path, b"stub playback wav").expect("write playback stub");
    fs::write(&mic_path, b"stub mic wav").expect("write mic stub");
    fs::write(&system_path, b"stub system wav").expect("write system stub");
    assert!(playback_path.exists());
    assert!(mic_path.exists());
    assert!(system_path.exists());

    // Act
    store.delete(meeting.id).expect("delete");

    // Assert
    assert!(!playback_path.exists(), "playback wav must be removed");
    assert!(!mic_path.exists(), "mic track wav must be removed");
    assert!(!system_path.exists(), "system track wav must be removed");
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
            speaker: myna_stt::Speaker::default(),
            speaker_pinned: false,
        })
        .with_segment(TranscriptSegment {
            start_sec: 1.5,
            end_sec: 3.0,
            text: "let's begin".to_string(),
            speaker: myna_stt::Speaker::default(),
            speaker_pinned: false,
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
        speaker: myna_stt::Speaker::default(),
        speaker_pinned: false,
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
        stale: false,
    };
    let fr_ref = SummaryRef {
        template: "key-points".to_string(),
        language: "fr".to_string(),
        created_at: OffsetDateTime::now_utc(),
        path: PathBuf::from("summaries/key-points.fr.md"),
        stale: false,
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
fn meeting_json_predating_stale_and_dropped_audio_chunks_still_deserializes_with_defaults() {
    // Arrange: a `meeting.json` written before Phase 6 (`stale` on
    // `SummaryRef`) and Phase 7 (`dropped_audio_chunks` on `Meeting`)
    // existed — neither field is present anywhere in the JSON.
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_at(dir.path());
    let id = MeetingId::new();
    let meeting_dir = dir.path().join("meetings").join(id.to_string());
    fs::create_dir_all(&meeting_dir).expect("create meeting dir");
    let legacy_json = format!(
        r#"{{
            "id": "{id}",
            "title": "Pre-stale-and-drop-count meeting",
            "created_at": "2024-01-01T00:00:00Z",
            "duration_sec": 0.0,
            "audio_path": null,
            "transcript": null,
            "summaries": [
                {{
                    "template": "key-points",
                    "created_at": "2024-01-01T00:00:00Z",
                    "path": "summaries/key-points.md",
                    "language": "en"
                }}
            ]
        }}"#
    );
    fs::write(meeting_dir.join("meeting.json"), legacy_json).expect("write legacy meeting.json");

    // Act
    let fetched = store.get(id).expect("get should succeed on legacy schema");

    // Assert
    assert_eq!(fetched.dropped_audio_chunks, 0);
    assert_eq!(fetched.summaries.len(), 1);
    assert!(!fetched.summaries[0].stale);
}

#[test]
fn save_and_get_round_trip_dropped_audio_chunks_and_reset_to_zero() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_at(dir.path());
    let created = store.create("Recording with drops").expect("create");

    // Act: persist a non-zero drop count, as `stop_recording_blocking`
    // does when `RecordingSession::stop` reports dropped chunks.
    let with_drops = created.with_dropped_audio_chunks(7);
    store.save(&with_drops).expect("save with drops");
    let fetched_with_drops = store.get(created.id).expect("get after saving drops");

    // Assert
    assert_eq!(fetched_with_drops.dropped_audio_chunks, 7);

    // Act: a successful re-transcribe resets the count to 0.
    let reset = fetched_with_drops.with_dropped_audio_chunks(0);
    store.save(&reset).expect("save reset");
    let fetched_reset = store.get(created.id).expect("get after reset");

    // Assert
    assert_eq!(fetched_reset.dropped_audio_chunks, 0);
}

#[test]
fn with_all_summaries_stale_flips_every_ref_and_leaves_the_original_untouched() {
    // Arrange
    let original = Meeting::new("Re-transcribed meeting");
    let en_ref = SummaryRef {
        template: "key-points".to_string(),
        language: "en".to_string(),
        created_at: OffsetDateTime::now_utc(),
        path: PathBuf::from("summaries/key-points.en.md"),
        stale: false,
    };
    let fr_ref = SummaryRef {
        template: "action-items".to_string(),
        language: "fr".to_string(),
        created_at: OffsetDateTime::now_utc(),
        path: PathBuf::from("summaries/action-items.fr.md"),
        stale: false,
    };
    let with_summaries = original.with_summary(en_ref).with_summary(fr_ref);

    // Act
    let staled = with_summaries.with_all_summaries_stale();

    // Assert: immutability — the input meeting's summaries are untouched.
    assert!(with_summaries.summaries.iter().all(|s| !s.stale));

    // Assert: every summary on the returned copy is now stale, and no
    // summary markdown was removed in the process.
    assert_eq!(staled.summaries.len(), 2);
    assert!(staled.summaries.iter().all(|s| s.stale));
}

#[test]
fn generating_a_fresh_summary_clears_stale_on_the_replaced_ref() {
    // Arrange: a meeting with one summary already marked stale by a prior
    // re-transcribe.
    let stale_ref = SummaryRef {
        template: "key-points".to_string(),
        language: "en".to_string(),
        created_at: OffsetDateTime::now_utc(),
        path: PathBuf::from("summaries/key-points.en.md"),
        stale: true,
    };
    let meeting = Meeting::new("Needs a fresh summary").with_summary(stale_ref);

    // Act: regenerating the same (template, language) pair, as
    // `commands::summary::run_summarization` does, saves a fresh,
    // non-stale ref.
    let fresh_ref = SummaryRef {
        template: "key-points".to_string(),
        language: "en".to_string(),
        created_at: OffsetDateTime::now_utc() + Duration::seconds(10),
        path: PathBuf::from("summaries/key-points.en.md"),
        stale: false,
    };
    let updated = meeting.with_summary(fresh_ref);

    // Assert: exactly one summary for this pair, and it is no longer stale.
    assert_eq!(updated.summaries.len(), 1);
    assert!(!updated.summaries[0].stale);
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

/// Regression test: a `meeting.json` written before per-segment speaker
/// attribution existed has transcript segments with only `start_sec` /
/// `end_sec` / `text` — no `speaker` key anywhere. `TranscriptSegment.speaker`
/// must be `#[serde(default)]`, or `fs_store::read_meeting_file` silently
/// drops this meeting from both `get` and `list` (see
/// `list_skips_a_corrupt_meeting_json_without_erroring` for the drop
/// behavior this would otherwise trigger unintentionally).
#[test]
fn meeting_json_with_a_legacy_transcript_missing_speaker_keys_still_loads() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_at(dir.path());
    let id = MeetingId::new();
    let meeting_dir = dir.path().join("meetings").join(id.to_string());
    fs::create_dir_all(&meeting_dir).expect("create meeting dir");
    let legacy_json = format!(
        r#"{{
            "id": "{id}",
            "title": "Pre-speaker-attribution meeting",
            "created_at": "2024-01-01T00:00:00Z",
            "duration_sec": 3.0,
            "audio_path": null,
            "transcript": {{
                "segments": [
                    {{"start_sec": 0.0, "end_sec": 1.5, "text": "hello team"}},
                    {{"start_sec": 1.5, "end_sec": 3.0, "text": "let's begin"}}
                ]
            }},
            "summaries": []
        }}"#
    );
    fs::write(meeting_dir.join("meeting.json"), legacy_json).expect("write legacy meeting.json");

    // Act
    let fetched = store
        .get(id)
        .expect("get should succeed on a legacy meeting.json missing speaker keys");
    let listed = store
        .list()
        .expect("list should not drop the legacy meeting");

    // Assert: `get` returns it with segments defaulted to an unknown speaker.
    let transcript = fetched.transcript.expect("transcript present");
    assert_eq!(transcript.segments.len(), 2);
    assert_eq!(transcript.segments[0].speaker, myna_stt::Speaker::unknown());
    assert_eq!(transcript.segments[1].speaker, myna_stt::Speaker::unknown());

    // Assert: `list` does not silently drop it either.
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, id);
}

// ---- Manual meeting ordering (`position`) ------------------------------

/// Critical regression test: a `meeting.json` written before manual
/// ordering existed has no `position` key anywhere in the JSON. Adding a
/// required (non-`Option` or non-`#[serde(default)]`) field would break
/// every meeting recorded before this feature shipped — mirrors
/// `meeting_json_without_folder_id_field_still_deserializes` in
/// `tests/folders.rs`.
#[test]
fn meeting_json_without_position_field_still_deserializes() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_at(dir.path());
    let id = MeetingId::new();
    let meeting_dir = dir.path().join("meetings").join(id.to_string());
    fs::create_dir_all(&meeting_dir).expect("create meeting dir");
    let legacy_json = format!(
        r#"{{
            "id": "{id}",
            "title": "Pre-placement meeting",
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
        .expect("get should succeed on a legacy meeting.json missing position");

    // Assert
    assert_eq!(fetched.position, None);
}

/// Day-zero parity guard: when no meeting has ever been manually
/// reordered, `list()`'s new position-aware sort must produce *exactly*
/// the same sequence as the old `created_at` DESC sort it replaces.
#[test]
fn list_with_no_positions_matches_created_at_desc_exactly() {
    // Arrange: five unplaced meetings with distinct `created_at` values —
    // the state of every existing installation before this feature ships.
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_at(dir.path());
    let now = OffsetDateTime::now_utc();
    let meetings: Vec<Meeting> = (0..5)
        .map(|i| Meeting {
            created_at: now - Duration::seconds(i * 10),
            ..Meeting::new(format!("Meeting {i}"))
        })
        .collect();
    for meeting in &meetings {
        store.save(meeting).expect("save");
    }

    // Act
    let listed = store.list().expect("list");

    // Assert: order is exactly `created_at` DESC, unchanged from before
    // this feature existed.
    let ids: Vec<MeetingId> = listed.iter().map(|meeting| meeting.id).collect();
    let expected_ids: Vec<MeetingId> = meetings.iter().map(|meeting| meeting.id).collect();
    assert_eq!(ids, expected_ids);
}

#[test]
fn list_interleaves_a_placed_meeting_among_unplaced_ones() {
    // Arrange: two unplaced meetings, older and newer, plus a third
    // meeting given an explicit `position` that lands strictly between
    // their effective positions (negated `created_at` seconds).
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_at(dir.path());
    let now = OffsetDateTime::now_utc();

    let older = Meeting {
        created_at: now - Duration::seconds(20),
        ..Meeting::new("Older, unplaced")
    };
    let newer = Meeting {
        created_at: now,
        ..Meeting::new("Newer, unplaced")
    };
    let older_effective = -(older.created_at.unix_timestamp() as f64);
    let newer_effective = -(newer.created_at.unix_timestamp() as f64);
    let midpoint = newer_effective + (older_effective - newer_effective) / 2.0;
    let placed = Meeting::new("Explicitly placed between them").with_position(Some(midpoint));

    for meeting in [&older, &newer, &placed] {
        store.save(meeting).expect("save");
    }

    // Act
    let listed = store.list().expect("list");

    // Assert: ascending effective position puts the newer unplaced meeting
    // first, the explicitly placed one in the middle, and the older
    // unplaced meeting last.
    let titles: Vec<&str> = listed
        .iter()
        .map(|meeting| meeting.title.as_str())
        .collect();
    assert_eq!(
        titles,
        vec![
            "Newer, unplaced",
            "Explicitly placed between them",
            "Older, unplaced",
        ]
    );
}

#[test]
fn list_order_is_deterministic_for_equal_positions() {
    // Arrange: two meetings share the same explicit position but have
    // distinct `created_at` — the second tie-break level.
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_at(dir.path());
    let now = OffsetDateTime::now_utc();
    let shared_position = 42.0;

    let older_same_position = Meeting {
        created_at: now - Duration::seconds(10),
        ..Meeting::new("Older, same position").with_position(Some(shared_position))
    };
    let newer_same_position = Meeting {
        created_at: now,
        ..Meeting::new("Newer, same position").with_position(Some(shared_position))
    };

    // A third pair shares both position AND created_at exactly — the
    // final tie-break level is `id`.
    let same_instant = now - Duration::seconds(30);
    let tied_a = Meeting {
        created_at: same_instant,
        ..Meeting::new("Tied A").with_position(Some(7.0))
    };
    let tied_b = Meeting {
        created_at: same_instant,
        ..Meeting::new("Tied B").with_position(Some(7.0))
    };

    for meeting in [&older_same_position, &newer_same_position, &tied_a, &tied_b] {
        store.save(meeting).expect("save");
    }

    // Act
    let listed_once = store.list().expect("list once");
    let listed_again = store.list().expect("list again");

    // Assert: `created_at` DESC breaks the tie between the first pair.
    let titles: Vec<&str> = listed_once
        .iter()
        .map(|meeting| meeting.title.as_str())
        .collect();
    let newer_idx = titles
        .iter()
        .position(|title| *title == "Newer, same position")
        .expect("newer meeting present");
    let older_idx = titles
        .iter()
        .position(|title| *title == "Older, same position")
        .expect("older meeting present");
    assert!(newer_idx < older_idx);

    // Assert: the fully-tied pair sorts in a stable, id-derived order.
    // The expected order is computed from the pair's own UUID string
    // form, which orders identically to the underlying bytes for
    // canonical lowercase UUIDs, so this holds regardless of whether the
    // implementation compares `MeetingId` directly or via its string
    // form.
    let mut expected_tied_order = [("Tied A", tied_a.id), ("Tied B", tied_b.id)];
    expected_tied_order.sort_by_key(|(_, id)| id.to_string());
    let expected_titles: Vec<&str> = expected_tied_order
        .iter()
        .map(|(title, _)| *title)
        .collect();
    let tied_titles_in_listed_order: Vec<&str> = listed_once
        .iter()
        .filter(|meeting| meeting.title == "Tied A" || meeting.title == "Tied B")
        .map(|meeting| meeting.title.as_str())
        .collect();
    assert_eq!(tied_titles_in_listed_order, expected_titles);

    // Assert: determinism — repeated `list()` calls produce the same
    // order.
    let ids_once: Vec<MeetingId> = listed_once.iter().map(|meeting| meeting.id).collect();
    let ids_again: Vec<MeetingId> = listed_again.iter().map(|meeting| meeting.id).collect();
    assert_eq!(ids_once, ids_again);
}
