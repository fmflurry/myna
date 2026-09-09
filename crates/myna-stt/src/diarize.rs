//! Offline speaker diarization: pyannote-3.0 segmentation + NeMo TitaNet
//! embedding + fast clustering, wrapped in this crate's own model-path and
//! error conventions.
//!
//! This module does no attribution decisions itself — it only reports
//! `(start_sec, end_sec, speaker_index)` segments and a speaker count. See
//! [`crate::relabel::relabel_others`] for the pure, confidence-gated logic
//! that turns this output into `Speaker` labels on a [`crate::Transcript`].

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use sherpa_onnx::{
    FastClusteringConfig, OfflineSpeakerDiarization, OfflineSpeakerDiarizationConfig,
    OfflineSpeakerSegmentationModelConfig, OfflineSpeakerSegmentationPyannoteModelConfig,
    SpeakerEmbeddingExtractor, SpeakerEmbeddingExtractorConfig,
};

use crate::cluster_merge::{
    apply_cluster_mapping, cluster_durations, l2_normalize, merge_and_reassign, ClusterMergeConfig,
};
use crate::error::SttError;
use crate::wav::WavBlockReader;

/// `min_duration_on` passed to `OfflineSpeakerDiarizationConfig`: segments
/// shorter than this are dropped by the segmentation stage.
///
/// Kept as the canonical alias for [`DiarizeConfig::min_duration_on`]'s
/// default — the config field is the tunable going forward.
const MIN_DURATION_ON: f32 = 0.3;

/// `min_duration_off` passed to `OfflineSpeakerDiarizationConfig`: silence
/// gaps shorter than this do not split a segment.
///
/// Kept as the canonical alias for [`DiarizeConfig::min_duration_off`]'s
/// default — the config field is the tunable going forward.
const MIN_DURATION_OFF: f32 = 0.5;

/// Frames pulled per [`WavBlockReader::next_block`] while assembling the
/// diarization buffer. 16,000 frames is 1 s at 16 kHz — large enough that
/// per-block overhead stays negligible, small enough that the transient
/// block is noise next to the final buffer.
const DIARIZE_BLOCK_FRAMES: usize = 16_000;

/// Configuration for loading a [`Diarizer`] and tuning the downstream
/// relabeling confidence rule (see [`crate::relabel`]).
///
/// Post-processing pipeline (see `apply_diarize_result` in the app crate)
/// runs exclude→merge→smooth→relabel over these knobs: `min_diar_segment_sec`
/// drops sub-word blips, `merge_gap_sec` joins same-speaker turns across
/// short pauses, `smooth_window_sec` collapses single-segment flicker by
/// time-majority vote, and `min_segment_sec` / `min_coverage` gate the final
/// relabeling confidence. Tuned for recall: 0.75 s `min_segment_sec` keeps
/// short confirmations ("yes", "agreed") relabelable, 0.60 `min_coverage`
/// recovers split-coverage turns, 1.0 s smoothing + 0.8 s merge fix the
/// same-speaker over-segmentation case. `threshold` 0.5 and
/// `min_duration_on` 0.3 / `min_duration_off` 0.5 stay on the embedding
/// side pending a measured sweep — unchanged here.
#[derive(Debug, Clone)]
pub struct DiarizeConfig {
    pub segmentation_model: PathBuf,
    pub embedding_model: PathBuf,
    pub num_threads: i32,
    /// Passed to `FastClusteringConfig::num_clusters`. `-1` (the default)
    /// infers the speaker count from `threshold`; a positive value pins it
    /// and makes `threshold` irrelevant. Exposed for the eval sweep — the
    /// production default is unchanged.
    pub num_clusters: i32,
    pub threshold: f32,
    pub min_duration_on: f32,
    pub min_duration_off: f32,
    pub min_segment_sec: f32,
    pub min_coverage: f32,
    pub merge_gap_sec: f32,
    pub smooth_window_sec: f32,
    pub min_diar_segment_sec: f32,
    /// Enables the post-clustering centroid merge + short-cluster
    /// reassignment pass (see [`crate::cluster_merge`]). `true` by default:
    /// measured end-to-end on a 29-min two-speaker meeting
    /// (`track-system.wav`), the raw clustering yielded 45 speakers and the
    /// merge pass at the default `merge_threshold` / `min_cluster_sec`
    /// collapsed them to the correct 2 (stable across `merge_threshold`
    /// 0.55–0.75 and `min_cluster_sec` 5–15 s; 0.85 under-merged).
    ///
    /// Cost: roughly +5 % diarization runtime (+3.4 s on a 72 s pass) and
    /// about +140 MB peak RSS, because a second, standalone TitaNet
    /// instance is loaded for cluster embedding.
    ///
    /// Known limitation: a participant whose total speech is shorter than
    /// `min_cluster_sec` is dissolved into the nearest surviving centroid,
    /// i.e. absorbed into another speaker.
    ///
    /// `false` leaves [`Diarizer::diarize_wav`] byte-identical to the
    /// pre-B1 pipeline: no extra model is loaded and no extra work runs.
    pub enable_centroid_merge: bool,
    /// Cosine similarity at or above which two cluster centroids merge.
    /// Only read when `enable_centroid_merge` is `true`.
    pub merge_threshold: f32,
    /// Clusters with less total speech than this are dissolved into their
    /// nearest surviving centroid. Only read when `enable_centroid_merge`.
    pub min_cluster_sec: f32,
    /// Prefer segments at least this long when embedding a cluster; a
    /// cluster with no such segment falls back to all of its segments.
    /// Only read when `enable_centroid_merge`.
    pub min_embed_sec: f32,
}

