//! Pure suspect-segment scorer: flags decoded segments that look like
//! hallucinations, drift, or garbage without any model call or I/O.
//!
//! The offline recognizer exposes text, tokens, and timestamps only — no
//! per-token confidence (see [`crate::engine`]) — so this module scores a
//! segment from what a confidence score would have been built on: the
//! surface text, the [`Word`] timing from [`crate::detokenize`], the
//! segment's RMS energy, and its duration in seconds. Every threshold is a
//! named constant documented below. Callers decide what to do with the
//! reasons (mark for review, drop, re-decode); this module never touches
//! the decode path itself.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::detokenize::Word;

/// Why a decoded segment looks suspect. All variants are hints from
/// signal/text heuristics — never a model judgement — so a reason being
/// present means "worth review", not "definitely wrong".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SuspectReason {
    /// The same word (or tiny vocabulary) repeats over and over — the
    /// classic transducer repetition loop, where the autoregressive
    /// prediction network latches onto one attractor and emits it until
    /// the segment ends.
    RepetitionLoop,
    /// The segment is longer than the decode window proven safe against
    /// Parakeet-TDT v3's French→English drift (see
    /// [`DRIFT_RISK_SEGMENT_SEC`]). Parakeet has no language pin, so a
    /// long single-window decode can settle into the wrong language and
    /// stay there; this is a length-based risk hint, not a detector.
    LanguageDriftHint,
    /// The segment's RMS energy is below speech level — the decoder ran
    /// on near-silence, so any non-empty text it produced is almost
    /// certainly hallucinated.
    LowSpeechEnergy,
    /// Word timing is physically implausible: negative/zero-length words,
    /// words far shorter or longer than a human syllable-to-word span,
    /// overlapping words, words outside the segment bounds, or far more
    /// words per second than anyone speaks.
    TimingAnomaly,
    /// The text/length relationship is degenerate: empty text, a
    /// non-positive segment duration, text with no word timing at all, or
    /// far more characters per second than speech can carry.
    DegenerateLength,
}

/// Minimum RMS energy (linear, full-scale sine == ~0.707) below which
/// audio counts as near-silence rather than speech. A 16-bit-normalized
/// quiet room sits around `0.001–0.003`; `0.005` leaves margin above that
/// floor while still catching whispered-but-real speech above it. Segments
/// under this with non-empty text are hallucination candidates.
pub const MIN_SPEECH_RMS_ENERGY: f32 = 0.005;

/// Segment duration, in seconds, above which a single decode window is at
/// risk of Parakeet-TDT v3 language drift. Mirrors the streaming cap that
/// fixed the production French→English drift bug (production windows at
/// ~7s drifted while every window at or under 5.46s decoded correctly, so
/// the cap — and this hint — is pinned at `5.0`; see the
/// `MAX_DECODE_CHUNK_SEC` docs in [`crate::stream`]).
pub const DRIFT_RISK_SEGMENT_SEC: f32 = 5.0;

/// Consecutive repetitions of one normalized word that flag
/// [`SuspectReason::RepetitionLoop`]. Human emphasis tops out at two or
/// three ("no no no"); four identical words in a row never occurs in
/// natural meeting speech but is the standard shape of a transducer loop.
pub const REPETITION_CONSECUTIVE_WORDS: usize = 4;

/// Minimum word count before the unique-vocabulary-ratio check applies.
/// Below this, a legitimately repetitive short confirmation ("yes yes
/// yes") would false-positive; at or above it there is enough material
/// for the ratio to mean something.
pub const REPETITION_MIN_WORDS: usize = 6;

/// Maximum unique-to-total word ratio (after case/punctuation
/// normalization) before a long-enough segment flags
/// [`SuspectReason::RepetitionLoop`]. Catches loops that alternate two
/// attractors ("yes no yes no …", ratio `0.25`) rather than repeating one
/// word, while ordinary speech — even repetitive meeting filler — stays
/// well above `0.34`.
pub const REPETITION_MAX_UNIQUE_RATIO: f32 = 0.34;

