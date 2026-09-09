//! Pure diarization quality metrics over [`DiarizeResult`] fixtures.
//!
//! No models, no I/O, no sherpa calls — frame-sampling math only, so the
//! relabeling confidence rule and future clustering changes stay
//! unit-testable without downloading artifacts.
//!
//! All metrics sample speaker activity at [`FRAME_RATE_HZ`] (10 Hz): the
//! scored span is `[0, max(reference.end, hypothesis.end))`, and the label
//! of frame `i` is the segment covering its midpoint
//! `(i + 0.5) / FRAME_RATE_HZ` (`[start_sec, end_sec)`, first match wins).
//!
//! * [`der_proxy`]: frame-level diarization error rate under the optimal
//!   1-to-1 hypothesis-to-reference speaker mapping (exhaustive search —
//!   exact for the small speaker counts diarization produces):
//!   `(false_alarm + missed + confusion) / reference_speech_frames`.
//!   False alarm and missed time are mapping-independent; confusion is
//!   minimized over injective mappings, so a pure label permutation still
//!   scores `0.0`. A "proxy" because collar handling and overlapping-speech
//!   weighting of the NIST DER are out of scope.
//! * [`jer_proxy`]: mean over reference speakers of `1 - max IoU` against
//!   any single hypothesis speaker (independent best-match per reference
//!   speaker, not a global Hungarian assignment — hence "proxy").
//! * [`overlap_f1`]: speech-activity F1 ignoring speaker labels
//!   (`2PR / (P + R)` over speech/non-speech frames).
//!
//! Empty-reference edges: DER is `0.0` when both sides are silent and `1.0`
//! when the hypothesis invents speech from nothing; JER mirrors that; F1 is
//! `1.0` when both are silent and `0.0` when exactly one side speaks.

use std::collections::{HashMap, HashSet};

use crate::diarize::DiarizeResult;

/// Frame-sampling rate for all metrics in this module.
pub const FRAME_RATE_HZ: f32 = 10.0;

/// The three proxy metrics for one reference/hypothesis pair. See
/// [`evaluate`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DiarizeMetrics {
    /// See [`der_proxy`].
    pub der_proxy: f32,
    /// See [`jer_proxy`].
    pub jer_proxy: f32,
    /// See [`overlap_f1`].
    pub overlap_f1: f32,
}

/// Scores `hypothesis` against `reference` on all three proxy metrics.
pub fn evaluate(reference: &DiarizeResult, hypothesis: &DiarizeResult) -> DiarizeMetrics {
    DiarizeMetrics {
        der_proxy: der_proxy(reference, hypothesis),
        jer_proxy: jer_proxy(reference, hypothesis),
        overlap_f1: overlap_f1(reference, hypothesis),
    }
}

/// Frame-level diarization error rate under the optimal injective
/// hypothesis-to-reference speaker mapping.
///
/// `(false_alarm + missed + confusion) / reference_speech_frames`, where a
/// frame with hypothesis speech mapped to `None` (or to the wrong reference
/// speaker) counts as confusion when the reference speaks and as false
/// alarm when it is silent. Returns `0.0` when both sides are silent and
/// `1.0` when the reference is silent but the hypothesis is not.
pub fn der_proxy(reference: &DiarizeResult, hypothesis: &DiarizeResult) -> f32 {
    let frames = sample_frames(reference, hypothesis);
    let ref_speech = frames
        .iter()
        .filter(|(reference, _)| reference.is_some())
        .count();
    if ref_speech == 0 {
        return if frames.iter().any(|(_, hyp)| hyp.is_some()) {
            1.0
        } else {
            0.0
        };
    }

    let ref_ids = sorted_unique_ids(reference);
    let hyp_ids = sorted_unique_ids(hypothesis);
    let mapping = best_mapping(&frames, &hyp_ids, &ref_ids);

    let mut false_alarm = 0usize;
    let mut missed = 0usize;
    let mut confusion = 0usize;
    for (reference, hyp) in &frames {
        match (reference, hyp) {
            (None, None) => {}
            (None, Some(_)) => false_alarm += 1,
            (Some(_), None) => missed += 1,
            (Some(ref_id), Some(hyp_id)) => {
                if mapping.get(hyp_id).copied().flatten().as_ref() == Some(ref_id) {
                    // Correctly attributed.
                } else {
                    confusion += 1;
                }
            }
        }
    }

    (false_alarm + missed + confusion) as f32 / ref_speech as f32
}

