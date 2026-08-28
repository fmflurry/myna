//! Unit tests for [`normalize_title`], the pure validation/normalization
//! step behind the `rename_meeting` command, and [`default_title`]/
//! [`resolve_new_title`], the pure functions behind `start_recording`'s
//! empty-title fallback. Exercised directly — no `AppHandle` or store
//! needed, since they take and return plain strings (and a timestamp).

use myna_app::commands::meetings::{
    default_title, normalize_title, resolve_new_title, MAX_TITLE_LENGTH,
};
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
