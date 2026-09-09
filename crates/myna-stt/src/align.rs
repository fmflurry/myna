//! Pure word-to-diarization alignment.
//!
//! Assigns each detokenized [`Word`] (see [`crate::detokenize`], shared via
//! [`crate::engine::SttEngine::transcribe_samples_words`]) to the
//! [`DiarizeSegment`](crate::diarize::DiarizeSegment) it overlaps most, by
//! wall-clock overlap in seconds. Words with zero overlap against every
//! segment map to [`None`] (silence gaps, out-of-range timing).
//!
//! Pure: no I/O, no sherpa calls. Label decisions (speaker_index -> role)
//! happen downstream.

use crate::detokenize::Word;
use crate::diarize::DiarizeSegment;

/// Aligns each word to a diarization speaker by maximum temporal overlap.
///
/// Returns one `(word, speaker)` pair per input word, in input order, where
/// `speaker` is the `speaker_index` of the segment with the largest overlap
/// `min(word.end, seg.end) - max(word.start, seg.start)`, or [`None`] when
/// the word overlaps no segment. Ties resolve to the earliest segment in
/// `segs` order.
pub fn align_words_to_diar(words: &[Word], segs: &[DiarizeSegment]) -> Vec<(Word, Option<u32>)> {
    words
        .iter()
        .map(|word| {
            let mut best: Option<(f32, u32)> = None;
            for seg in segs {
                let overlap = overlap_sec(word.start_sec, word.end_sec, seg.start_sec, seg.end_sec);
                if overlap > 0.0 && best.is_none_or(|(best_overlap, _)| overlap > best_overlap) {
                    best = Some((overlap, seg.speaker_index));
                }
            }
            (word.clone(), best.map(|(_, speaker)| speaker))
        })
        .collect()
}

/// Overlap in seconds of `[a_start, a_end)` with `[b_start, b_end)`; `0.0`
/// when they merely touch or when either interval is empty/inverted.
fn overlap_sec(a_start: f32, a_end: f32, b_start: f32, b_end: f32) -> f32 {
    (a_end.min(b_end) - a_start.max(b_start)).max(0.0)
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

    fn seg(start_sec: f32, end_sec: f32, speaker_index: u32) -> DiarizeSegment {
        DiarizeSegment {
            start_sec,
            end_sec,
            speaker_index,
        }
    }

    #[test]
    fn assigns_word_to_max_overlap_segment() {
        // Arrange: word straddles two speakers, mostly in speaker 1.
        let words = vec![word("hello", 0.8, 1.5)];
        let segs = vec![seg(0.0, 1.0, 0), seg(1.0, 2.0, 1)];

        // Act
        let aligned = align_words_to_diar(&words, &segs);

        // Assert
        assert_eq!(aligned.len(), 1);
        assert_eq!(aligned[0].0.text, "hello");
        assert_eq!(aligned[0].1, Some(1));
    }

    #[test]
    fn returns_none_for_gap_words_with_zero_overlap() {
        // Arrange: word sits in silence between two segments.
        let words = vec![word("hi", 1.0, 1.5)];
        let segs = vec![seg(0.0, 1.0, 0), seg(2.0, 3.0, 1)];

        // Act
        let aligned = align_words_to_diar(&words, &segs);

        // Assert
        assert_eq!(aligned[0].1, None);
    }

    #[test]
    fn touching_boundary_counts_as_zero_overlap() {
        // Arrange: word starts exactly where the segment ends.
        let words = vec![word("edge", 1.0, 1.5)];
        let segs = vec![seg(0.0, 1.0, 0)];

        // Act
        let aligned = align_words_to_diar(&words, &segs);

        // Assert
        assert_eq!(aligned[0].1, None);
    }

    #[test]
    fn tie_resolves_to_earliest_segment() {
        // Arrange: word overlaps both speakers equally (0.5s each).
        let words = vec![word("tied", 0.5, 1.5)];
        let segs = vec![seg(0.0, 1.0, 3), seg(1.0, 2.0, 7)];

        // Act
        let aligned = align_words_to_diar(&words, &segs);

        // Assert
        assert_eq!(aligned[0].1, Some(3));
    }

    #[test]
    fn empty_segments_yield_none_for_every_word() {
        // Arrange
        let words = vec![word("a", 0.0, 0.5), word("b", 0.5, 1.0)];

        // Act
        let aligned = align_words_to_diar(&words, &[]);

        // Assert
        assert!(aligned.iter().all(|(_, speaker)| speaker.is_none()));
        assert_eq!(aligned.len(), 2);
    }

    #[test]
    fn preserves_input_order_and_word_timing() {
        // Arrange: words out of time order still map positionally.
        let words = vec![word("late", 5.0, 5.5), word("early", 0.0, 0.5)];
        let segs = vec![seg(0.0, 1.0, 0), seg(5.0, 6.0, 1)];

        // Act
        let aligned = align_words_to_diar(&words, &segs);

        // Assert
        assert_eq!(aligned[0].1, Some(1));
        assert_eq!(aligned[1].1, Some(0));
        assert_eq!(aligned[0].0.start_sec, 5.0);
    }
}
