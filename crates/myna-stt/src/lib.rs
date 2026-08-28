//! `myna-stt`: offline Parakeet-TDT decoding and VAD-segmented simulated
//! streaming for Myna.
//!
//! This crate does no I/O beyond model and WAV file loading — no printing,
//! no audio capture, no threads. Callers (the `myna-stt` binary, or the
//! Tauri app) own capture, rendering, and threading. See [`engine`] for
//! offline decode, [`vad`] for VAD segmentation, and [`stream`] for the
//! streaming loop that ties them together.

mod cli;
mod detokenize;
mod engine;
mod error;
mod stream;
mod transcript;
mod vad;
mod wav;

pub use cli::{Cli, DEFAULT_VAD_MODEL};
pub use detokenize::{detokenize, Word};
pub use engine::{
    SttConfig, SttEngine, ALLOWED_DECODING_METHODS, DEFAULT_BLANK_PENALTY, GREEDY_SEARCH,
    MODIFIED_BEAM_SEARCH,
};
pub use error::SttError;
pub use stream::{SimulatedStreamer, StreamerOptions, SttEvent};
pub use transcript::{Transcript, TranscriptSegment};
pub use vad::{
    VadConfig, VadSegmenter, DEFAULT_MIN_SILENCE_SEC, TARGET_SAMPLE_RATE, VAD_BUFFER_SECS,
    VAD_WINDOW_SIZE,
};
pub use wav::{read_wav_to_f32, WavBlockReader};
