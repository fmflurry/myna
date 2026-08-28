//! Unit tests for [`normalize_title`], the pure validation/normalization
//! step behind the `rename_meeting` command, and [`default_title`]/
//! [`resolve_new_title`], the pure functions behind `start_recording`'s
//! empty-title fallback. Exercised directly — no `AppHandle` or store
//! needed, since they take and return plain strings (and a timestamp).

use myna_app::commands::meetings::{
    apply_segment_edit, default_title, normalize_segment_text, normalize_title, resolve_new_title,
    MAX_SEGMENT_TEXT_LENGTH, MAX_TITLE_LENGTH,
};
use myna_app::error::AppError;
use myna_stt::{Transcript, TranscriptSegment};
use time::{Date, Month, OffsetDateTime, Time};

/// Builds a UTC `OffsetDateTime` from calendar components without needing
/// `time`'s `macros` feature.
fn utc(year: i32, month: Month, day: u8, hour: u8, minute: u8) -> OffsetDateTime {
    let date = Date::from_calendar_date(year, month, day).expect("valid date");
    let time = Time::from_hms(hour, minute, 0).expect("valid time");
    date.with_time(time).assume_utc()
}

#[test]
fn rejects_an_empty_title() {
    // Arrange
    let input = "";

    // Act
    let result = normalize_title(input);

    // Assert
    assert_eq!(result, None);
}

#[test]
fn rejects_a_whitespace_only_title() {
    // Arrange
    let input = "   \t\n  ";

    // Act
    let result = normalize_title(input);

    // Assert
    assert_eq!(result, None);
}

#[test]
fn caps_an_over_length_title_at_max_title_length_characters() {
    // Arrange: one character longer than the cap.
    let input = "a".repeat(MAX_TITLE_LENGTH + 1);

    // Act
    let result = normalize_title(&input);

    // Assert
    let normalized = result.expect("over-length title should still normalize, just capped");
    assert_eq!(normalized.chars().count(), MAX_TITLE_LENGTH);
    assert_eq!(normalized, "a".repeat(MAX_TITLE_LENGTH));
}

#[test]
fn trims_surrounding_whitespace_from_an_otherwise_valid_title() {
    // Arrange
    let input = "  Weekly sync  ";

    // Act
    let result = normalize_title(input);

    // Assert
    assert_eq!(result, Some("Weekly sync".to_string()));
}

#[test]
fn round_trips_an_accented_unicode_title_intact() {
    // Arrange
    let input = "Réunion d'équipe";

    // Act
    let result = normalize_title(input);

    // Assert
    assert_eq!(result, Some("Réunion d'équipe".to_string()));
}

#[test]
fn default_title_formats_the_creation_timestamp_as_a_readable_meeting_name() {
    // Arrange
    let created_at = utc(2026, Month::August, 27, 17, 57);

    // Act
    let result = default_title(created_at);

    // Assert
    assert_eq!(result, "Meeting 27 Aug 17:57");
}

#[test]
fn default_title_zero_pads_single_digit_hours_and_minutes() {
    // Arrange
    let created_at = utc(2026, Month::January, 3, 5, 9);

    // Act
    let result = default_title(created_at);

    // Assert
    assert_eq!(result, "Meeting 3 Jan 05:09");
}

#[test]
fn resolve_new_title_keeps_a_valid_proposed_title_unchanged() {
    // Arrange
    let created_at = utc(2026, Month::August, 27, 17, 57);

    // Act
    let result = resolve_new_title("Weekly sync", created_at);

    // Assert
    assert_eq!(result, "Weekly sync");
}

#[test]
fn resolve_new_title_falls_back_to_the_default_when_the_proposed_title_is_empty() {
    // Arrange
    let created_at = utc(2026, Month::August, 27, 17, 57);

    // Act
    let result = resolve_new_title("", created_at);

    // Assert
    assert_eq!(result, "Meeting 27 Aug 17:57");
}

#[test]
fn resolve_new_title_falls_back_to_the_default_when_the_proposed_title_is_whitespace_only() {
    // Arrange
    let created_at = utc(2026, Month::August, 27, 17, 57);

    // Act
    let result = resolve_new_title("   \t\n  ", created_at);

    // Assert
    assert_eq!(result, "Meeting 27 Aug 17:57");
}