/// Shortest plausible word duration, in seconds. A single clipped
/// syllable can approach `0.05s`, but anything at or under `0.02s` is a
/// timestamp glitch, not speech.
pub const MIN_WORD_DURATION_SEC: f32 = 0.02;

/// Longest plausible single-word duration, in seconds. Even a slowly
/// drawn-out word rarely exceeds `1.5s`; `2.5s` gives generous margin
/// while still catching a word whose end timestamp ran away to the
/// segment boundary.
pub const MAX_WORD_DURATION_SEC: f32 = 2.5;

/// Largest overlap, in seconds, tolerated between one word's end and the
/// next word's start before flagging [`SuspectReason::TimingAnomaly`].
/// Detokenized words abut (the next piece's start is the previous piece's
/// end plus rounding), so a small epsilon absorbs float noise without
/// hiding genuine timestamp disorder.
pub const WORD_OVERLAP_TOLERANCE_SEC: f32 = 0.02;

/// Slack, in seconds, allowed between a word's timing and the segment
/// bounds before flagging [`SuspectReason::TimingAnomaly`]. Word timings
/// come from per-token timestamps that can lead/lag the VAD cut by a few
/// frames, so exact containment is too strict; half a second covers that
/// jitter while catching words stamped wholly outside their segment.
pub const WORD_SEGMENT_SLACK_SEC: f32 = 0.5;

/// Maximum plausible sustained speaking rate, in words per second.
/// Conversational speech runs `2–3` w/s; rapid speech peaks near `5`.
/// `6.0` sits above any real speaker and below the dense word salad a
/// runaway decode emits.
pub const MAX_WORDS_PER_SECOND: f32 = 6.0;

/// Maximum plausible text density, in characters per second (on trimmed
/// text). English averages ~5 characters per word at ~2.5 words per
/// second, i.e. ~15 chars/s; `60.0` is 4x that — unreachable by speech,
/// routine for a degenerate dump.
pub const DEGENERATE_MAX_CHARS_PER_SEC: f32 = 60.0;

/// Scores one decoded segment, returning every [`SuspectReason`] that
/// fires (possibly empty for a clean segment, in enum-declaration order).
/// Pure: no I/O, no model calls, no global state.
///
/// - `text`: the segment's decoded text.
/// - `words`: detokenized words with `start_sec`/`end_sec` timing
///   relative to the segment start (see [`crate::detokenize`]).
/// - `rms_energy`: the segment audio's root-mean-square amplitude
///   (linear, `1.0` == full scale).
/// - `seg_len_sec`: the segment's duration in seconds.
pub fn score_segment(
    text: &str,
    words: &[Word],
    rms_energy: f32,
    seg_len_sec: f32,
) -> Vec<SuspectReason> {
    let mut reasons = Vec::new();

    if is_repetition_loop(words) {
        reasons.push(SuspectReason::RepetitionLoop);
    }
    if is_language_drift_risk(text, seg_len_sec) {
        reasons.push(SuspectReason::LanguageDriftHint);
    }
    if is_low_speech_energy(rms_energy) {
        reasons.push(SuspectReason::LowSpeechEnergy);
    }
    if is_timing_anomaly(words, seg_len_sec) {
        reasons.push(SuspectReason::TimingAnomaly);
    }
    if is_degenerate_length(text, words, seg_len_sec) {
        reasons.push(SuspectReason::DegenerateLength);
    }

    reasons
}

/// Normalizes a word for repetition comparison: lowercase with leading
/// and trailing non-alphanumeric characters (punctuation, whitespace)
/// stripped, so `"No,"`, `"no"`, and `"NO"` count as the same word.
/// Returns an empty string for punctuation-only input, which callers skip.
fn normalize_word(text: &str) -> String {
    text.trim()
        .trim_matches(|c: char| !c.is_alphanumeric())
        .to_lowercase()
}

