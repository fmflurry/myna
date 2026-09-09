//! Pure relabeling of bare `others` transcript segments into deterministic
//! `others:<N>` sub-identities, driven by diarization output. See
//! [`relabel_others`] for the confidence rule — this is the crate's honesty
//! mechanism: attribution is only ever assigned when the diarization signal
//! is strong enough to trust, never fabricated.

use std::collections::HashMap;

use crate::detokenize::Word;
use crate::diarize::{compact_speaker_indices, DiarizeConfig, DiarizeResult};
use crate::transcript::{Speaker, SpeakerRole, Transcript, TranscriptSegment};

/// Minimum segment duration, in seconds, eligible for relabeling. Shorter
/// segments carry too little diarization signal to trust.
///
/// Kept as the alias for [`DiarizeConfig::min_segment_sec`]'s default — the
/// config field is the tunable going forward. 0.75 s admits short
/// confirmations while still abstaining on sub-word blips.
pub const MIN_DIARIZED_SEGMENT_SEC: f32 = 0.75;

/// Minimum fraction of a segment's `[start_sec, end_sec)` span that must be
/// covered by diarization segments of exactly one speaker index before that
/// index is trusted to relabel the segment.
///
/// Kept as the alias for [`DiarizeConfig::min_coverage`]'s default — the
/// config field is the tunable going forward. 0.60 recovers split-coverage
/// turns; anything below still abstains to bare `others` (never a text
/// rewrite — the text lock is unchanged).
pub const MIN_SPEAKER_COVERAGE: f32 = 0.60;

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
/// Relabel candidates are unpinned segments that are either bare `others`
/// or carry a *stale* diarization label — a pure-numeric `others:<N>` left
/// by a previous run. Diarization indices are only stable within a single
/// [`crate::Diarizer::diarize_wav`] call, so a stale `others:<N>` is
/// re-derived from the current run rather than kept; otherwise two index
/// namespaces would mix in one transcript. `me` and `unknown` segments are
/// never touched, and neither is any segment with `speaker_pinned == true`
/// nor a user-minted `others:m<N>` (the `m` prefix is the discriminator, see
/// [`Speaker::others_id`]) — those are the user's manual corrections, and
/// silently overwriting them would be a data-loss bug. Candidates that fail
/// any condition are returned unchanged; this function never fabricates
/// attribution.
///
/// Index-to-label mapping is deterministic and 1-based over *compacted*
/// indices: `result` is passed through [`compact_speaker_indices`] first, so
/// the first voice heard becomes `others:1`, the second `others:2`, and so
/// on, via [`Speaker::others_id`] — always a pure-numeric sub-id, never the
/// `m`-prefixed namespace reserved for user-minted speakers, and never a
/// number larger than the count of distinct clusters in `result`.
pub fn relabel_others(transcript: &Transcript, result: &DiarizeResult) -> Transcript {
    relabel_others_with_config(transcript, result, &DiarizeConfig::default())
}

/// Configurable variant of [`relabel_others`]: identical confidence rule,
/// but the duration and coverage thresholds come from `cfg`
/// (`min_segment_sec` / `min_coverage`) instead of the
/// [`MIN_DIARIZED_SEGMENT_SEC`] / [`MIN_SPEAKER_COVERAGE`] defaults.
///
/// The single-speaker gate reads `result.num_speakers` as given — the
/// diarizer's reported count — *before* compaction, so a caller whose
/// post-processing filtered a minority speaker's only evidence still
/// relabels the surviving majority turn.
pub fn relabel_others_with_config(
    transcript: &Transcript,
    result: &DiarizeResult,
    cfg: &DiarizeConfig,
) -> Transcript {
    if result.num_speakers < 2 {
        return transcript.clone();
    }

    let compacted = compact_speaker_indices(result);
    let segments = transcript
        .segments
        .iter()
        .map(|segment| relabel_segment_with_config(segment, &compacted, cfg))
        .collect();

    Transcript { segments }
}