/// Mean over reference speakers of `1 - IoU` against the single best
/// hypothesis speaker, where `IoU = both / either` in frames.
///
/// Returns `0.0` when the reference is silent and `1.0` when the reference
/// speaks but the hypothesis never overlaps the relevant speaker.
pub fn jer_proxy(reference: &DiarizeResult, hypothesis: &DiarizeResult) -> f32 {
    let frames = sample_frames(reference, hypothesis);
    let ref_ids = sorted_unique_ids(reference);
    if ref_ids.is_empty() {
        return 0.0;
    }
    let hyp_ids = sorted_unique_ids(hypothesis);

    let total: f32 = ref_ids
        .iter()
        .map(|ref_id| {
            let best_iou = hyp_ids
                .iter()
                .map(|hyp_id| iou(&frames, *ref_id, *hyp_id))
                .fold(0.0_f32, f32::max);
            1.0 - best_iou
        })
        .sum();
    total / ref_ids.len() as f32
}

/// Speech-activity F1 ignoring speaker labels: `2PR / (P + R)` with
/// `P = overlap / hypothesis_speech` and `R = overlap / reference_speech`.
///
/// Returns `1.0` when both sides are silent and `0.0` when exactly one side
/// speaks (or when there is no frame overlap).
pub fn overlap_f1(reference: &DiarizeResult, hypothesis: &DiarizeResult) -> f32 {
    let frames = sample_frames(reference, hypothesis);
    let mut overlap = 0usize;
    let mut ref_speech = 0usize;
    let mut hyp_speech = 0usize;
    for (reference, hyp) in &frames {
        if reference.is_some() {
            ref_speech += 1;
        }
        if hyp.is_some() {
            hyp_speech += 1;
        }
        if reference.is_some() && hyp.is_some() {
            overlap += 1;
        }
    }

    if ref_speech == 0 && hyp_speech == 0 {
        return 1.0;
    }
    if overlap == 0 {
        return 0.0;
    }
    let precision = overlap as f32 / hyp_speech as f32;
    let recall = overlap as f32 / ref_speech as f32;
    2.0 * precision * recall / (precision + recall)
}

/// One sampled frame: `(reference_speaker, hypothesis_speaker)`.
type Frame = (Option<u32>, Option<u32>);

/// Samples both results at [`FRAME_RATE_HZ`], labeling each frame by the
/// segment covering its midpoint.
fn sample_frames(reference: &DiarizeResult, hypothesis: &DiarizeResult) -> Vec<Frame> {
    let duration = result_end(reference).max(result_end(hypothesis));
    if duration <= 0.0 {
        return Vec::new();
    }
    let num_frames = (duration * FRAME_RATE_HZ).ceil() as usize;
    (0..num_frames)
        .map(|i| {
            let midpoint = (i as f32 + 0.5) / FRAME_RATE_HZ;
            (
                speaker_at(reference, midpoint),
                speaker_at(hypothesis, midpoint),
            )
        })
        .collect()
}

/// Latest segment end in `result`, or `0.0` when there are no segments.
fn result_end(result: &DiarizeResult) -> f32 {
    result
        .segments
        .iter()
        .map(|segment| segment.end_sec)
        .fold(0.0_f32, f32::max)
}

/// Speaker index covering `t` (`[start_sec, end_sec)`, first match wins),
/// or `None` for silence.
fn speaker_at(result: &DiarizeResult, t: f32) -> Option<u32> {
    result
        .segments
        .iter()
        .find(|segment| segment.start_sec <= t && t < segment.end_sec)
        .map(|segment| segment.speaker_index)
}

/// Sorted unique speaker indices appearing in `result`'s segments.
fn sorted_unique_ids(result: &DiarizeResult) -> Vec<u32> {
    let mut seen: HashSet<u32> = HashSet::new();
    let mut ids: Vec<u32> = result
        .segments
        .iter()
        .map(|segment| segment.speaker_index)
        .filter(|id| seen.insert(*id))
        .collect();
    ids.sort_unstable();
    ids
}

