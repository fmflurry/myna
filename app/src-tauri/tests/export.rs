//! Integration tests for [`export_meeting_blocking`] proving Phase 3a's
//! speaker attribution reaches export output without breaking legacy
//! (pre-speaker) meetings.

use std::fs;

use myna_app::commands::export::{export_meeting_blocking, ExportFormat};
use myna_app::store::fs_store::FsMeetingStore;
use myna_app::store::MeetingStore;
use myna_stt::{Speaker, Transcript, TranscriptSegment};

fn store_at(root: &std::path::Path) -> FsMeetingStore {
    FsMeetingStore::new(root)
}

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
fn a_transcript_whose_segments_are_all_unknown_exports_byte_identically_to_pre_speaker_output() {
    // Arrange: every segment defaults to `Speaker::unknown()` — exactly the
    // shape every meeting recorded before this phase has on disk.
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_at(dir.path());
    let meeting = store.create("Legacy meeting").expect("create");
    let transcript = Transcript {
        segments: vec![
            segment(0.0, 1.5, "Hello there.", Speaker::default()),
            segment(1.5, 3.2, "General kenobi.", Speaker::default()),
        ],
    };
    store
        .save(&meeting.with_transcript(transcript))
        .expect("save");

    // Act
    let md_dest = dir.path().join("legacy.md");
    export_meeting_blocking(&store, meeting.id, ExportFormat::Markdown, &md_dest)
        .expect("export markdown");
    let txt_dest = dir.path().join("legacy.txt");
    export_meeting_blocking(&store, meeting.id, ExportFormat::Text, &txt_dest)
        .expect("export text");

    // Assert: no speaker prefix or header of any kind leaks into a legacy
    // export — the exact pre-speaker-field bullet/plain-text shape.
    let markdown = fs::read_to_string(&md_dest).expect("read markdown");
    assert_eq!(
        markdown,
        "# Legacy meeting\n\n## Transcript\n\n\
         - [0.0s - 1.5s] Hello there.\n\
         - [1.5s - 3.2s] General kenobi.\n\n"
    );
    assert!(!markdown.contains("Me"));
    assert!(!markdown.contains("Others"));
    assert!(!markdown.contains(':'));

    let text = fs::read_to_string(&txt_dest).expect("read text");
    assert_eq!(
        text,
        "Legacy meeting\n\nTranscript:\nHello there.\nGeneral kenobi.\n\n"
    );
}

#[test]
fn a_mixed_speaker_transcript_exports_with_prefixes_and_merges_consecutive_same_speaker() {
    // Arrange: two consecutive `me` segments (must merge under one header),
    // then an unidentified `others`, then a specific `others:2`.
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_at(dir.path());
    let meeting = store.create("Mixed meeting").expect("create");
    let transcript = Transcript {
        segments: vec![
            segment(0.0, 1.0, "Let's start.", Speaker::me()),
            segment(1.0, 2.0, "Agenda first.", Speaker::me()),
            segment(2.0, 3.0, "Sounds good.", Speaker::others()),
            segment(3.0, 4.0, "I agree too.", Speaker::others_id("2")),
        ],
    };
    store
        .save(&meeting.with_transcript(transcript))
        .expect("save");

    // Act
    let md_dest = dir.path().join("mixed.md");
    export_meeting_blocking(&store, meeting.id, ExportFormat::Markdown, &md_dest)
        .expect("export markdown");
    let txt_dest = dir.path().join("mixed.txt");
    export_meeting_blocking(&store, meeting.id, ExportFormat::Text, &txt_dest)
        .expect("export text");

    // Assert: one header per speaker run, not per segment.
    let markdown = fs::read_to_string(&md_dest).expect("read markdown");
    assert_eq!(
        markdown,
        "# Mixed meeting\n\n## Transcript\n\n\
         **Me:**\n\n\
         - [0.0s - 1.0s] Let's start.\n\
         - [1.0s - 2.0s] Agenda first.\n\
         **Others:**\n\n\
         - [2.0s - 3.0s] Sounds good.\n\
         **Others 2:**\n\n\
         - [3.0s - 4.0s] I agree too.\n\n"
    );
    assert_eq!(markdown.matches("**Me:**").count(), 1);

    let text = fs::read_to_string(&txt_dest).expect("read text");
    assert_eq!(
        text,
        "Mixed meeting\n\nTranscript:\n\
         Me:\n\
         Let's start.\n\
         Agenda first.\n\
         Others:\n\
         Sounds good.\n\
         Others 2:\n\
         I agree too.\n\n"
    );
}

