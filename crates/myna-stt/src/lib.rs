//! `myna-stt`: offline Parakeet-TDT decoding and VAD-segmented simulated
//! streaming for Myna.
//!
//! This crate does no I/O beyond model and WAV file loading — no printing,
//! no audio capture, no threads. Callers (the `myna-stt` binary, or the
//! Tauri app) own capture, rendering, and threading. See [`engine`] for
//! offline decode, [`vad`] for VAD segmentation, and [`stream`] for the
//! streaming loop that ties them together.

mod align;
mod cli;
mod cluster_merge;
mod detokenize;
mod diarize;
mod diarize_eval;
mod engine;
mod error;
mod relabel;
mod stream;
mod suspect;
mod transcript;
mod vad;
mod wav;

pub use align::align_words_to_diar;
pub use cli::{Cli, DEFAULT_VAD_MODEL};
pub use cluster_merge::{
    apply_cluster_mapping, cluster_durations, cosine_similarity, l2_normalize, merge_and_reassign,
    merge_centroids, reassign_short_clusters, ClusterMergeConfig,
};
pub use detokenize::{detokenize, Word};
pub use diarize::{
    compact_speaker_indices, exclude_short_segments, merge_clusters, post_merge, smooth_labels,
    ClusterEmbedder, DiarizeConfig, DiarizeResult, DiarizeSegment, Diarizer,
};
pub use diarize_eval::{der_proxy, evaluate, jer_proxy, overlap_f1, DiarizeMetrics, FRAME_RATE_HZ};
pub use engine::{
    SttConfig, SttEngine, ALLOWED_DECODING_METHODS, DEFAULT_BLANK_PENALTY, GREEDY_SEARCH,
    MODIFIED_BEAM_SEARCH,
};
pub use error::SttError;
pub use relabel::{
    relabel_others, relabel_others_with_config, relabel_others_word_level,
    MIN_DIARIZED_SEGMENT_SEC, MIN_SPEAKER_COVERAGE,
};
pub use stream::{SimulatedStreamer, StreamerOptions, SttEvent};
pub use suspect::{score_segment, SuspectReason};
pub use transcript::{Speaker, SpeakerRole, Transcript, TranscriptSegment};
pub use vad::{
    VadConfig, VadSegmenter, DEFAULT_MIN_SILENCE_SEC, TARGET_SAMPLE_RATE, VAD_BUFFER_SECS,
    VAD_WINDOW_SIZE,
};
pub use wav::{read_wav_parts_to_f32, read_wav_to_f32, WavBlockReader};
