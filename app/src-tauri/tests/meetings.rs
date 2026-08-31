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
            speaker: myna_stt::Speaker::default(),
            speaker_pinned: false,
        })
        .with_segment(TranscriptSegment {
            start_sec: 1.5,
            end_sec: 3.0,
            text: "let's begin".to_string(),
            speaker: myna_stt::Speaker::default(),
            speaker_pinned: false,
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

// --- apply_segment_delete / apply_segment_merge_up / apply_segment_restore --
//
// Pure transcript-editing functions living beside `apply_segment_edit` in
// `commands::meetings`. Each takes an immutable `&Transcript` and returns a
// new one, never mutating the input; structural errors (bad index,
// mismatched optimistic-concurrency `expected_text`, a disallowed merge, or
// a malformed speaker label) surface as `AppError::NotFound`, mirroring
// `apply_segment_edit`'s contract.
mod transcript_structure {
    use myna_app::commands::meetings::{
        apply_segment_delete, apply_segment_merge_up, apply_segment_restore,
        MAX_SEGMENT_TEXT_LENGTH,
    };
    use myna_app::error::AppError;
    use myna_stt::{Speaker, Transcript, TranscriptSegment};

    fn seg(start: f32, end: f32, text: &str, speaker: Speaker, pinned: bool) -> TranscriptSegment {
        TranscriptSegment {
            start_sec: start,
            end_sec: end,
            text: text.to_string(),
            speaker,
            speaker_pinned: pinned,
        }
    }

    fn transcript_of(segments: Vec<TranscriptSegment>) -> Transcript {
        Transcript { segments }
    }

    // ---- apply_segment_delete ----------------------------------------

    #[test]
    fn apply_segment_delete_removes_the_middle_segment_and_preserves_neighbour_order() {
        // Arrange
        let transcript = transcript_of(vec![
            seg(0.0, 1.0, "first", Speaker::default(), false),
            seg(1.0, 2.0, "second", Speaker::default(), false),
            seg(2.0, 3.0, "third", Speaker::default(), false),
        ]);

        // Act
        let updated = apply_segment_delete(&transcript, 1, "second").expect("apply_segment_delete");

        // Assert
        assert_eq!(updated.segments.len(), 2);
        assert_eq!(updated.segments[0], transcript.segments[0]);
        assert_eq!(updated.segments[1], transcript.segments[2]);
    }

    #[test]
    fn apply_segment_delete_removes_the_first_segment() {
        // Arrange
        let transcript = transcript_of(vec![
            seg(0.0, 1.0, "first", Speaker::default(), false),
            seg(1.0, 2.0, "second", Speaker::default(), false),
        ]);

        // Act
        let updated = apply_segment_delete(&transcript, 0, "first").expect("apply_segment_delete");

        // Assert
        assert_eq!(updated.segments.len(), 1);
        assert_eq!(updated.segments[0], transcript.segments[1]);
    }

    #[test]
    fn apply_segment_delete_removes_the_last_segment() {
        // Arrange
        let transcript = transcript_of(vec![
            seg(0.0, 1.0, "first", Speaker::default(), false),
            seg(1.0, 2.0, "second", Speaker::default(), false),
        ]);

        // Act
        let updated = apply_segment_delete(&transcript, 1, "second").expect("apply_segment_delete");

        // Assert
        assert_eq!(updated.segments.len(), 1);
        assert_eq!(updated.segments[0], transcript.segments[0]);
    }

    #[test]
    fn apply_segment_delete_of_the_only_segment_yields_an_empty_transcript_not_a_dropped_one() {
        // Arrange: an empty `Transcript { segments: vec![] }` is not the same
        // thing as `None` — `None` means "never transcribed" and would make
        // the UI offer transcription again, which deleting the last segment
        // must never do.
        let transcript = transcript_of(vec![seg(0.0, 1.0, "solo", Speaker::default(), false)]);

        // Act
        let updated = apply_segment_delete(&transcript, 0, "solo").expect("apply_segment_delete");

        // Assert
        assert_eq!(updated, Transcript { segments: vec![] });
    }

    #[test]
    fn apply_segment_delete_out_of_range_index_yields_not_found_and_leaves_input_untouched() {
        // Arrange
        let transcript = transcript_of(vec![seg(0.0, 1.0, "only", Speaker::default(), false)]);
        let before = transcript.clone();

        // Act
        let result = apply_segment_delete(&transcript, 5, "only");

        // Assert
        assert!(matches!(result, Err(AppError::NotFound(_))));
        assert_eq!(transcript, before);
    }

    #[test]
    fn apply_segment_delete_with_mismatched_expected_text_yields_not_found_and_leaves_input_untouched(
    ) {
        // Arrange
        let transcript = transcript_of(vec![seg(0.0, 1.0, "actual", Speaker::default(), false)]);
        let before = transcript.clone();

        // Act
        let result = apply_segment_delete(&transcript, 0, "stale");

        // Assert
        assert!(matches!(result, Err(AppError::NotFound(_))));
        assert_eq!(transcript, before);
    }

    // ---- apply_segment_merge_up ---------------------------------------

    #[test]
    fn apply_segment_merge_up_at_index_zero_yields_not_found() {
        // Arrange
        let transcript = transcript_of(vec![seg(0.0, 1.0, "only", Speaker::default(), false)]);

        // Act
        let result = apply_segment_merge_up(&transcript, 0, "only");

        // Assert
        assert!(matches!(result, Err(AppError::NotFound(_))));
    }

    #[test]
    fn apply_segment_merge_up_refuses_when_the_previous_segment_has_a_different_speaker() {
        // Arrange
        let transcript = transcript_of(vec![
            seg(0.0, 1.0, "a", Speaker::me(), false),
            seg(1.0, 2.0, "b", Speaker::others(), false),
        ]);

        // Act
        let result = apply_segment_merge_up(&transcript, 1, "b");

        // Assert
        assert!(matches!(result, Err(AppError::NotFound(_))));
    }

    #[test]
    fn apply_segment_merge_up_refuses_regardless_of_which_side_holds_which_speaker() {
        // Arrange: same two labels as the previous test, swapped sides.
        let transcript = transcript_of(vec![
            seg(0.0, 1.0, "a", Speaker::others(), false),
            seg(1.0, 2.0, "b", Speaker::me(), false),
        ]);

        // Act
        let result = apply_segment_merge_up(&transcript, 1, "b");

        // Assert
        assert!(matches!(result, Err(AppError::NotFound(_))));
    }

    #[test]
    fn apply_segment_merge_up_refuses_two_distinct_others_labels_even_when_a_display_name_would_coincide(
    ) {
        // Arrange: `others:1` and `others:2` are different machine labels
        // even when a caller's `speaker_names` map happens to give both the
        // same human-facing display name (e.g. after a user correction).
        // `Transcript` carries no display-name concept, so the merge must
        // refuse on label identity alone, not on any name that might be
        // layered on top elsewhere.
        let transcript = transcript_of(vec![
            seg(0.0, 1.0, "a", Speaker::parse("others:1"), false),
            seg(1.0, 2.0, "b", Speaker::parse("others:2"), false),
        ]);

        // Act
        let result = apply_segment_merge_up(&transcript, 1, "b");

        // Assert
        assert!(matches!(result, Err(AppError::NotFound(_))));
    }

    #[test]
    fn apply_segment_merge_up_joins_text_with_a_single_ascii_space_and_no_inserted_punctuation() {
        // Arrange: stray whitespace at the seam must be trimmed away, not
        // preserved or replaced with punctuation.
        let transcript = transcript_of(vec![
            seg(0.0, 1.0, "a ", Speaker::me(), false),
            seg(1.0, 2.0, " b", Speaker::me(), false),
        ]);

        // Act
        let updated = apply_segment_merge_up(&transcript, 1, " b").expect("apply_segment_merge_up");

        // Assert
        assert_eq!(updated.segments.len(), 1);
        assert_eq!(updated.segments[0].text, "a b");
    }

    #[test]
    fn apply_segment_merge_up_spans_from_previous_start_to_the_max_end_of_both_segments() {
        // Arrange: overlapping segments where the earlier one's end is LATER
        // than the later one's end, so `max(prev.end_sec, cur.end_sec)` is
        // distinguishable from simply taking `cur.end_sec`.
        let transcript = transcript_of(vec![
            seg(0.0, 5.0, "a", Speaker::me(), false),
            seg(2.0, 3.0, "b", Speaker::me(), false),
        ]);

        // Act
        let updated = apply_segment_merge_up(&transcript, 1, "b").expect("apply_segment_merge_up");

        // Assert
        assert_eq!(updated.segments.len(), 1);
        assert_eq!(updated.segments[0].start_sec, 0.0);
        assert_eq!(updated.segments[0].end_sec, 5.0);
    }

    #[test]
    fn apply_segment_merge_up_pins_the_result_when_either_source_segment_was_pinned() {
        // Arrange / Act / Assert: `speaker_pinned` is an OR of both sides.
        let cases = [
            (false, false, false),
            (true, false, true),
            (false, true, true),
            (true, true, true),
        ];

        for (prev_pinned, cur_pinned, expected) in cases {
            let transcript = transcript_of(vec![
                seg(0.0, 1.0, "a", Speaker::me(), prev_pinned),
                seg(1.0, 2.0, "b", Speaker::me(), cur_pinned),
            ]);

            let updated =
                apply_segment_merge_up(&transcript, 1, "b").expect("apply_segment_merge_up");

            assert_eq!(
                updated.segments[0].speaker_pinned, expected,
                "prev_pinned={prev_pinned} cur_pinned={cur_pinned}"
            );
        }
    }

    #[test]
    fn apply_segment_merge_up_preserves_the_shared_speaker_label_byte_for_byte() {
        // Arrange
        let transcript = transcript_of(vec![
            seg(0.0, 1.0, "a", Speaker::parse("others:7"), false),
            seg(1.0, 2.0, "b", Speaker::parse("others:7"), false),
        ]);

        // Act
        let updated = apply_segment_merge_up(&transcript, 1, "b").expect("apply_segment_merge_up");

        // Assert
        assert_eq!(updated.segments[0].speaker.as_str(), "others:7");
    }

    #[test]
    fn apply_segment_merge_up_leaves_full_text_and_attributed_text_unchanged() {
        // Arrange: merging two consecutive same-speaker segments must not
        // change any summary-facing rendering of the transcript — both
        // `full_text` and `attributed_text` already join same-speaker runs
        // with a single space, so the merge is neutral by construction.
        let transcript = transcript_of(vec![
            seg(0.0, 1.0, "a", Speaker::me(), false),
            seg(1.0, 2.0, "b", Speaker::me(), false),
        ]);
        let full_text_before = transcript.full_text();
        let attributed_before = transcript.attributed_text();

        // Act
        let updated = apply_segment_merge_up(&transcript, 1, "b").expect("apply_segment_merge_up");

        // Assert
        assert_eq!(updated.full_text(), full_text_before);
        assert_eq!(updated.attributed_text(), attributed_before);
    }

    #[test]
    fn apply_segment_merge_up_rejects_rather_than_truncates_when_joined_text_exceeds_the_max_length(
    ) {
        // Arrange: joined length is one character over the cap.
        let long_a = "a".repeat(MAX_SEGMENT_TEXT_LENGTH);
        let long_b = "b".to_string();
        let transcript = transcript_of(vec![
            seg(0.0, 1.0, &long_a, Speaker::me(), false),
            seg(1.0, 2.0, &long_b, Speaker::me(), false),
        ]);

        // Act
        let result = apply_segment_merge_up(&transcript, 1, &long_b);

        // Assert: must reject, never silently truncate.
        assert!(matches!(result, Err(AppError::NotFound(_))));
    }

    // ---- apply_segment_restore -----------------------------------------

    #[test]
    fn apply_segment_restore_with_zero_remove_count_round_trips_a_delete_exactly() {
        // Arrange: what `apply_segment_delete` would have removed, including
        // its `speaker_pinned` flag.
        let removed = seg(0.0, 1.0, "solo", Speaker::me(), true);
        let after_delete = transcript_of(vec![]);

        // Act
        let restored = apply_segment_restore(&after_delete, 0, 0, std::slice::from_ref(&removed))
            .expect("apply_segment_restore");

        // Assert
        assert_eq!(restored.segments, vec![removed]);
    }

    #[test]
    fn apply_segment_restore_with_remove_count_one_round_trips_a_merge_exactly_restoring_both_flags(
    ) {
        // Arrange: two originals with different `speaker_pinned` flags,
        // merged into a single segment at index 0.
        let prev_original = seg(0.0, 1.0, "a", Speaker::me(), true);
        let cur_original = seg(1.0, 2.0, "b", Speaker::me(), false);
        let merged = transcript_of(vec![seg(0.0, 2.0, "a b", Speaker::me(), true)]);

        // Act
        let restored = apply_segment_restore(
            &merged,
            0,
            1,
            &[prev_original.clone(), cur_original.clone()],
        )
        .expect("apply_segment_restore");

        // Assert: both flags restored individually, not collapsed to one.
        assert_eq!(restored.segments, vec![prev_original, cur_original]);
    }

    #[test]
    fn apply_segment_restore_with_a_malformed_speaker_label_yields_an_error_instead_of_silently_degrading(
    ) {
        // Arrange: `Speaker::others_id` does not validate `id`, so it is the
        // only public way to construct a label that fails
        // `Speaker::parse`'s well-formedness check without going through
        // `parse` itself (which would silently degrade it to `unknown`).
        let transcript = transcript_of(vec![]);
        let malformed = seg(0.0, 1.0, "hi", Speaker::others_id("Not Valid!"), false);

        // Act
        let result = apply_segment_restore(&transcript, 0, 0, &[malformed]);

        // Assert
        assert!(matches!(result, Err(AppError::NotFound(_))));
    }
}