/// Injective hypothesis-to-reference mapping maximizing correctly
/// attributed frames. Each hypothesis speaker maps to at most one reference
/// speaker (or `None`); each reference speaker is claimed at most once.
fn best_mapping(frames: &[Frame], hyp_ids: &[u32], ref_ids: &[u32]) -> HashMap<u32, Option<u32>> {
    let mut best: HashMap<u32, Option<u32>> = hyp_ids.iter().map(|id| (*id, None)).collect();
    // No mapping can beat zero correct when either side is silent.
    if hyp_ids.is_empty() || ref_ids.is_empty() {
        return best;
    }
    let mut current: HashMap<u32, Option<u32>> = best.clone();
    let mut used: HashSet<u32> = HashSet::new();
    let mut best_correct = correct_frames(frames, &current);
    let mut search = MappingSearch {
        frames,
        hyp_ids,
        ref_ids,
        current: &mut current,
        used: &mut used,
        best: &mut best,
        best_correct: &mut best_correct,
    };
    search.run(0);
    best
}

/// Depth-first search over hypothesis speakers, trying each free reference
/// speaker plus `None`, keeping the mapping with the most correct frames.
/// A struct (rather than a free function) keeps the recursive call under
/// clippy's argument-count lint.
struct MappingSearch<'a> {
    frames: &'a [Frame],
    hyp_ids: &'a [u32],
    ref_ids: &'a [u32],
    current: &'a mut HashMap<u32, Option<u32>>,
    used: &'a mut HashSet<u32>,
    best: &'a mut HashMap<u32, Option<u32>>,
    best_correct: &'a mut usize,
}

impl MappingSearch<'_> {
    fn run(&mut self, index: usize) {
        if index == self.hyp_ids.len() {
            let correct = correct_frames(self.frames, self.current);
            if correct > *self.best_correct {
                *self.best_correct = correct;
                *self.best = self.current.clone();
            }
            return;
        }
        let hyp_id = self.hyp_ids[index];
        // Option 1: leave this hypothesis speaker unmapped.
        self.current.insert(hyp_id, None);
        self.run(index + 1);
        // Option 2: claim each still-free reference speaker.
        let free: Vec<u32> = self
            .ref_ids
            .iter()
            .copied()
            .filter(|id| !self.used.contains(id))
            .collect();
        for ref_id in free {
            self.used.insert(ref_id);
            self.current.insert(hyp_id, Some(ref_id));
            self.run(index + 1);
            self.used.remove(&ref_id);
        }
        self.current.insert(hyp_id, None);
    }
}

/// Frames where both sides speak and the mapping pairs them correctly.
fn correct_frames(frames: &[Frame], mapping: &HashMap<u32, Option<u32>>) -> usize {
    frames
        .iter()
        .filter(|(reference, hyp)| match (reference, hyp) {
            (Some(ref_id), Some(hyp_id)) => {
                mapping.get(hyp_id).copied().flatten().as_ref() == Some(ref_id)
            }
            _ => false,
        })
        .count()
}

