//! Pure relabeling of bare `others` transcript segments into deterministic
//! `others:<N>` sub-identities, driven by diarization output. See
//! [`relabel_others`] for the confidence rule — this is the crate's honesty
//! mechanism: attribution is only ever assigned when the diarization signal
//! is strong enough to trust, never fabricated.

use std::collections::HashMap;

use crate::diarize::DiarizeResult;
use crate::transcript::{Speaker, Transcript, TranscriptSegment};

/// Minimum segment duration, in seconds, eligible for relabeling. Shorter
/// segments carry too little diarization signal to trust.
pub const MIN_DIARIZED_SEGMENT_SEC: f32 = 1.0;

/// Minimum fraction of a segment's `[start_sec, end_sec)` span that must be
/// covered by diarization segments of exactly one speaker index before that
/// index is trusted to relabel the segment.
pub const MIN_SPEAKER_COVERAGE: f32 = 0.70;

/// Assigns `others:<N>` sub-identities to bare `others` segments of
/// `transcript`, using `result` as the diarization signal. Pure and
/// immutable: returns a new [`Transcript`], never mutates `transcript`.
///
/// A segment is relabelled only when ALL hold:
///
/// 1. `result.num_speakers >= 2` (otherwise the whole transcript is
///    returned unchanged — "others 1" is meaningless with a single
///    speaker).
/// 2. The segment's duration is at least [`MIN_DIARIZED_SEGMENT_SEC`].
/// 3. At least [`MIN_SPEAKER_COVERAGE`] of the segment's span is covered
///    by diarization segments of exactly one speaker index.
///
/// `me` and `unknown` segments are never touched, and neither is any
/// segment with `speaker_pinned == true` — those are the user's manual
/// corrections, and silently overwriting them would be a data-loss bug.
/// Segments that fail any condition stay bare `others`; this function never
/// fabricates attribution.
///
/// Index-to-label mapping is deterministic and 1-based: diarization speaker
/// index `0` becomes `others:1`, index `1` becomes `others:2`, and so on,
/// via [`Speaker::others_id`] — always a pure-numeric sub-id, never the
/// `m`-prefixed namespace reserved for user-minted speakers.
pub fn relabel_others(transcript: &Transcript, result: &DiarizeResult) -> Transcript {
    if result.num_speakers < 2 {
        return transcript.clone();
    }

    let segments = transcript
        .segments
        .iter()
        .map(|segment| relabel_segment(segment, result))
        .collect();

    Transcript { segments }
}

/// Relabels a single segment, or returns it unchanged (cloned) when any
/// condition of [`relabel_others`]'s confidence rule fails.
fn relabel_segment(segment: &TranscriptSegment, result: &DiarizeResult) -> TranscriptSegment {
    // Only a bare `others` segment is a relabeling candidate. This single
    // equality check already excludes `me`, `unknown`, and any
    // already-tagged `others:<id>` (including a user-minted `others:m1`).
    if segment.speaker_pinned || segment.speaker != Speaker::others() {
        return segment.clone();
    }

    let duration = segment.end_sec - segment.start_sec;
    if duration < MIN_DIARIZED_SEGMENT_SEC {
        return segment.clone();
    }

    match dominant_speaker_index(segment, result, duration) {
        Some(index) => TranscriptSegment {
            speaker: Speaker::others_id(&(index + 1).to_string()),
            ..segment.clone()
        },
        None => segment.clone(),
    }
}