/// Candidate gate shared by [`relabel_segment_with_config`] and
/// [`relabel_segment_word_level`]: an unpinned segment that is bare `others`
/// or carries a stale pure-numeric `others:<N>` from a previous diarization
/// run. `me`, `unknown`, pinned, and user-minted `others:m<N>` are excluded.
fn is_relabel_candidate(segment: &TranscriptSegment) -> bool {
    !segment.speaker_pinned
        && (segment.speaker == Speaker::others() || is_stale_diarization_label(&segment.speaker))
}

/// `true` for an `others:<N>` label whose sub-id is entirely ASCII digits —
/// the shape this module mints, and therefore the only shape it may reset.
/// User-minted `others:m<N>` and any other sub-id are `false`.
fn is_stale_diarization_label(speaker: &Speaker) -> bool {
    speaker.role() == SpeakerRole::Others
        && speaker
            .sub_id()
            .is_some_and(|id| !id.is_empty() && id.chars().all(|c| c.is_ascii_digit()))
}

/// Configurable single-segment relabel used by
/// [`relabel_others_with_config`]: returns the segment unchanged (cloned)
/// when any condition of [`relabel_others`]'s confidence rule fails.
/// `result` must already be compacted (see [`compact_speaker_indices`]).
fn relabel_segment_with_config(
    segment: &TranscriptSegment,
    result: &DiarizeResult,
    cfg: &DiarizeConfig,
) -> TranscriptSegment {
    if !is_relabel_candidate(segment) {
        return segment.clone();
    }

    let duration = segment.end_sec - segment.start_sec;
    if duration < cfg.min_segment_sec {
        return segment.clone();
    }

    match dominant_speaker_index_with_config(segment, result, duration, cfg) {
        Some(index) => TranscriptSegment {
            speaker: Speaker::others_id(&(index + 1).to_string()),
            ..segment.clone()
        },
        None => segment.clone(),
    }
}