/// Reports whether `words` show a repetition loop: either
/// [`REPETITION_CONSECUTIVE_WORDS`] identical normalized words in a row,
/// or — for segments of at least [`REPETITION_MIN_WORDS`] words — a
/// unique-to-total ratio at or under [`REPETITION_MAX_UNIQUE_RATIO`].
fn is_repetition_loop(words: &[Word]) -> bool {
    let normalized: Vec<String> = words
        .iter()
        .map(|word| normalize_word(&word.text))
        .filter(|word| !word.is_empty())
        .collect();

    if normalized.is_empty() {
        return false;
    }

    let mut run_len = 1usize;
    for pair in normalized.windows(2) {
        if pair[0] == pair[1] {
            run_len += 1;
            if run_len >= REPETITION_CONSECUTIVE_WORDS {
                return true;
            }
        } else {
            run_len = 1;
        }
    }

    if normalized.len() >= REPETITION_MIN_WORDS {
        let unique: HashSet<&str> = normalized.iter().map(String::as_str).collect();
        let ratio = unique.len() as f32 / normalized.len() as f32;
        if ratio <= REPETITION_MAX_UNIQUE_RATIO {
            return true;
        }
    }

    false
}

/// Reports whether the segment carries language-drift risk: longer than
/// [`DRIFT_RISK_SEGMENT_SEC`] with non-empty text. Length is the only
/// signal available without a language ID model, so this is deliberately
/// a risk hint (see [`SuspectReason::LanguageDriftHint`]).
fn is_language_drift_risk(text: &str, seg_len_sec: f32) -> bool {
    !text.trim().is_empty() && seg_len_sec > DRIFT_RISK_SEGMENT_SEC
}

/// Reports whether `rms_energy` is finite and below
/// [`MIN_SPEECH_RMS_ENERGY`]. Non-finite energy means the measurement
/// itself is broken, not that the audio is quiet, so it does not flag.
fn is_low_speech_energy(rms_energy: f32) -> bool {
    rms_energy.is_finite() && rms_energy < MIN_SPEECH_RMS_ENERGY
}

/// Reports whether any word timing is implausible (see
/// [`SuspectReason::TimingAnomaly`]). Empty word lists carry no timing to
/// judge, so they do not flag here ([`SuspectReason::DegenerateLength`]
/// owns the no-words case).
fn is_timing_anomaly(words: &[Word], seg_len_sec: f32) -> bool {
    if words.is_empty() {
        return false;
    }

    let mut prev_end: Option<f32> = None;
    for word in words {
        if !word.start_sec.is_finite() || !word.end_sec.is_finite() {
            return true;
        }
        let duration = word.end_sec - word.start_sec;
        if duration < MIN_WORD_DURATION_SEC || duration > MAX_WORD_DURATION_SEC {
            return true;
        }
        if word.start_sec < -WORD_SEGMENT_SLACK_SEC
            || word.end_sec > seg_len_sec + WORD_SEGMENT_SLACK_SEC
        {
            return true;
        }
        if let Some(prev) = prev_end {
            if word.start_sec < prev - WORD_OVERLAP_TOLERANCE_SEC {
                return true;
            }
        }
        prev_end = Some(word.end_sec);
    }

    if seg_len_sec > 0.0 && seg_len_sec.is_finite() {
        let rate = words.len() as f32 / seg_len_sec;
        if rate > MAX_WORDS_PER_SECOND {
            return true;
        }
    }

    false
}

