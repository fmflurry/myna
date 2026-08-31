use std::time::Duration;

use myna_stt::{Speaker, Transcript, TranscriptSegment};

fn segment(start: f32, end: f32, text: &str) -> TranscriptSegment {
    TranscriptSegment {
        start_sec: start,
        end_sec: end,
        text: text.to_string(),
        speaker: Speaker::default(),
        speaker_pinned: false,
    }
}

#[test]
fn full_text_joins_segments_with_spaces() {
    let transcript = Transcript {
        segments: vec![segment(0.0, 1.0, "hello"), segment(1.0, 2.0, "world")],
    };

    assert_eq!(transcript.full_text(), "hello world");
}

#[test]
fn full_text_is_empty_for_no_segments() {
    let transcript = Transcript { segments: vec![] };

    assert_eq!(transcript.full_text(), "");
}

#[test]
fn duration_matches_last_segment_end() {
    let transcript = Transcript {
        segments: vec![segment(0.0, 1.5, "a"), segment(1.5, 3.25, "b")],
    };

    assert_eq!(transcript.duration(), Duration::from_secs_f32(3.25));
}

#[test]
fn duration_is_zero_for_no_segments() {
    let transcript = Transcript { segments: vec![] };

    assert_eq!(transcript.duration(), Duration::from_secs(0));
}

#[test]
fn with_segment_returns_new_value_and_leaves_original_unchanged() {
    let original = Transcript {
        segments: vec![segment(0.0, 1.0, "hello")],
    };

    let extended = original.with_segment(segment(1.0, 2.0, "world"));

    assert_eq!(original.segments.len(), 1, "original must not be mutated");
    assert_eq!(original.full_text(), "hello");
    assert_eq!(extended.segments.len(), 2);
    assert_eq!(extended.full_text(), "hello world");
}