#[test]
fn a_named_speaker_renders_its_display_name_in_markdown_and_text_export() {
    // Arrange: "others:1" has a user-assigned display name containing
    // uppercase, an accent, and a hyphen — none of which are legal in a
    // `Speaker` label itself, so it must survive only via `speaker_names`.
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_at(dir.path());
    let meeting = store.create("Named meeting").expect("create");
    let transcript = Transcript {
        segments: vec![segment(
            0.0,
            1.0,
            "I'll own the migration.",
            Speaker::others_id("1"),
        )],
    };
    let mut speaker_names = std::collections::BTreeMap::new();
    speaker_names.insert("others:1".to_string(), "Jean-Éric".to_string());
    store
        .save(
            &meeting
                .with_transcript(transcript)
                .with_speaker_names(speaker_names),
        )
        .expect("save");

    // Act
    let md_dest = dir.path().join("named.md");
    export_meeting_blocking(&store, meeting.id, ExportFormat::Markdown, &md_dest)
        .expect("export markdown");
    let txt_dest = dir.path().join("named.txt");
    export_meeting_blocking(&store, meeting.id, ExportFormat::Text, &txt_dest)
        .expect("export text");

    // Assert
    let markdown = fs::read_to_string(&md_dest).expect("read markdown");
    assert!(markdown.contains("**Jean-Éric:**"));
    assert!(!markdown.contains("Others 1"));

    let text = fs::read_to_string(&txt_dest).expect("read text");
    assert!(text.contains("Jean-Éric:\n"));
    assert!(!text.contains("Others 1"));
}

#[test]
fn two_distinct_labels_sharing_a_display_name_export_as_separate_blocks() {
    // Arrange: "others:1" and "others:2" both happen to be named "Sam" — the
    // grouping must stay keyed by the underlying label, not the display
    // name, so these must not merge into one run.
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_at(dir.path());
    let meeting = store.create("Same name meeting").expect("create");
    let transcript = Transcript {
        segments: vec![
            segment(0.0, 1.0, "First voice.", Speaker::others_id("1")),
            segment(1.0, 2.0, "Second voice.", Speaker::others_id("2")),
        ],
    };
    let mut speaker_names = std::collections::BTreeMap::new();
    speaker_names.insert("others:1".to_string(), "Sam".to_string());
    speaker_names.insert("others:2".to_string(), "Sam".to_string());
    store
        .save(
            &meeting
                .with_transcript(transcript)
                .with_speaker_names(speaker_names),
        )
        .expect("save");

    // Act
    let md_dest = dir.path().join("same-name.md");
    export_meeting_blocking(&store, meeting.id, ExportFormat::Markdown, &md_dest)
        .expect("export markdown");

    // Assert: two separate "Sam:" headers, not one merged block.
    let markdown = fs::read_to_string(&md_dest).expect("read markdown");
    assert_eq!(markdown.matches("**Sam:**").count(), 2);
    assert_eq!(
        markdown,
        "# Same name meeting\n\n## Transcript\n\n\
         **Sam:**\n\n\
         - [0.0s - 1.0s] First voice.\n\
         **Sam:**\n\n\
         - [1.0s - 2.0s] Second voice.\n\n"
    );
}