impl Default for DiarizeConfig {
    fn default() -> Self {
        Self {
            segmentation_model: PathBuf::new(),
            embedding_model: PathBuf::new(),
            num_threads: 2,
            num_clusters: -1,
            threshold: 0.5,
            min_duration_on: MIN_DURATION_ON,
            min_duration_off: MIN_DURATION_OFF,
            min_segment_sec: 0.75,
            min_coverage: 0.60,
            merge_gap_sec: 0.8,
            smooth_window_sec: 1.0,
            min_diar_segment_sec: 0.25,
            enable_centroid_merge: true,
            merge_threshold: 0.65,
            min_cluster_sec: 5.0,
            min_embed_sec: 1.5,
        }
    }
}

/// One diarization segment: `[start_sec, end_sec)` attributed to
/// `speaker_index` — a 0-based index assigned by clustering, stable only
/// within a single [`Diarizer::diarize_wav`] call, not a durable identity.
#[derive(Debug, Clone, PartialEq)]
pub struct DiarizeSegment {
    pub start_sec: f32,
    pub end_sec: f32,
    pub speaker_index: u32,
}

/// The full diarization output for one recording.
///
/// Invariant (established by [`compact_speaker_indices`], which
/// [`Diarizer::diarize_wav`] applies before returning): every
/// [`DiarizeSegment::speaker_index`] is `< num_speakers`, i.e. indices are
/// dense `0..num_speakers`. Raw sherpa-onnx output does not satisfy this —
/// its `NumSpeakers()` is a *distinct count* of surviving clusters while
/// each `speaker_index` is the raw cluster column id, so whole clusters
/// dropped below `min_duration_on` leave the surviving ids sparse. Hand-built
/// results (tests, post-processing chains) may temporarily hold a
/// `num_speakers` larger than the distinct index count; [`compact_speaker_indices`]
/// restores the invariant.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct DiarizeResult {
    pub num_speakers: u32,
    /// Sorted by [`DiarizeSegment::start_sec`].
    pub segments: Vec<DiarizeSegment>,
}

/// Offline speaker diarizer: pyannote-3.0 segmentation + NeMo TitaNet
/// embedding + fast clustering (`num_clusters: -1` infers the speaker count
/// from `threshold` rather than requiring it up front).
pub struct Diarizer {
    inner: OfflineSpeakerDiarization,
    /// Present only when [`DiarizeConfig::enable_centroid_merge`] was set at
    /// load time; `None` keeps [`Self::diarize_wav`] on the legacy path.
    merge: Option<(ClusterEmbedder, ClusterMergeConfig)>,
}

impl Diarizer {
    /// Loads the segmentation and embedding model artifacts named in `cfg`.
    /// When `cfg.enable_centroid_merge` is set, a standalone copy of the
    /// embedding model is also loaded for the post-clustering merge pass.
    pub fn load(cfg: &DiarizeConfig) -> Result<Self, SttError> {
        require_artifact(&cfg.segmentation_model)?;
        require_artifact(&cfg.embedding_model)?;
        let merge = if cfg.enable_centroid_merge {
            Some((
                ClusterEmbedder::load(&cfg.embedding_model, cfg.num_threads, cfg.min_embed_sec)?,
                ClusterMergeConfig {
                    merge_threshold: cfg.merge_threshold,
                    min_cluster_sec: cfg.min_cluster_sec,
                },
            ))
        } else {
            None
        };

        let config = OfflineSpeakerDiarizationConfig {
            segmentation: OfflineSpeakerSegmentationModelConfig {
                pyannote: OfflineSpeakerSegmentationPyannoteModelConfig {
                    model: Some(path_to_string(&cfg.segmentation_model)),
                    ..Default::default()
                },
                num_threads: cfg.num_threads,
                ..Default::default()
            },
            embedding: SpeakerEmbeddingExtractorConfig {
                model: Some(path_to_string(&cfg.embedding_model)),
                num_threads: cfg.num_threads,
                ..Default::default()
            },
            clustering: FastClusteringConfig {
                num_clusters: cfg.num_clusters,
                threshold: cfg.threshold,
            },
            min_duration_on: cfg.min_duration_on,
            min_duration_off: cfg.min_duration_off,
        };

        let inner = OfflineSpeakerDiarization::create(&config).ok_or(SttError::DiarizeInit)?;
        Ok(Self { inner, merge })
    }

    /// Diarizes a WAV file on disk, returning segments sorted by start time.
    pub fn diarize_wav(&self, path: &Path) -> Result<DiarizeResult, SttError> {
        // Build one owned mono buffer block-wise so the interleaved
        // all-samples Vec is never materialized: peak Rust-side memory is
        // ~1x the file's frame count (plus one transient block), not 2x.
        // Mono blocks pass through `downmix_to_mono` by move, so the common
        // 16 kHz track-system case never copies at all. The sherpa-onnx C++
        // layer keeps its own internal copy of the slice handed to
        // `process` — unavoidable through the C API — so total peak stays
        // at 2x file bytes.
        let mut reader = WavBlockReader::open(path)?;
        // The header's declared frame count is attacker-controlled for
        // user-imported files — clamp the reservation to the file's real
        // size before pre-allocating (see [`reservation_frames`]).
        let file_bytes = std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
        let capacity =
            reservation_frames(reader.total_frames(), file_bytes, reader.bytes_per_frame());
        let mut samples = Vec::with_capacity(capacity);
        while let Some(block) = reader.next_block(DIARIZE_BLOCK_FRAMES)? {
            samples.extend(block);
        }
        let sample_rate = reader.sample_rate();

        let clustered = self.diarize_samples(&samples)?;
        let Some((embedder, merge_cfg)) = &self.merge else {
            return Ok(clustered);
        };
        // B1 pass: re-embed each cluster from slices of the buffer we
        // already hold (no second read, no per-cluster copy of the file),
        // merge near-duplicate centroids, absorb short clusters, then
        // restore the dense-index invariant.
        let centroids = embedder.centroids(&clustered, &samples, sample_rate);
        Ok(merge_clusters(&clustered, &centroids, merge_cfg))
    }

