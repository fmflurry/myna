//! Integration tests for [`build_render_context`], proving the summarization
//! prompt assembly receives speaker-attributed transcript text (Phase 3a)
//! rather than the plain, space-joined blob `Transcript::full_text` produces.

use myna_app::commands::summary::build_render_context;
use myna_app::domain::Meeting;
use myna_stt::{Speaker, Transcript, TranscriptSegment};

fn segment(start_sec: f32, end_sec: f32, text: &str, speaker: Speaker) -> TranscriptSegment {
    TranscriptSegment {
        start_sec,
        end_sec,
        text: text.to_string(),
        speaker,
        speaker_pinned: false,
    }
}

#[test]
fn render_context_carries_attributed_text_not_the_space_joined_full_text() {
    // Arrange
    let transcript = Transcript {
        segments: vec![
            segment(0.0, 1.0, "Let's start.", Speaker::me()),
            segment(1.0, 2.0, "Sounds good.", Speaker::others()),
        ],
    };
    let meeting = Meeting::new("Prompt check").with_transcript(transcript.clone());

    // Act
    let render_ctx =
        build_render_context(&meeting, "English", None).expect("meeting has a transcript");

    // Assert: the prompt gets speaker-attributed lines...
    assert_eq!(render_ctx.transcript, transcript.attributed_text());
    assert_eq!(
        render_ctx.transcript,
        "Me: Let's start.\nOthers: Sounds good."
    );
    // ...and specifically not the old space-joined blob.
    assert_ne!(render_ctx.transcript, transcript.full_text());
}

#[test]
fn render_context_uses_the_meetings_assigned_speaker_name_when_present() {
    // Arrange: "others:1" has a user-assigned display name — the prompt
    // must say "Jean:", not "Others 1:", so a downstream LLM can attribute
    // an action item to a real name.
    let transcript = Transcript {
        segments: vec![segment(
            0.0,
            1.0,
            "I'll own the migration.",
            Speaker::others_id("1"),
        )],
    };
    let mut speaker_names = std::collections::BTreeMap::new();
    speaker_names.insert("others:1".to_string(), "Jean".to_string());
    let meeting = Meeting::new("Named prompt check")
        .with_transcript(transcript)
        .with_speaker_names(speaker_names);

    // Act
    let render_ctx =
        build_render_context(&meeting, "English", None).expect("meeting has a transcript");

    // Assert
    assert_eq!(render_ctx.transcript, "Jean: I'll own the migration.");
    assert!(!render_ctx.transcript.contains("Others 1"));
}

#[test]
fn build_render_context_fails_when_the_meeting_has_no_transcript_yet() {
    // Arrange
    let meeting = Meeting::new("No transcript yet");

    // Act
    let result = build_render_context(&meeting, "English", None);

    // Assert
    assert!(result.is_err());
}

// ---------------------------------------------------------------------------
// edit_summary_from — the store-facing function behind the `edit_summary`
// Tauri command.
// ---------------------------------------------------------------------------

use myna_app::commands::summary::edit_summary_from;
use myna_app::error::AppError;
use myna_app::store::fs_store::FsMeetingStore;
use myna_app::store::MeetingStore;

fn store_at(root: &std::path::Path) -> FsMeetingStore {
    FsMeetingStore::new(root)
}

#[test]
fn edit_summary_overwrites_the_markdown_in_place() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_at(dir.path());
    let meeting = store.create("Edit check").expect("create");
    store
        .save_summary(meeting.id, "key-points", "en", "# Key points\n\n- original")
        .expect("save_summary");

    // Act
    let edited = edit_summary_from(
        &store,
        meeting.id,
        "key-points",
        "en",
        "# Key points\n\n- edited",
    )
    .expect("edit_summary_from should succeed");

    // Assert: the DTO carries the new markdown...
    assert_eq!(edited.markdown, "# Key points\n\n- edited");
    assert_eq!(edited.template, "key-points");
    assert_eq!(edited.language, "en");
    // ...and a fresh read sees it too (persisted, not just echoed).
    let reread = store
        .read_summary(meeting.id, "key-points", "en")
        .expect("read_summary after edit");
    assert_eq!(reread.markdown, "# Key points\n\n- edited");
}