/// Configurable dominant-speaker lookup used by
/// [`relabel_others_with_config`]: the required coverage fraction comes from
/// `cfg.min_coverage`. Returns the diarization speaker index covering >=
/// that fraction of `segment`'s `[start_sec, end_sec)` span, if exactly one
/// such index exists. `duration` is passed in rather than recomputed since
/// the caller already validated it's positive.
fn dominant_speaker_index_with_config(
    segment: &TranscriptSegment,
    result: &DiarizeResult,
    duration: f32,
    cfg: &DiarizeConfig,
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

    if best_overlap / duration >= cfg.min_coverage {
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

/// Assigns `others:<N>` sub-identities to bare `others` segments of
/// `transcript` by per-word majority vote over `aligned` (the output of
/// [`crate::align::align_words_to_diar`]). Pure and immutable: returns a new
/// [`Transcript`], never mutates `transcript` and never edits any text.
///
/// Each aligned word votes once, for its own `Some(speaker_index)`, in the
/// single transcript segment containing the word's midpoint (`None` words —
/// silence gaps, out-of-range timing — still count toward the denominator,
/// diluting confidence). A segment is relabelled only when ALL hold:
///
/// 1. `result.num_speakers >= 2` (same single-speaker gate as
///    [`relabel_others_with_config`] — `result` is otherwise unused; the
///    vote itself comes entirely from `aligned`).
/// 2. The segment's duration is at least `cfg.min_segment_sec`.
/// 3. The winning speaker index holds at least `cfg.min_coverage` of the
///    words in the segment, with a strict majority — a tie for first
///    place abstains to bare `others`.
///
/// Candidates are the same as for [`relabel_others`]: unpinned bare
/// `others` plus unpinned stale pure-numeric `others:<N>` from a previous
/// run. `me`, `unknown`, `speaker_pinned`, and user-minted `others:m<N>`
/// segments are never touched; candidates with no words inside them are
/// returned unchanged. Index-to-label mapping is the same deterministic
/// 1-based mapping as [`relabel_others`]: index `0` becomes `others:1`, via
/// [`Speaker::others_id`]. The indices in `aligned` are used as-is, so the
/// caller must have aligned words against an already-compacted result (see
/// [`compact_speaker_indices`]) for the labels to come out dense.
pub fn relabel_others_word_level(
    transcript: &Transcript,
    result: &DiarizeResult,
    aligned: &[(Word, Option<u32>)],
    cfg: &DiarizeConfig,
) -> Transcript {
    if result.num_speakers < 2 {
        return transcript.clone();
    }

    let segments = transcript
        .segments
        .iter()
        .map(|segment| relabel_segment_word_level(segment, aligned, cfg))
        .collect();

    Transcript { segments }
}

/// Single-segment vote used by [`relabel_others_word_level`]: returns the
/// segment unchanged (cloned) when any condition of that function's
/// confidence rule fails. Only the `speaker` field is ever replaced; `text`
/// and every other field are preserved verbatim.
fn relabel_segment_word_level(
    segment: &TranscriptSegment,
    aligned: &[(Word, Option<u32>)],
    cfg: &DiarizeConfig,
) -> TranscriptSegment {
    // Same candidate gate as `relabel_segment_with_config`: bare `others` or
    // stale `others:<N>`, so `me` / `unknown` / `others:m<N>` / pinned are
    // untouched.
    if !is_relabel_candidate(segment) {
        return segment.clone();
    }

    let duration = segment.end_sec - segment.start_sec;
    if duration < cfg.min_segment_sec {
        return segment.clone();
    }

    match word_majority_index(segment, aligned, cfg) {
        Some(index) => TranscriptSegment {
            speaker: Speaker::others_id(&(index + 1).to_string()),
            ..segment.clone()
        },
        None => segment.clone(),
    }
}

/// Strict word-majority lookup used by [`relabel_segment_word_level`]:
/// the speaker index holding the most in-segment word votes, when that
/// count covers at least `cfg.min_coverage` of all words whose midpoint
/// falls in `segment`'s `[start_sec, end_sec)` span. `None` on zero words,
/// on a tie for first place, or when the winner's share is below coverage.
fn word_majority_index(
    segment: &TranscriptSegment,
    aligned: &[(Word, Option<u32>)],
    cfg: &DiarizeConfig,
) -> Option<u32> {
    let mut votes: HashMap<u32, usize> = HashMap::new();
    let mut total: usize = 0;
    for (word, speaker) in aligned {
        let mid = (word.start_sec + word.end_sec) / 2.0;
        if mid >= segment.start_sec && mid < segment.end_sec {
            total += 1;
            if let Some(index) = speaker {
                *votes.entry(*index).or_insert(0) += 1;
            }
        }
    }
    if total == 0 {
        return None;
    }

    let mut best_index: Option<u32> = None;
    let mut best_count: usize = 0;
    let mut tied = false;
    for (index, count) in votes {
        if count > best_count {
            best_index = Some(index);
            best_count = count;
            tied = false;
        } else if count == best_count {
            tied = true;
        }
    }
    let winner = best_index.filter(|_| !tied)?;
    if best_count as f32 / total as f32 >= cfg.min_coverage {
        Some(winner)
    } else {
        None
    }
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
            suspect_reasons: Vec::new(),
            original_text: None,
            edited: false,
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
            suspect_reasons: Vec::new(),
            original_text: None,
            edited: false,
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
            suspect_reasons: Vec::new(),
            original_text: None,
            edited: false,
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
            suspect_reasons: Vec::new(),
            original_text: None,
            edited: false,
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

    // ---- full_text preservation lock: relabeling never changes text -------

    fn text_segment(
        text: &str,
        start_sec: f32,
        end_sec: f32,
        speaker: Speaker,
        speaker_pinned: bool,
    ) -> TranscriptSegment {
        TranscriptSegment {
            start_sec,
            end_sec,
            text: text.to_string(),
            speaker,
            speaker_pinned,
            suspect_reasons: Vec::new(),
            original_text: None,
            edited: false,
        }
    }

    #[test]
    fn relabel_preserves_full_text_for_empty_transcript() {
        let transcript = Transcript::default();
        let result = DiarizeResult {
            num_speakers: 2,
            segments: vec![dia(0.0, 2.0, 0)],
        };

        let relabeled = relabel_others(&transcript, &result);

        assert_eq!(relabeled.full_text(), transcript.full_text());
    }

    #[test]
    fn relabel_preserves_full_text_for_single_relabelable_segment() {
        let transcript = Transcript::default().with_segment(text_segment(
            "quarterly results look good",
            0.0,
            2.0,
            Speaker::others(),
            false,
        ));
        let result = DiarizeResult {
            num_speakers: 2,
            segments: vec![dia(0.0, 2.0, 0)],
        };

        let relabeled = relabel_others(&transcript, &result);

        assert_eq!(relabeled.segments[0].speaker, Speaker::others_id("1"));
        assert_eq!(relabeled.full_text(), transcript.full_text());
    }

    #[test]
    fn relabel_preserves_full_text_for_pinned_segment() {
        let transcript = Transcript::default().with_segment(text_segment(
            "pinned correction stays",
            0.0,
            2.0,
            Speaker::others(),
            true,
        ));
        let result = DiarizeResult {
            num_speakers: 2,
            segments: vec![dia(0.0, 2.0, 0)],
        };

        let relabeled = relabel_others(&transcript, &result);

        assert_eq!(relabeled.segments[0].speaker, Speaker::others());
        assert_eq!(relabeled.full_text(), transcript.full_text());
    }

    #[test]
    fn relabel_preserves_full_text_for_mixed_speakers() {
        let transcript = Transcript::default()
            .with_segment(text_segment("hello team", 0.0, 2.0, Speaker::me(), false))
            .with_segment(text_segment(
                "status update please",
                2.0,
                4.0,
                Speaker::others(),
                false,
            ))
            .with_segment(text_segment(
                "inaudible crosstalk",
                4.0,
                6.0,
                Speaker::unknown(),
                false,
            ));
        let result = DiarizeResult {
            num_speakers: 2,
            segments: vec![dia(2.0, 4.0, 1)],
        };

        let relabeled = relabel_others(&transcript, &result);

        assert_eq!(relabeled.full_text(), transcript.full_text());
    }

    #[test]
    fn relabel_preserves_full_text_for_fifty_fifty_split() {
        let transcript = Transcript::default().with_segment(text_segment(
            "split decision debate",
            0.0,
            2.0,
            Speaker::others(),
            false,
        ));
        let result = DiarizeResult {
            num_speakers: 2,
            segments: vec![dia(0.0, 1.0, 0), dia(1.0, 2.0, 1)],
        };

        let relabeled = relabel_others(&transcript, &result);

        assert_eq!(relabeled.segments[0].speaker, Speaker::others());
        assert_eq!(relabeled.full_text(), transcript.full_text());
    }

    #[test]
    fn relabel_preserves_full_text_for_full_coverage() {
        let transcript = Transcript::default()
            .with_segment(text_segment(
                "first speaker point",
                0.0,
                2.0,
                Speaker::others(),
                false,
            ))
            .with_segment(text_segment(
                "second speaker rebuttal",
                2.0,
                4.0,
                Speaker::others(),
                false,
            ));
        let result = DiarizeResult {
            num_speakers: 2,
            segments: vec![dia(0.0, 2.0, 0), dia(2.0, 4.0, 1)],
        };

        let relabeled = relabel_others(&transcript, &result);

        assert_eq!(relabeled.segments[0].speaker, Speaker::others_id("1"));
        assert_eq!(relabeled.segments[1].speaker, Speaker::others_id("2"));
        assert_eq!(relabeled.full_text(), transcript.full_text());
    }

    #[test]
    fn relabel_never_mutates_input_transcript_clone_compare() {
        let transcript = Transcript::default()
            .with_segment(text_segment("hello team", 0.0, 2.0, Speaker::me(), false))
            .with_segment(text_segment(
                "status update please",
                2.0,
                4.0,
                Speaker::others(),
                false,
            ));
        let snapshot = transcript.clone();
        let result = DiarizeResult {
            num_speakers: 2,
            segments: vec![dia(2.0, 4.0, 1)],
        };

        let _ = relabel_others(&transcript, &result);

        assert_eq!(transcript, snapshot, "input transcript must be unchanged");
        assert_eq!(transcript.full_text(), snapshot.full_text());
    }

    // ---- word-level majority vote ------------------------------------------

    fn aligned_word(
        text: &str,
        start_sec: f32,
        end_sec: f32,
        speaker: Option<u32>,
    ) -> (Word, Option<u32>) {
        (
            Word {
                text: text.to_string(),
                start_sec,
                end_sec,
            },
            speaker,
        )
    }

    fn word_level_result(num_speakers: u32) -> DiarizeResult {
        DiarizeResult {
            num_speakers,
            segments: vec![],
        }
    }

    #[test]
    fn word_vote_majority_wins_and_becomes_others_n() {
        let transcript = Transcript::default().with_segment(text_segment(
            "quarterly results look good",
            0.0,
            4.0,
            Speaker::others(),
            false,
        ));
        // 3 of 4 in-segment words vote speaker 1 -> 75% >= 0.70 coverage.
        let aligned = vec![
            aligned_word("quarterly", 0.0, 1.0, Some(1)),
            aligned_word("results", 1.0, 2.0, Some(1)),
            aligned_word("look", 2.0, 3.0, Some(1)),
            aligned_word("good", 3.0, 4.0, Some(0)),
        ];

        let relabeled = relabel_others_word_level(
            &transcript,
            &word_level_result(2),
            &aligned,
            &DiarizeConfig::default(),
        );

        assert_eq!(relabeled.segments[0].speaker, Speaker::others_id("2"));
        assert_eq!(relabeled.full_text(), transcript.full_text());
    }

    #[test]
    fn word_vote_tie_abstains_to_bare_others() {
        let transcript = Transcript::default().with_segment(text_segment(
            "split decision debate today",
            0.0,
            4.0,
            Speaker::others(),
            false,
        ));
        // 2 vs 2: a strict-majority tie must abstain even under a lenient
        // coverage threshold that a bare share check would pass.
        let aligned = vec![
            aligned_word("split", 0.0, 1.0, Some(0)),
            aligned_word("decision", 1.0, 2.0, Some(0)),
            aligned_word("debate", 2.0, 3.0, Some(1)),
            aligned_word("today", 3.0, 4.0, Some(1)),
        ];
        let cfg = DiarizeConfig {
            min_coverage: 0.4,
            ..DiarizeConfig::default()
        };

        let relabeled =
            relabel_others_word_level(&transcript, &word_level_result(2), &aligned, &cfg);

        assert_eq!(relabeled.segments[0].speaker, Speaker::others());
        assert_eq!(relabeled.full_text(), transcript.full_text());
    }

    #[test]
    fn word_vote_short_final_abstains_despite_unanimous_words() {
        let transcript = Transcript::default().with_segment(text_segment(
            "hi",
            0.0,
            0.5,
            Speaker::others(),
            false,
        ));
        let aligned = vec![aligned_word("hi", 0.0, 0.5, Some(0))];

        let relabeled = relabel_others_word_level(
            &transcript,
            &word_level_result(2),
            &aligned,
            &DiarizeConfig::default(),
        );

        assert_eq!(relabeled.segments[0].speaker, Speaker::others());
        assert_eq!(relabeled.full_text(), transcript.full_text());
    }

    #[test]
    fn word_vote_never_changes_text_and_leaves_non_others_untouched() {
        let transcript = Transcript::default()
            .with_segment(text_segment("hello team", 0.0, 2.0, Speaker::me(), false))
            .with_segment(text_segment(
                "status update please",
                2.0,
                4.0,
                Speaker::others(),
                false,
            ));
        let snapshot = transcript.clone();
        // Words inside the `me` segment vote unanimously, but `me` must
        // never be relabeled; the `others` segment has no words at all.
        let aligned = vec![
            aligned_word("hello", 0.0, 1.0, Some(1)),
            aligned_word("team", 1.0, 2.0, Some(1)),
        ];

        let relabeled = relabel_others_word_level(
            &transcript,
            &word_level_result(2),
            &aligned,
            &DiarizeConfig::default(),
        );

        assert_eq!(relabeled.segments[0].speaker, Speaker::me());
        assert_eq!(relabeled.segments[1].speaker, Speaker::others());
        assert_eq!(relabeled.full_text(), snapshot.full_text());
        assert_eq!(transcript, snapshot, "input transcript must be unchanged");
    }

    // ---- recall tuning: short turns + split coverage relabel via defaults --

    #[test]
    fn short_confirmation_at_default_floor_now_relabels_with_text_locked() {
        // 0.8 s >= default 0.75 s `min_segment_sec`: short confirmations
        // ("yes", "agreed") relabel instead of abstaining. Uses
        // `relabel_others` (which reads `DiarizeConfig::default()`) so the
        // default itself is under test, not a hand-built threshold.
        let transcript = Transcript::default().with_segment(text_segment(
            "yes agreed",
            0.0,
            0.8,
            Speaker::others(),
            false,
        ));
        let before = transcript.full_text();
        let result = DiarizeResult {
            num_speakers: 2,
            segments: vec![dia(0.0, 0.8, 0)],
        };

        let relabeled = relabel_others(&transcript, &result);

        assert_eq!(relabeled.segments[0].speaker, Speaker::others_id("1"));
        assert_eq!(relabeled.full_text(), before);
    }

    #[test]
    fn split_coverage_at_default_floor_now_relabels_with_text_locked() {
        // Speaker index 1 covers 1.2 s of a 2.0 s segment == 60% >= default
        // 0.60 `min_coverage`: split-coverage turns recover. A 50/50 split
        // still abstains (pinned by
        // `a_fifty_fifty_coverage_split_between_two_speakers_stays_bare_others`).
        // Uses `relabel_others` so the default itself is under test.
        let transcript = Transcript::default().with_segment(text_segment(
            "status update please",
            0.0,
            2.0,
            Speaker::others(),
            false,
        ));
        let before = transcript.full_text();
        let result = DiarizeResult {
            num_speakers: 2,
            segments: vec![dia(0.0, 0.8, 0), dia(0.8, 2.0, 1)],
        };

        let relabeled = relabel_others(&transcript, &result);

        assert_eq!(relabeled.segments[0].speaker, Speaker::others_id("2"));
        assert_eq!(relabeled.full_text(), before);
    }

    // ---- sparse cluster ids compact to dense 1-based labels ----------------

    #[test]
    fn sparse_speaker_indices_compact_to_dense_one_based_labels() {
        // sherpa-onnx's `num_speakers` is a distinct count of surviving
        // clusters, while `speaker_index` is the raw cluster column id —
        // short clusters get dropped, so surviving ids are sparse. Two
        // speakers at raw ids `0` and `170` must label as `others:1` and
        // `others:2`, never `others:171`.
        let transcript = Transcript::default()
            .with_segment(others_segment(0.0, 2.0))
            .with_segment(others_segment(2.0, 4.0));
        let result = DiarizeResult {
            num_speakers: 2,
            segments: vec![dia(0.0, 2.0, 0), dia(2.0, 4.0, 170)],
        };

        let relabeled = relabel_others(&transcript, &result);

        assert_eq!(relabeled.segments[0].speaker, Speaker::others_id("1"));
        assert_eq!(relabeled.segments[1].speaker, Speaker::others_id("2"));
    }
}