/// Intersection-over-union, in frames, of one reference speaker against one
/// hypothesis speaker.
fn iou(frames: &[Frame], ref_id: u32, hyp_id: u32) -> f32 {
    let mut both = 0usize;
    let mut either = 0usize;
    for (reference, hyp) in frames {
        let in_ref = *reference == Some(ref_id);
        let in_hyp = *hyp == Some(hyp_id);
        if in_ref || in_hyp {
            either += 1;
            if in_ref && in_hyp {
                both += 1;
            }
        }
    }
    if either == 0 {
        0.0
    } else {
        both as f32 / either as f32
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diarize::DiarizeSegment;

    fn seg(start_sec: f32, end_sec: f32, speaker_index: u32) -> DiarizeSegment {
        DiarizeSegment {
            start_sec,
            end_sec,
            speaker_index,
        }
    }

    fn result(segments: Vec<DiarizeSegment>, num_speakers: u32) -> DiarizeResult {
        DiarizeResult {
            num_speakers,
            segments,
        }
    }

    #[test]
    fn identical_results_score_a_zero_der_proxies() {
        let reference = result(vec![seg(0.0, 1.0, 0), seg(1.0, 2.0, 1)], 2);
        let hypothesis = reference.clone();

        assert_eq!(der_proxy(&reference, &hypothesis), 0.0);
        assert_eq!(jer_proxy(&reference, &hypothesis), 0.0);
        assert_eq!(overlap_f1(&reference, &hypothesis), 1.0);
        assert_eq!(evaluate(&reference, &hypothesis).der_proxy, 0.0);
    }

    #[test]
    fn a_pure_label_permutation_still_scores_a_zero_der() {
        // Optimal mapping absorbs the swap: hyp speaker 1 <-> ref speaker 0.
        let reference = result(vec![seg(0.0, 1.0, 0), seg(1.0, 2.0, 1)], 2);
        let hypothesis = result(vec![seg(0.0, 1.0, 1), seg(1.0, 2.0, 0)], 2);

        assert_eq!(der_proxy(&reference, &hypothesis), 0.0);
    }

    #[test]
    fn half_the_speech_misattributed_scores_a_half_der() {
        // Second half attributed to an extra speaker with no reference
        // counterpart: 10 of 20 frames confused => DER 0.5.
        let reference = result(vec![seg(0.0, 2.0, 0)], 1);
        let hypothesis = result(vec![seg(0.0, 1.0, 0), seg(1.0, 2.0, 1)], 2);

        assert_eq!(der_proxy(&reference, &hypothesis), 0.5);
    }

    #[test]
    fn silence_against_speech_scores_a_one_der() {
        let reference = result(vec![seg(0.0, 2.0, 0)], 1);
        let hypothesis = result(vec![], 0);

        assert_eq!(der_proxy(&reference, &hypothesis), 1.0);
        assert_eq!(jer_proxy(&reference, &hypothesis), 1.0);
        assert_eq!(overlap_f1(&reference, &hypothesis), 0.0);
    }

    #[test]
    fn invented_speech_from_silence_scores_a_one_der() {
        let reference = result(vec![], 0);
        let hypothesis = result(vec![seg(0.0, 2.0, 0)], 1);

        assert_eq!(der_proxy(&reference, &hypothesis), 1.0);
        assert_eq!(overlap_f1(&reference, &hypothesis), 0.0);
    }

    #[test]
    fn silence_against_silence_scores_zero_error_and_unit_f1() {
        let reference = result(vec![], 0);
        let hypothesis = result(vec![], 0);

        assert_eq!(der_proxy(&reference, &hypothesis), 0.0);
        assert_eq!(jer_proxy(&reference, &hypothesis), 0.0);
        assert_eq!(overlap_f1(&reference, &hypothesis), 1.0);
    }

    #[test]
    fn half_overlap_scores_two_thirds_speech_f1() {
        // P = 1.0 (all hyp speech overlaps), R = 0.5 => F1 = 2/3.
        let reference = result(vec![seg(0.0, 2.0, 0)], 1);
        let hypothesis = result(vec![seg(0.0, 1.0, 0)], 1);

        let f1 = overlap_f1(&reference, &hypothesis);
        assert!((f1 - 2.0 / 3.0).abs() < 1e-6, "got {f1}");
    }

    #[test]
    fn split_speaker_halves_the_jer_proxy() {
        // Ref speaker 0 meets hyp speakers 0 and 1 with IoU 0.5 each, so
        // the best single match gives JER 0.5.
        let reference = result(vec![seg(0.0, 2.0, 0)], 1);
        let hypothesis = result(vec![seg(0.0, 1.0, 0), seg(1.0, 2.0, 1)], 2);

        assert_eq!(jer_proxy(&reference, &hypothesis), 0.5);
    }

    #[test]
    fn frame_midpoint_at_a_segment_boundary_belongs_to_the_later_segment() {
        // `[start, end)` half-open sampling: t = 1.0 belongs to the segment
        // starting at 1.0, so frame midpoints never double-count a boundary.
        let fixture = result(vec![seg(0.0, 1.0, 0), seg(1.0, 2.0, 1)], 2);

        assert_eq!(speaker_at(&fixture, 1.0), Some(1));
        assert_eq!(speaker_at(&fixture, 0.999), Some(0));
        assert_eq!(speaker_at(&fixture, 2.0), None);
    }
}