#[test]
fn edit_summary_preserves_the_original_created_at() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_at(dir.path());
    let meeting = store.create("Timestamp check").expect("create");
    store
        .save_summary(meeting.id, "key-points", "en", "original")
        .expect("save_summary");
    let before = store
        .read_summary(meeting.id, "key-points", "en")
        .expect("read_summary before edit")
        .created_at;

    // Act
    let edited = edit_summary_from(&store, meeting.id, "key-points", "en", "edited")
        .expect("edit_summary_from should succeed");

    // Assert: the edit must not re-stamp the summary's creation time.
    let expected = before
        .format(&time::format_description::well_known::Rfc3339)
        .expect("format created_at");
    assert_eq!(edited.created_at, expected);
}

#[test]
fn edit_summary_trims_surrounding_whitespace() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_at(dir.path());
    let meeting = store.create("Trim check").expect("create");
    store
        .save_summary(meeting.id, "key-points", "en", "original")
        .expect("save_summary");

    // Act
    let edited = edit_summary_from(&store, meeting.id, "key-points", "en", "  edited  \n")
        .expect("edit_summary_from should succeed");

    // Assert
    assert_eq!(edited.markdown, "edited");
}

#[test]
fn edit_summary_rejects_whitespace_only_markdown() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_at(dir.path());
    let meeting = store.create("Blank check").expect("create");
    store
        .save_summary(meeting.id, "key-points", "en", "original")
        .expect("save_summary");

    // Act
    let result = edit_summary_from(&store, meeting.id, "key-points", "en", "   \n\t  ");

    // Assert: rejected, and the persisted markdown is untouched.
    assert!(result.is_err());
    let reread = store
        .read_summary(meeting.id, "key-points", "en")
        .expect("read_summary after rejected edit");
    assert_eq!(reread.markdown, "original");
}

#[test]
fn edit_summary_is_a_no_op_when_the_markdown_is_unchanged() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_at(dir.path());
    let meeting = store.create("Idempotent check").expect("create");
    let path = store
        .save_summary(meeting.id, "key-points", "en", "unchanged")
        .expect("save_summary");
    let before = std::fs::metadata(&path)
        .expect("metadata before")
        .modified()
        .expect("mtime before");

    // Give the filesystem a moment so a spurious rewrite would produce a
    // visibly different mtime.
    std::thread::sleep(std::time::Duration::from_millis(50));

    // Act: same markdown modulo surrounding whitespace.
    let result = edit_summary_from(&store, meeting.id, "key-points", "en", "unchanged  \n")
        .expect("no-change edit should succeed");

    // Assert: same markdown returned, file not rewritten.
    assert_eq!(result.markdown, "unchanged");
    let after = std::fs::metadata(&path)
        .expect("metadata after")
        .modified()
        .expect("mtime after");
    assert_eq!(
        after, before,
        "an unchanged edit must not rewrite the summary file"
    );
}

#[test]
fn edit_summary_yields_not_found_when_no_summary_exists() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_at(dir.path());
    let meeting = store.create("Missing summary check").expect("create");

    // Act
    let result = edit_summary_from(&store, meeting.id, "key-points", "en", "edited");

    // Assert
    assert!(matches!(result, Err(AppError::NotFound(_))));
}

#[test]
fn edit_summary_yields_not_found_for_an_unknown_meeting() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_at(dir.path());
    let unknown_id = myna_app::domain::MeetingId::new();

    // Act
    let result = edit_summary_from(&store, unknown_id, "key-points", "en", "edited");

    // Assert
    assert!(matches!(result, Err(AppError::NotFound(_))));
}