/// Reports whether the text/length relationship is degenerate: empty
/// text, a non-positive or non-finite duration, non-empty text with no
/// word timing, or text denser than [`DEGENERATE_MAX_CHARS_PER_SEC`].
fn is_degenerate_length(text: &str, words: &[Word], seg_len_sec: f32) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return true;
    }
    if !seg_len_sec.is_finite() || seg_len_sec <= 0.0 {
        return true;
    }
    if words.is_empty() {
        return true;
    }
    let density = trimmed.chars().count() as f32 / seg_len_sec;
    density > DEGENERATE_MAX_CHARS_PER_SEC
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(text: &str, start_sec: f32, end_sec: f32) -> Word {
        Word {
            text: text.to_string(),
            start_sec,
            end_sec,
        }
    }

    fn clean_words() -> Vec<Word> {
        vec![
            word("hello", 0.0, 0.4),
            word("how", 0.5, 0.8),
            word("are", 0.9, 1.1),
            word("you", 1.2, 1.5),
        ]
    }

    #[test]
    fn clean_segment_scores_no_reasons() {
        let reasons = score_segment("hello how are you", &clean_words(), 0.05, 2.0);

        assert!(reasons.is_empty());
    }

    #[test]
    fn consecutive_repeated_word_flags_repetition_loop() {
        let words = vec![
            word("no", 0.0, 0.3),
            word("no", 0.3, 0.6),
            word("no", 0.6, 0.9),
            word("no", 0.9, 1.2),
        ];

        let reasons = score_segment("no no no no", &words, 0.05, 1.5);

        assert!(reasons.contains(&SuspectReason::RepetitionLoop));
    }

    #[test]
    fn alternating_two_word_loop_flags_repetition_loop_via_unique_ratio() {
        let words = vec![
            word("yes", 0.0, 0.3),
            word("no", 0.3, 0.6),
            word("yes", 0.6, 0.9),
            word("no", 0.9, 1.2),
            word("yes", 1.2, 1.5),
            word("no", 1.5, 1.8),
        ];

        let reasons = score_segment("yes no yes no yes no", &words, 0.05, 2.0);

        assert!(reasons.contains(&SuspectReason::RepetitionLoop));
    }

    #[test]
    fn long_segment_with_text_flags_language_drift_hint() {
        let words = vec![
            word("this", 0.0, 0.4),
            word("meeting", 0.5, 1.0),
            word("ran", 5.5, 5.8),
            word("long", 6.0, 6.4),
        ];

        let reasons = score_segment("this meeting ran long", &words, 0.05, 7.0);

        assert!(reasons.contains(&SuspectReason::LanguageDriftHint));
    }

    #[test]
    fn short_segment_does_not_flag_language_drift_hint() {
        let reasons = score_segment("hello how are you", &clean_words(), 0.05, 2.0);

        assert!(!reasons.contains(&SuspectReason::LanguageDriftHint));
    }

    #[test]
    fn quiet_audio_flags_low_speech_energy() {
        let reasons = score_segment("hello how are you", &clean_words(), 0.001, 2.0);

        assert!(reasons.contains(&SuspectReason::LowSpeechEnergy));
    }

    #[test]
    fn overlapping_words_flag_timing_anomaly() {
        let words = vec![word("hello", 0.0, 0.8), word("there", 0.3, 0.9)];

        let reasons = score_segment("hello there", &words, 0.05, 1.5);

        assert!(reasons.contains(&SuspectReason::TimingAnomaly));
    }

    #[test]
    fn impossibly_short_word_flags_timing_anomaly() {
        let words = vec![word("hello", 0.5, 0.505), word("there", 0.6, 0.9)];

        let reasons = score_segment("hello there", &words, 0.05, 1.5);

        assert!(reasons.contains(&SuspectReason::TimingAnomaly));
    }

    #[test]
    fn absurd_word_rate_flags_timing_anomaly() {
        let words: Vec<Word> = (0..20)
            .map(|i| {
                let start = i as f32 * 0.04;
                word("w", start, start + 0.03)
            })
            .collect();

        let reasons = score_segment("w w w w", &words, 0.05, 1.0);

        assert!(reasons.contains(&SuspectReason::TimingAnomaly));
    }

    #[test]
    fn empty_text_flags_degenerate_length() {
        let reasons = score_segment("   ", &[], 0.001, 2.0);

        assert!(reasons.contains(&SuspectReason::DegenerateLength));
    }

    #[test]
    fn text_without_word_timing_flags_degenerate_length() {
        let reasons = score_segment("hello there", &[], 0.05, 1.5);

        assert!(reasons.contains(&SuspectReason::DegenerateLength));
    }

    #[test]
    fn reasons_come_back_in_enum_declaration_order() {
        let words = vec![
            word("no", 0.0, 0.3),
            word("no", 0.3, 0.6),
            word("no", 0.6, 0.9),
            word("no", 0.9, 1.2),
        ];

        let reasons = score_segment("no no no no", &words, 0.001, 7.0);

        let expected = vec![
            SuspectReason::RepetitionLoop,
            SuspectReason::LanguageDriftHint,
            SuspectReason::LowSpeechEnergy,
        ];
        assert_eq!(reasons, expected);
    }
}