/// Returns the diarization speaker index covering >= [`MIN_SPEAKER_COVERAGE`]
/// of `segment`'s `[start_sec, end_sec)` span, if exactly one such index
/// exists. `duration` is passed in rather than recomputed since the caller
/// already validated it's positive.
fn dominant_speaker_index(
    segment: &TranscriptSegment,
    result: &DiarizeResult,
    duration: f32,
) -> Option<u32> {
    if duration <= 0.0 {
        return None;
    }

    let mut coverage: HashMap<u32, f32> = HashMap::new();
    for dia in &result.segments {
        let overlap = overlap_sec(
            segment.start_sec,
            segment.end_sec,
            dia.start_sec,
            dia.end_sec,
        );
        if overlap > 0.0 {
            *coverage.entry(dia.speaker_index).or_insert(0.0) += overlap;
        }
    }

    let (best_index, best_overlap) = coverage.into_iter().max_by(|a, b| a.1.total_cmp(&b.1))?;

    if best_overlap / duration >= MIN_SPEAKER_COVERAGE {
        Some(best_index)
    } else {
        None
    }
}

/// Overlap, in seconds, between `[a_start, a_end)` and `[b_start, b_end)`.
/// Zero (never negative) when the spans don't intersect.
fn overlap_sec(a_start: f32, a_end: f32, b_start: f32, b_end: f32) -> f32 {
    (a_end.min(b_end) - a_start.max(b_start)).max(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diarize::DiarizeSegment;

    fn others_segment(start_sec: f32, end_sec: f32) -> TranscriptSegment {
        TranscriptSegment {
            start_sec,
            end_sec,
            text: "hello".to_string(),
            speaker: Speaker::others(),
            speaker_pinned: false,
        }
    }

    fn dia(start_sec: f32, end_sec: f32, speaker_index: u32) -> DiarizeSegment {
        DiarizeSegment {
            start_sec,
            end_sec,
            speaker_index,
        }
    }

    // ---- 1. num_speakers < 2 leaves the whole transcript untouched --------

    #[test]
    fn single_speaker_result_leaves_the_entire_transcript_unchanged() {
        let transcript = Transcript::default().with_segment(others_segment(0.0, 5.0));
        let result = DiarizeResult {
            num_speakers: 1,
            segments: vec![dia(0.0, 5.0, 0)],
        };

        let relabeled = relabel_others(&transcript, &result);

        assert_eq!(relabeled, transcript);
    }

    // ---- 2. segment shorter than MIN_DIARIZED_SEGMENT_SEC stays bare ------

    #[test]
    fn a_segment_shorter_than_the_minimum_duration_stays_bare_others() {
        let transcript = Transcript::default().with_segment(others_segment(0.0, 0.5));
        let result = DiarizeResult {
            num_speakers: 2,
            segments: vec![dia(0.0, 0.5, 0)],
        };

        let relabeled = relabel_others(&transcript, &result);

        assert_eq!(relabeled.segments[0].speaker, Speaker::others());
    }

    // ---- 3. ~50/50 coverage split stays bare -------------------------------

    #[test]
    fn a_fifty_fifty_coverage_split_between_two_speakers_stays_bare_others() {
        let transcript = Transcript::default().with_segment(others_segment(0.0, 2.0));
        let result = DiarizeResult {
            num_speakers: 2,
            segments: vec![dia(0.0, 1.0, 0), dia(1.0, 2.0, 1)],
        };

        let relabeled = relabel_others(&transcript, &result);

        assert_eq!(relabeled.segments[0].speaker, Speaker::others());
    }

    // ---- 4. >= 70% coverage by one speaker becomes others:N ---------------

    #[test]
    fn coverage_at_or_above_the_threshold_by_one_speaker_becomes_others_n() {
        let transcript = Transcript::default().with_segment(others_segment(0.0, 2.0));
        // Speaker index 1 covers 1.5s of the 2.0s segment == 75%.
        let result = DiarizeResult {
            num_speakers: 2,
            segments: vec![dia(0.0, 0.5, 0), dia(0.5, 2.0, 1)],
        };

        let relabeled = relabel_others(&transcript, &result);

        assert_eq!(relabeled.segments[0].speaker, Speaker::others_id("2"));
    }

    // ---- 5. a `me` segment overlapping diarization output is untouched ----

    #[test]
    fn a_me_segment_overlapping_diarization_output_is_untouched() {
        let me_segment = TranscriptSegment {
            start_sec: 0.0,
            end_sec: 2.0,
            text: "hello".to_string(),
            speaker: Speaker::me(),
            speaker_pinned: false,
        };
        let transcript = Transcript::default().with_segment(me_segment.clone());
        let result = DiarizeResult {
            num_speakers: 2,
            segments: vec![dia(0.0, 2.0, 0)],
        };

        let relabeled = relabel_others(&transcript, &result);

        assert_eq!(relabeled.segments[0], me_segment);
    }

    // ---- 6. an `unknown` segment is untouched ------------------------------

    #[test]
    fn an_unknown_segment_is_untouched() {
        let unknown_segment = TranscriptSegment {
            start_sec: 0.0,
            end_sec: 2.0,
            text: "hello".to_string(),
            speaker: Speaker::unknown(),
            speaker_pinned: false,
        };
        let transcript = Transcript::default().with_segment(unknown_segment.clone());
        let result = DiarizeResult {
            num_speakers: 2,
            segments: vec![dia(0.0, 2.0, 0)],
        };

        let relabeled = relabel_others(&transcript, &result);

        assert_eq!(relabeled.segments[0], unknown_segment);
    }

    // ---- 7. a speaker_pinned segment is untouched, even at 100% coverage --

    #[test]
    fn a_speaker_pinned_segment_is_untouched_even_at_full_coverage() {
        let pinned_segment = TranscriptSegment {
            start_sec: 0.0,
            end_sec: 2.0,
            text: "hello".to_string(),
            speaker: Speaker::others(),
            speaker_pinned: true,
        };
        let transcript = Transcript::default().with_segment(pinned_segment.clone());
        let result = DiarizeResult {
            num_speakers: 2,
            segments: vec![dia(0.0, 2.0, 0)],
        };

        let relabeled = relabel_others(&transcript, &result);

        assert_eq!(relabeled.segments[0], pinned_segment);
    }

    // ---- 8. empty transcript never panics ----------------------------------

    #[test]
    fn an_empty_transcript_returns_an_empty_transcript_without_panicking() {
        let transcript = Transcript::default();
        let result = DiarizeResult {
            num_speakers: 2,
            segments: vec![dia(0.0, 2.0, 0)],
        };

        let relabeled = relabel_others(&transcript, &result);

        assert_eq!(relabeled, Transcript::default());
    }

    // ---- 9. empty diarization segments with num_speakers >= 2 stays bare --

    #[test]
    fn empty_diarization_segments_with_multiple_speakers_leaves_segments_bare() {
        let transcript = Transcript::default().with_segment(others_segment(0.0, 5.0));
        let result = DiarizeResult {
            num_speakers: 2,
            segments: vec![],
        };

        let relabeled = relabel_others(&transcript, &result);

        assert_eq!(relabeled.segments[0].speaker, Speaker::others());
    }

    // ---- 10. index -> label mapping is 1-based and deterministic ----------

    #[test]
    fn index_to_label_mapping_is_one_based_and_deterministic() {
        let transcript = Transcript::default()
            .with_segment(others_segment(0.0, 2.0))
            .with_segment(others_segment(2.0, 4.0));
        let result = DiarizeResult {
            num_speakers: 2,
            segments: vec![dia(0.0, 2.0, 0), dia(2.0, 4.0, 1)],
        };

        let relabeled = relabel_others(&transcript, &result);

        assert_eq!(relabeled.segments[0].speaker, Speaker::others_id("1"));
        assert_eq!(relabeled.segments[1].speaker, Speaker::others_id("2"));
    }

    // ---- pure / immutable: original transcript is never mutated -----------

    #[test]
    fn relabel_others_never_mutates_the_original_transcript() {
        let transcript = Transcript::default().with_segment(others_segment(0.0, 2.0));
        let original = transcript.clone();
        let result = DiarizeResult {
            num_speakers: 2,
            segments: vec![dia(0.0, 2.0, 0)],
        };

        let _ = relabel_others(&transcript, &result);

        assert_eq!(transcript, original, "input transcript must be unchanged");
    }
}