    /// Runs segmentation + embedding + clustering over an in-memory mono
    /// buffer (16 kHz expected by the models) and returns the compacted
    /// result. This is the pre-B1 pipeline verbatim; the merge pass is
    /// applied by [`Self::diarize_wav`] only when enabled.
    pub fn diarize_samples(&self, samples: &[f32]) -> Result<DiarizeResult, SttError> {
        let result = self
            .inner
            .process(samples)
            .ok_or_else(|| SttError::Decode("diarization returned no result".into()))?;

        let num_speakers = result.num_speakers().max(0) as u32;
        let segments = result
            .sort_by_start_time()
            .into_iter()
            .map(|seg| DiarizeSegment {
                start_sec: seg.start,
                end_sec: seg.end,
                speaker_index: seg.speaker.max(0) as u32,
            })
            .collect();

        Ok(compact_speaker_indices(&DiarizeResult {
            num_speakers,
            segments,
        }))
    }
}

/// Applies the B1 pass ([`merge_and_reassign`] over `centroids`) to a
/// compacted `clustered` result and re-densifies the indices. Pure — split
/// out of [`Diarizer::diarize_wav`] so the eval sweep can run one clustering
/// + one embedding pass and then try many `(merge_threshold,
/// min_cluster_sec)` pairs without re-running the models.
pub fn merge_clusters(
    clustered: &DiarizeResult,
    centroids: &[Option<Vec<f32>>],
    cfg: &ClusterMergeConfig,
) -> DiarizeResult {
    let durations = cluster_durations(clustered);
    let mapping = merge_and_reassign(centroids, &durations, cfg);
    compact_speaker_indices(&apply_cluster_mapping(clustered, &mapping))
}

/// Standalone speaker-embedding extractor used to compute one centroid per
/// diarization cluster for the B1 merge pass.
///
/// Centroid strategy: the **duration-weighted mean of per-segment
/// embeddings** (each L2-normalised), not one embedding over the cluster's
/// concatenated audio. Reasons: (1) memory — only one segment's samples
/// are handed to the C++ side at a time, as a borrowed slice of the buffer
/// [`Diarizer::diarize_wav`] already holds, so peak RSS does not scale with
/// cluster length (the dominant speaker in a 30-min meeting can own 15+
/// minutes of audio); (2) a mean of unit embeddings is exactly the
/// centroid the agglomerative clusterer reasons about, so the merge
/// threshold is on the same scale as `FastClusteringConfig::threshold`.
pub struct ClusterEmbedder {
    extractor: SpeakerEmbeddingExtractor,
    min_embed_sec: f32,
}

impl ClusterEmbedder {
    /// Loads the embedding model at `model` (validated to exist first).
    pub fn load(model: &Path, num_threads: i32, min_embed_sec: f32) -> Result<Self, SttError> {
        require_artifact(model)?;
        let extractor = SpeakerEmbeddingExtractor::create(&SpeakerEmbeddingExtractorConfig {
            model: Some(path_to_string(model)),
            num_threads,
            ..Default::default()
        })
        .ok_or(SttError::DiarizeInit)?;
        Ok(Self {
            extractor,
            min_embed_sec,
        })
    }

    /// One centroid per cluster `0..result.num_speakers` (`None` when the
    /// cluster yielded no embedding at all). Prefers segments at least
    /// `min_embed_sec` long; falls back to every segment of the cluster when
    /// none qualifies. Segment bounds are clamped to `samples`.
    pub fn centroids(
        &self,
        result: &DiarizeResult,
        samples: &[f32],
        sample_rate: u32,
    ) -> Vec<Option<Vec<f32>>> {
        let durations = cluster_durations(result);
        (0..durations.len())
            .map(|cluster| self.cluster_centroid(result, cluster as u32, samples, sample_rate))
            .collect()
    }

    fn cluster_centroid(
        &self,
        result: &DiarizeResult,
        cluster: u32,
        samples: &[f32],
        sample_rate: u32,
    ) -> Option<Vec<f32>> {
        let mine: Vec<&DiarizeSegment> = result
            .segments
            .iter()
            .filter(|seg| seg.speaker_index == cluster)
            .collect();
        let long: Vec<&DiarizeSegment> = mine
            .iter()
            .copied()
            .filter(|seg| seg.end_sec - seg.start_sec >= self.min_embed_sec)
            .collect();
        let chosen = if long.is_empty() { &mine } else { &long };

        let mut sum: Option<Vec<f32>> = None;
        for seg in chosen {
            let Some(slice) = segment_slice(samples, sample_rate, seg) else {
                continue;
            };
            let Some(embedding) = self.embed(slice, sample_rate) else {
                continue;
            };
            let weight = (seg.end_sec - seg.start_sec).max(1e-3);
            let unit = l2_normalize(&embedding);
            sum = Some(match sum {
                None => unit.iter().map(|x| x * weight).collect(),
                Some(acc) => acc.iter().zip(&unit).map(|(a, x)| a + x * weight).collect(),
            });
        }
        sum.map(|v| l2_normalize(&v))
    }