#[test]
fn resolve_new_title_trims_and_caps_a_valid_proposed_title_like_normalize_title() {
    // Arrange
    let created_at = utc(2026, Month::August, 27, 17, 57);

    // Act
    let result = resolve_new_title("  Weekly sync  ", created_at);

    // Assert
    assert_eq!(result, "Weekly sync");
}

// --- normalize_segment_text -------------------------------------------

#[test]
fn normalize_segment_text_rejects_an_empty_string() {
    // Arrange
    let input = "";

    // Act
    let result = normalize_segment_text(input);

    // Assert
    assert_eq!(result, None);
}

#[test]
fn normalize_segment_text_rejects_a_whitespace_only_string() {
    // Arrange
    let input = "   \t\n  ";

    // Act
    let result = normalize_segment_text(input);

    // Assert
    assert_eq!(result, None);
}

#[test]
fn normalize_segment_text_trims_surrounding_whitespace() {
    // Arrange
    let input = "  hello team  ";

    // Act
    let result = normalize_segment_text(input);

    // Assert
    assert_eq!(result, Some("hello team".to_string()));
}

#[test]
fn normalize_segment_text_caps_an_over_length_string_at_max_segment_text_length_characters() {
    // Arrange: one character longer than the cap.
    let input = "a".repeat(MAX_SEGMENT_TEXT_LENGTH + 1);

    // Act
    let result = normalize_segment_text(&input);

    // Assert
    let normalized = result.expect("over-length text should still normalize, just capped");
    assert_eq!(normalized.chars().count(), MAX_SEGMENT_TEXT_LENGTH);
    assert_eq!(normalized, "a".repeat(MAX_SEGMENT_TEXT_LENGTH));
}

#[test]
fn normalize_segment_text_round_trips_accented_unicode_text_intact() {
    // Arrange
    let input = "Réunion d'équipe";

    // Act
    let result = normalize_segment_text(input);

    // Assert
    assert_eq!(result, Some("Réunion d'équipe".to_string()));
}

// --- apply_segment_edit -------------------------------------------------

fn two_segment_transcript() -> Transcript {
    Transcript::default()
        .with_segment(TranscriptSegment {
            start_sec: 0.0,
            end_sec: 1.5,
            text: "hello team".to_string(),
        })
        .with_segment(TranscriptSegment {
            start_sec: 1.5,
            end_sec: 3.0,
            text: "let's begin".to_string(),
        })
}

#[test]
fn apply_segment_edit_replaces_only_the_target_segments_text() {
    // Arrange
    let transcript = two_segment_transcript();
    let before = transcript.clone();

    // Act
    let updated = apply_segment_edit(&transcript, 0, "hi everyone").expect("apply_segment_edit");

    // Assert: target segment's text changed, timestamps preserved.
    assert_eq!(updated.segments[0].text, "hi everyone");
    assert_eq!(updated.segments[0].start_sec, 0.0);
    assert_eq!(updated.segments[0].end_sec, 1.5);

    // Assert: every other segment untouched, order preserved.
    assert_eq!(updated.segments[1], before.segments[1]);
    assert_eq!(updated.segments.len(), before.segments.len());

    // Assert: the input transcript is left untouched.
    assert_eq!(transcript, before);
}

#[test]
fn apply_segment_edit_preserves_order_and_every_other_segment() {
    // Arrange
    let transcript = two_segment_transcript();

    // Act
    let updated = apply_segment_edit(&transcript, 1, "let's start").expect("apply_segment_edit");

    // Assert
    assert_eq!(updated.segments[0], transcript.segments[0]);
    assert_eq!(updated.segments[1].text, "let's start");
    assert_eq!(updated.segments[1].start_sec, 1.5);
    assert_eq!(updated.segments[1].end_sec, 3.0);
}

#[test]
fn apply_segment_edit_out_of_range_index_yields_not_found() {
    // Arrange
    let transcript = two_segment_transcript();

    // Act
    let result = apply_segment_edit(&transcript, 5, "unreachable");

    // Assert
    assert!(matches!(result, Err(AppError::NotFound(_))));
}

#[test]
fn apply_segment_edit_with_whitespace_only_text_leaves_the_transcript_unchanged() {
    // Arrange
    let transcript = two_segment_transcript();

    // Act
    let updated = apply_segment_edit(&transcript, 0, "   \t  ").expect("apply_segment_edit");

    // Assert
    assert_eq!(updated, transcript);
}