    /// Embeds one slice through a fresh stream, which is dropped (and its
    /// C++ buffer freed) before the next segment is processed.
    fn embed(&self, slice: &[f32], sample_rate: u32) -> Option<Vec<f32>> {
        let stream = self.extractor.create_stream()?;
        stream.accept_waveform(sample_rate as i32, slice);
        stream.input_finished();
        if !self.extractor.is_ready(&stream) {
            return None;
        }
        self.extractor.compute(&stream)
    }
}

/// The `[start_sec, end_sec)` window of `samples`, clamped to the buffer;
/// `None` when the window is empty or lies outside the buffer.
fn segment_slice<'a>(
    samples: &'a [f32],
    sample_rate: u32,
    seg: &DiarizeSegment,
) -> Option<&'a [f32]> {
    if sample_rate == 0 || !seg.start_sec.is_finite() || !seg.end_sec.is_finite() {
        return None;
    }
    let rate = sample_rate as f32;
    let start = ((seg.start_sec.max(0.0) * rate) as usize).min(samples.len());
    let end = ((seg.end_sec.max(0.0) * rate) as usize).min(samples.len());
    (end > start).then(|| &samples[start..end])
}

/// Remaps sparse `speaker_index` values to dense `0..K` and sets
/// `num_speakers = K`, where `K` is the number of distinct indices present.
///
/// Indices are assigned in order of first appearance by `start_sec` (a
/// stable sort of a clone — the input's own order is preserved in the
/// output), so index `0` is always the first voice heard and downstream
/// `others:<index + 1>` labels read chronologically. Pure: returns a new
/// [`DiarizeResult`] and never mutates `result`. Idempotent on already-dense
/// input. Edge cases: an empty result yields `num_speakers == 0` and no
/// segments; a single cluster maps to index `0` with `num_speakers == 1`;
/// raw ids arriving out of time order or near `u32::MAX` are remapped
/// through the lookup table like any other value (no arithmetic on raw ids).
pub fn compact_speaker_indices(result: &DiarizeResult) -> DiarizeResult {
    let mut by_start: Vec<&DiarizeSegment> = result.segments.iter().collect();
    by_start.sort_by(|a, b| {
        a.start_sec
            .partial_cmp(&b.start_sec)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut dense: HashMap<u32, u32> = HashMap::new();
    for seg in by_start {
        let next = dense.len() as u32;
        dense.entry(seg.speaker_index).or_insert(next);
    }
    let segments = result
        .segments
        .iter()
        .map(|seg| DiarizeSegment {
            start_sec: seg.start_sec,
            end_sec: seg.end_sec,
            speaker_index: dense[&seg.speaker_index],
        })
        .collect();
    DiarizeResult {
        num_speakers: dense.len() as u32,
        segments,
    }
}

/// Joins nothing (unlike `engine::require_artifact`, model paths here are
/// already full paths, not `model_dir`-relative) — just validates `path` is
/// a file, failing with [`SttError::ModelNotFound`] otherwise.
fn require_artifact(path: &Path) -> Result<(), SttError> {
    if path.is_file() {
        Ok(())
    } else {
        Err(SttError::ModelNotFound(path.to_path_buf()))
    }
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Upper-bound [`Diarizer::diarize_wav`]'s sample-buffer reservation by
/// what the file can actually hold.
///
/// `declared_frames` comes from the WAV header's data-chunk length, which
/// hound reports verbatim — a corrupt or hostile user-imported file can
/// claim 2^31 frames (~8 GB of `f32`) inside a 244-byte file, and
/// `Vec::with_capacity` would take that claim at face value and abort the
/// process on the speculative allocation. The file's real byte size is the
/// only trustworthy bound: `declared.min(file_bytes / bytes_per_frame)`,
/// floored at one [`DIARIZE_BLOCK_FRAMES`] block so amortised `extend`
/// covers any residual growth. Pure so the forged-header guard is
/// unit-testable without the diarization models.
fn reservation_frames(declared_frames: u64, file_bytes: u64, bytes_per_frame: u64) -> usize {
    if bytes_per_frame == 0 {
        return DIARIZE_BLOCK_FRAMES;
    }
    let clamped = declared_frames.min(file_bytes / bytes_per_frame);
    usize::try_from(clamped)
        .unwrap_or(DIARIZE_BLOCK_FRAMES)
        .max(DIARIZE_BLOCK_FRAMES)
}

/// Drops segments shorter than `min_sec` (duration `< min_sec`).
///
/// Pure post-processing helper for the upcoming diarization sweep (see
/// [`DiarizeConfig::min_diar_segment_sec`): clustering flicker often leaves
/// sub-word blips that downstream relabeling should never see. Returns a new
/// [`Vec`] in input order — callers pass start-sorted segments and the
/// output stays start-sorted. Empty input returns empty output; a
/// non-positive `min_sec` disables filtering and returns a clone.
#[allow(dead_code)] // Staged for the post-processing sweep (merge step); unit tests pin behavior meanwhile.
pub fn exclude_short_segments(segments: &[DiarizeSegment], min_sec: f32) -> Vec<DiarizeSegment> {
    if min_sec.is_nan() || min_sec <= 0.0 {
        return segments.to_vec();
    }
    segments
        .iter()
        .filter(|seg| seg.end_sec - seg.start_sec >= min_sec)
        .cloned()
        .collect()
}

/// Relabels each segment by sliding time-majority vote over `window_sec`.
///
/// For segment `i`, the window is `[center - window_sec / 2,
/// center + window_sec / 2)` around its midpoint; every segment overlapping
/// the window votes with its overlap duration for its own `speaker_index`.
/// The segment takes the highest-vote speaker. Ties resolve toward the
/// earliest voice — the tied speaker whose first overlapping segment starts
/// first (then the smaller index) — so a lone flicker between two long
/// turns collapses while a genuine turn (which dominates its own window)
/// survives. Only speaker indices already present can win, so smoothing
/// never invents a speaker. Output preserves input order (callers pass
/// start-sorted segments, hence the output stays start-sorted). Empty input
/// returns empty output; a non-positive or non-finite `window_sec` returns a
/// clone.
#[allow(dead_code)] // Staged for the post-processing sweep (merge step); unit tests pin behavior meanwhile.
pub fn smooth_labels(segments: &[DiarizeSegment], window_sec: f32) -> Vec<DiarizeSegment> {
    if segments.is_empty() || !window_sec.is_finite() || window_sec <= 0.0 {
        return segments.to_vec();
    }
    // Stable by start so the window math sees time order even if a caller
    // hands us unsorted segments; output order follows this sorted order.
    let mut order: Vec<usize> = (0..segments.len()).collect();
    order.sort_by(|&a, &b| {
        segments[a]
            .start_sec
            .partial_cmp(&segments[b].start_sec)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let sorted: Vec<&DiarizeSegment> = order.iter().map(|&i| &segments[i]).collect();

    let half = window_sec / 2.0;
    let relabeled: Vec<DiarizeSegment> = sorted
        .iter()
        .map(|seg| {
            let center = (seg.start_sec + seg.end_sec) / 2.0;
            let lo = center - half;
            let hi = center + half;
            // Per-speaker (total_overlap, first_start, speaker_index).
            let mut votes: Vec<(f32, f32, u32)> = Vec::new();
            for other in &sorted {
                let overlap = (other.end_sec.min(hi) - other.start_sec.max(lo)).max(0.0);
                if overlap > 0.0 {
                    match votes
                        .iter_mut()
                        .find(|(_, _, idx)| *idx == other.speaker_index)
                    {
                        Some(entry) => {
                            entry.0 += overlap;
                            entry.1 = entry.1.min(other.start_sec);
                        }
                        None => votes.push((overlap, other.start_sec, other.speaker_index)),
                    }
                }
            }
            let winner = if votes.is_empty() {
                // Degenerate (zero-length) segment covered by nothing, not
                // even itself: keep the input label rather than panicking.
                seg.speaker_index
            } else {
                let mut best = &votes[0];
                for candidate in &votes[1..] {
                    let better = candidate.0 > best.0
                        || (candidate.0 == best.0
                            && (candidate.1 < best.1
                                || (candidate.1 == best.1 && candidate.2 < best.2)));
                    if better {
                        best = candidate;
                    }
                }
                best.2
            };
            DiarizeSegment {
                start_sec: seg.start_sec,
                end_sec: seg.end_sec,
                speaker_index: winner,
            }
        })
        .collect();
    relabeled
}

/// Merges adjacent same-speaker segments separated by at most `gap_sec`.
///
/// Sorts a clone of `result.segments` by `start_sec`, then sweeps once:
/// a segment joins the previous merged segment only when both share the
/// same `speaker_index` and `gap = start - prev_end <= gap_sec`
/// (overlap gives a negative gap, so overlapping same-speaker segments
/// merge by extending to the later end). Segments with different indices
/// never merge — adjacent or overlapping — and are kept untouched in
/// start-sorted order. `num_speakers` is recomputed as the distinct
/// speaker-index count of the merged segments (0 when empty). A
/// non-finite or negative `gap_sec` disables merging and returns the
/// sorted clone with a recomputed count.
#[allow(dead_code)] // Staged for the post-processing sweep; unit tests pin behavior meanwhile.
pub fn post_merge(result: &DiarizeResult, gap_sec: f32) -> DiarizeResult {
    let mut sorted = result.segments.clone();
    sorted.sort_by(|a, b| {
        a.start_sec
            .partial_cmp(&b.start_sec)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let distinct_count = || {
        let mut ids: Vec<u32> = sorted.iter().map(|seg| seg.speaker_index).collect();
        ids.sort_unstable();
        ids.dedup();
        ids.len() as u32
    };
    if sorted.is_empty() || !gap_sec.is_finite() || gap_sec < 0.0 {
        let num_speakers = distinct_count();
        return DiarizeResult {
            num_speakers,
            segments: sorted,
        };
    }
    let mut merged: Vec<DiarizeSegment> = Vec::with_capacity(sorted.len());
    for seg in sorted {
        if let Some(last) = merged.last_mut() {
            if last.speaker_index == seg.speaker_index && seg.start_sec - last.end_sec <= gap_sec {
                last.end_sec = last.end_sec.max(seg.end_sec);
                continue;
            }
        }
        merged.push(seg);
    }
    let mut ids: Vec<u32> = merged.iter().map(|seg| seg.speaker_index).collect();
    ids.sort_unstable();
    ids.dedup();
    DiarizeResult {
        num_speakers: ids.len() as u32,
        segments: merged,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn post_merge_joins_same_speaker_within_gap() {
        // Gap 0.2 s <= 0.5 s budget: the two speaker-0 turns become one.
        let result = DiarizeResult {
            num_speakers: 1,
            segments: vec![seg(0.0, 1.0, 0), seg(1.2, 2.0, 0)],
        };

        let merged = post_merge(&result, 0.5);

        assert_eq!(merged.segments, vec![seg(0.0, 2.0, 0)]);
        assert_eq!(merged.num_speakers, 1);
    }

    #[test]
    fn post_merge_never_merges_different_speakers() {
        // Same 0.2 s gap, but the indices differ: no merge, count stays 2.
        let result = DiarizeResult {
            num_speakers: 2,
            segments: vec![seg(0.0, 1.0, 0), seg(1.2, 2.0, 1)],
        };

        let merged = post_merge(&result, 0.5);

        assert_eq!(merged.segments, vec![seg(0.0, 1.0, 0), seg(1.2, 2.0, 1)]);
        assert_eq!(merged.num_speakers, 2);
    }

    #[test]
    fn post_merge_leaves_overlapping_different_speakers_untouched() {
        // Overlapping turns from different speakers are kept verbatim,
        // start-sorted; only the stale count is recomputed.
        let result = DiarizeResult {
            num_speakers: 7,
            segments: vec![seg(1.0, 3.0, 1), seg(0.0, 2.0, 0)],
        };

        let merged = post_merge(&result, 0.5);

        assert_eq!(merged.segments, vec![seg(0.0, 2.0, 0), seg(1.0, 3.0, 1)]);
        assert_eq!(merged.num_speakers, 2);
    }

    fn repo_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
    }

    fn segmentation_model() -> PathBuf {
        repo_root()
            .join("models")
            .join("pyannote-segmentation-3-0")
            .join("sherpa-onnx-pyannote-segmentation-3-0")
            .join("model.int8.onnx")
    }

    fn embedding_model() -> PathBuf {
        repo_root()
            .join("models")
            .join("nemo-titanet")
            .join("nemo_en_titanet_small.onnx")
    }

    /// Reuses the same system-audio fixture the offline decode tests use —
    /// it's already 16 kHz mono, matching what pyannote-3.0 expects, with no
    /// resampling required.
    fn speech_fixture() -> PathBuf {
        repo_root().join("recordings").join("track-system.wav")
    }

    fn models_present() -> bool {
        segmentation_model().is_file() && embedding_model().is_file() && speech_fixture().is_file()
    }

    #[test]
    fn load_rejects_a_missing_segmentation_model_before_touching_the_embedding_model() {
        // No real model artifacts are required: the artifact-presence check
        // must run, and fail, before any FFI work.
        let cfg = DiarizeConfig {
            segmentation_model: PathBuf::from("/nonexistent/segmentation.onnx"),
            embedding_model: PathBuf::from("/nonexistent/embedding.onnx"),
            ..DiarizeConfig::default()
        };

        let error = Diarizer::load(&cfg).err().expect("must be rejected");

        match error {
            SttError::ModelNotFound(path) => {
                assert_eq!(path, PathBuf::from("/nonexistent/segmentation.onnx"));
            }
            other => panic!("expected ModelNotFound, got {other:?}"),
        }
    }

    #[test]
    fn reservation_frames_clamps_a_forged_wav_header_to_the_files_real_size() {
        // Arrange: a 16 kHz mono PCM16 file with 100 real frames whose
        // declared data-chunk length is forged to ~4 GB (2^31 frames). The
        // pre-fix `Vec::with_capacity(reader.total_frames())` took that
        // claim at face value — a speculative ~8 GB `f32` reservation and
        // an OOM abort on a 244-byte file.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("forged.wav");
        let mut writer = hound::WavWriter::create(
            &path,
            hound::WavSpec {
                channels: 1,
                sample_rate: 16_000,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .expect("create wav");
        for frame in 0..100i16 {
            writer.write_sample(frame).expect("write sample");
        }
        writer.finalize().expect("finalize wav");
        let mut bytes = std::fs::read(&path).expect("read wav");
        assert_eq!(
            &bytes[36..40],
            b"data",
            "canonical PCM header puts the data chunk at offset 36"
        );
        let forged_len: u32 = 0xFFFF_FFFE; // even, so hound accepts the claim
        bytes[4..8].copy_from_slice(&forged_len.to_le_bytes());
        bytes[40..44].copy_from_slice(&forged_len.to_le_bytes());
        std::fs::write(&path, bytes).expect("write forged wav");

        // The header claim really is trusted by the reader layer:
        let reader = WavBlockReader::open(&path).expect("open forged wav");
        let declared = reader.total_frames();
        assert!(
            declared > 1_000_000_000,
            "forged header must claim > 10^9 frames, got {declared}"
        );

        // Act
        let file_bytes = std::fs::metadata(&path).expect("metadata").len();
        let reservation = reservation_frames(declared, file_bytes, reader.bytes_per_frame());

        // Assert: bounded by the file's real bytes, not the forged claim.
        assert!(
            reservation <= DIARIZE_BLOCK_FRAMES + (file_bytes / 2) as usize,
            "reservation {reservation} must be bounded by the file's real size \
             ({file_bytes} bytes), not the forged {declared}-frame claim"
        );
        assert!(
            reservation < 1_000_000,
            "must never speculatively reserve GB-scale memory, got {reservation} frames"
        );
    }

    #[test]
    fn reservation_frames_keeps_an_honest_header_and_survives_a_zero_sized_frame() {
        // Honest 1-hour 16 kHz mono PCM16 file: reservation equals the
        // declared count (no clamp needed, no extra copying behaviour).
        let honest_frames = 16_000u64 * 3_600;
        let file_bytes = honest_frames * 2 + 44;
        assert_eq!(
            reservation_frames(honest_frames, file_bytes, 2),
            honest_frames as usize
        );
        // Degenerate spec (bytes_per_frame == 0): fall back to the block
        // floor instead of dividing by zero.
        assert_eq!(reservation_frames(123, 456, 0), DIARIZE_BLOCK_FRAMES);
        // Tiny honest file: floored at one block, never zero.
        assert_eq!(reservation_frames(10, 64, 2), DIARIZE_BLOCK_FRAMES);
    }

    fn seg(start_sec: f32, end_sec: f32, speaker_index: u32) -> DiarizeSegment {
        DiarizeSegment {
            start_sec,
            end_sec,
            speaker_index,
        }
    }

    #[test]
    fn exclude_short_segments_drops_blips_but_keeps_boundary_length() {
        // A 0.1 s clustering blip between two long turns must go; a
        // segment exactly at the minimum stays.
        let segments = vec![seg(0.0, 5.0, 0), seg(5.0, 5.1, 1), seg(5.1, 10.0, 0)];

        let kept = exclude_short_segments(&segments, 0.25);

        assert_eq!(kept, vec![seg(0.0, 5.0, 0), seg(5.1, 10.0, 0)]);
        assert_eq!(
            exclude_short_segments(&[seg(0.0, 0.25, 1)], 0.25),
            vec![seg(0.0, 0.25, 1)]
        );
    }

    #[test]
    fn exclude_short_segments_is_empty_safe_and_passthrough_when_disabled() {
        assert!(exclude_short_segments(&[], 0.25).is_empty());
        let segments = vec![seg(0.0, 0.05, 1)];
        assert_eq!(exclude_short_segments(&segments, 0.0), segments);
        assert_eq!(exclude_short_segments(&segments, -1.0), segments);
    }

    #[test]
    fn smooth_labels_collapses_a_single_segment_flicker() {
        // 0.2 s of speaker 1 wedged between two long speaker-0 turns: its
        // 2 s window is dominated by speaker 0 on both sides, so it flips
        // while the genuine turns are untouched.
        let segments = vec![seg(0.0, 10.0, 0), seg(10.0, 10.2, 1), seg(10.2, 20.0, 0)];

        let smoothed = smooth_labels(&segments, 2.0);

        assert_eq!(
            smoothed,
            vec![seg(0.0, 10.0, 0), seg(10.0, 10.2, 0), seg(10.2, 20.0, 0)]
        );
    }

    #[test]
    fn smooth_labels_preserves_a_real_turn_that_dominates_its_window() {
        // A full 5 s turn owns its whole 2 s window, so majority keeps it.
        let segments = vec![seg(0.0, 5.0, 0), seg(5.0, 10.0, 1), seg(10.0, 15.0, 0)];

        let smoothed = smooth_labels(&segments, 2.0);

        assert_eq!(smoothed, segments);
    }

    #[test]
    fn smooth_labels_breaks_ties_toward_the_earlier_voice_without_new_indices() {
        // A 10 s window around either 2 s segment covers both equally
        // (2 s each): the tie must resolve to the earlier starter, and the
        // winner is always an index already present.
        let segments = vec![seg(0.0, 2.0, 1), seg(2.0, 4.0, 0)];

        let smoothed = smooth_labels(&segments, 10.0);

        assert_eq!(smoothed, vec![seg(0.0, 2.0, 1), seg(2.0, 4.0, 1)]);
        for out in &smoothed {
            assert!(
                segments
                    .iter()
                    .any(|s| s.speaker_index == out.speaker_index),
                "must never invent speaker {}",
                out.speaker_index
            );
        }
    }

    #[test]
    fn smooth_labels_is_empty_safe_passthrough_when_disabled_and_start_sorted() {
        assert!(smooth_labels(&[], 2.0).is_empty());
        let flicker = vec![seg(0.0, 10.0, 0), seg(10.0, 10.2, 1), seg(10.2, 20.0, 0)];
        assert_eq!(smooth_labels(&flicker, 0.0), flicker);
        let smoothed = smooth_labels(&flicker, 2.0);
        let mut previous = f32::MIN;
        for out in &smoothed {
            assert!(out.start_sec >= previous, "output must stay start-sorted");
            previous = out.start_sec;
        }
    }

    #[test]
    fn smooth_labels_keeps_a_degenerate_segment_instead_of_panicking() {
        let segments = vec![seg(5.0, 5.0, 1)];

        assert_eq!(smooth_labels(&segments, 2.0), segments);
    }

    #[test]
    fn default_config_carries_the_recall_tuned_knobs() {
        // Guards the over-segmentation fix: short confirmations relabel
        // (0.75 s), split-coverage turns recover (0.60), same-speaker pauses
        // join (0.8 s merge) and single-segment flicker collapses (1.0 s
        // smooth). Embedding-side knobs stay put pending a measured sweep.
        let cfg = DiarizeConfig::default();

        assert_eq!(cfg.min_segment_sec, 0.75);
        assert_eq!(cfg.min_coverage, 0.60);
        assert_eq!(cfg.smooth_window_sec, 1.0);
        assert_eq!(cfg.merge_gap_sec, 0.8);
        assert_eq!(cfg.min_diar_segment_sec, 0.25);
        assert_eq!(cfg.threshold, 0.5);
        assert_eq!(cfg.min_duration_on, 0.3);
        assert_eq!(cfg.min_duration_off, 0.5);
    }

    #[test]
    fn default_config_enables_centroid_merge() {
        // Pins the shipped default: the merge pass is ON, measured on a
        // 29-min two-speaker meeting to collapse 45 raw clusters to 2. The
        // 0.65 tau sits mid-plateau (0.55–0.75 all yield 2; 0.85
        // under-merges). The app spreads `..DiarizeConfig::default()`, so a
        // silent revert here would reach production.
        let cfg = DiarizeConfig::default();

        assert!(cfg.enable_centroid_merge);
        assert_eq!(cfg.merge_threshold, 0.65);
        assert_eq!(cfg.min_cluster_sec, 5.0);
        assert_eq!(cfg.min_embed_sec, 1.5);
    }

    #[test]
    fn merge_clusters_collapses_near_duplicate_clusters_and_keeps_indices_dense() {
        // Three raw clusters: 0 and 2 share a voice (cos ~0.99), 1 is
        // distinct and long. After the pass the result must be two dense
        // speakers with 0/2 unified, the input untouched.
        let clustered = DiarizeResult {
            num_speakers: 3,
            segments: vec![seg(0.0, 10.0, 0), seg(10.0, 20.0, 1), seg(20.0, 30.0, 2)],
        };
        let snapshot = clustered.clone();
        let centroids = vec![
            Some(vec![1.0, 0.0]),
            Some(vec![0.0, 1.0]),
            Some(vec![0.99, 0.1]),
        ];
        let cfg = ClusterMergeConfig {
            merge_threshold: 0.9,
            min_cluster_sec: 5.0,
        };

        let merged = merge_clusters(&clustered, &centroids, &cfg);

        assert_eq!(merged.num_speakers, 2);
        assert_eq!(
            merged.segments,
            vec![seg(0.0, 10.0, 0), seg(10.0, 20.0, 1), seg(20.0, 30.0, 0)]
        );
        assert!(merged
            .segments
            .iter()
            .all(|s| s.speaker_index < merged.num_speakers));
        assert_eq!(clustered, snapshot);
    }

    #[test]
    fn segment_slice_clamps_to_the_buffer_and_rejects_empty_windows() {
        let samples: Vec<f32> = (0..32_000).map(|i| i as f32).collect(); // 2 s @ 16 kHz
        let slice = segment_slice(&samples, 16_000, &seg(0.5, 1.0, 0)).expect("in range");
        assert_eq!(slice.len(), 8_000);
        assert_eq!(slice[0], 8_000.0);
        // Past the end: clamped, still non-empty.
        let tail = segment_slice(&samples, 16_000, &seg(1.5, 9.0, 0)).expect("clamped");
        assert_eq!(tail.len(), 8_000);
        // Entirely outside, zero-length, or degenerate rate: None.
        assert!(segment_slice(&samples, 16_000, &seg(5.0, 6.0, 0)).is_none());
        assert!(segment_slice(&samples, 16_000, &seg(1.0, 1.0, 0)).is_none());
        assert!(segment_slice(&samples, 0, &seg(0.0, 1.0, 0)).is_none());
    }

    #[test]
    fn smooth_labels_with_default_window_collapses_flicker() {
        // Same flicker shape as `smooth_labels_collapses_a_single_segment_flicker`
        // but driven by `DiarizeConfig::default().smooth_window_sec` (1.0 s),
        // not a hand-picked window: a 0.2 s speaker-1 blip between two long
        // speaker-0 turns collapses, genuine turns survive, no new indices.
        let cfg = DiarizeConfig::default();
        let segments = vec![seg(0.0, 5.0, 0), seg(5.0, 5.2, 1), seg(5.2, 10.0, 0)];

        let smoothed = smooth_labels(&segments, cfg.smooth_window_sec);

        assert_eq!(
            smoothed,
            vec![seg(0.0, 5.0, 0), seg(5.0, 5.2, 0), seg(5.2, 10.0, 0)]
        );
        for out in &smoothed {
            assert!(
                segments
                    .iter()
                    .any(|s| s.speaker_index == out.speaker_index),
                "must never invent speaker {}",
                out.speaker_index
            );
        }
    }

    #[test]
    #[ignore]
    fn diarize_wav_reports_a_speaker_count_and_sorted_segments_on_a_real_recording() {
        // Arrange
        if !models_present() {
            eprintln!(
                "skipping: diarization models or fixture not present \
                 (see scripts/download-models.sh)"
            );
            return;
        }
        let diarizer = Diarizer::load(&DiarizeConfig {
            segmentation_model: segmentation_model(),
            embedding_model: embedding_model(),
            ..DiarizeConfig::default()
        })
        .expect("diarizer loads");

        // Act
        let result = diarizer
            .diarize_wav(&speech_fixture())
            .expect("diarize_wav succeeds");

        // Assert
        assert!(result.num_speakers >= 1, "must detect at least one speaker");
        let mut previous_start = f32::MIN;
        for segment in &result.segments {
            assert!(
                segment.start_sec >= previous_start,
                "segments must be sorted by start time"
            );
            assert!(segment.end_sec >= segment.start_sec);
            previous_start = segment.start_sec;
        }
    }
}
