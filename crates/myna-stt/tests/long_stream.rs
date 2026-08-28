//! Model-backed regression test for long, VAD-segmented streaming: feeds a
//! synthetic >10s stream through [`SimulatedStreamer`] in irregularly sized
//! chunks and checks the emitted `Final` segments cover the whole input with
//! no dropped audio.
//!
//! `#[ignore]`d for the same reason as `tests/stt_pipeline.rs` in
//! `myna-integration-tests`: it needs the downloaded Parakeet-TDT and Silero
//! VAD model artifacts (see `scripts/download-models.sh`) and is slow. Run
//! with `cargo test -p myna-stt --release --locked -- --ignored`. Self-skips
//! (passes trivially) when the models are not present, so the default
//! `cargo test -p myna-stt` run stays green without them.

use std::path::PathBuf;
use std::sync::Arc;

use myna_stt::{read_wav_to_f32, SimulatedStreamer, SttConfig, SttEngine, SttEvent, VadConfig};

/// Sample rate every VAD/STT component in `myna-stt` operates at (mirrors
/// `myna_stt::TARGET_SAMPLE_RATE`, which is an `i32`; the resampler API
/// needs a `u32`).
const TARGET_SAMPLE_RATE_HZ: u32 = 16_000;

/// Push chunk size, deliberately not a multiple of `VAD_WINDOW_SIZE` (512),
/// so every `push()` call leaves a partial window that must be carried over
/// rather than dropped.
const PUSH_CHUNK_SAMPLES: usize = 4_000;

/// How many times to repeat the speech fixture back-to-back to build a
/// stream long enough to exercise segmentation more than once.
const FIXTURE_REPEATS: usize = 4;

/// Maximum tolerated cumulative gap (seconds) between consecutive `Final`
/// segments' `end_sec`/`start_sec`, and between the stream boundaries and
/// the first/last segment. A real drop (the bug this test guards against)
/// loses whole seconds of audio; a healthy run only has small natural
/// pauses at the fixture's own edges and at repeat boundaries.
const MAX_TOLERATED_GAP_SEC: f32 = 2.0;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

fn parakeet_dir() -> PathBuf {
    repo_root().join("models").join("parakeet-tdt-0.6b-v3-int8")
}

fn silero_vad_path() -> PathBuf {
    repo_root()
        .join("models")
        .join("silero-vad")
        .join("silero_vad.onnx")
}

fn speech_fixture() -> PathBuf {
    parakeet_dir().join("test_wavs").join("en.wav")
}

/// Whether the Parakeet-TDT and Silero VAD models this test depends on are
/// present on disk.
fn models_present() -> bool {
    let parakeet_dir = parakeet_dir();
    let parakeet_ok = [
        "encoder.int8.onnx",
        "decoder.int8.onnx",
        "joiner.int8.onnx",
        "tokens.txt",
    ]
    .iter()
    .all(|file_name| parakeet_dir.join(file_name).is_file());

    parakeet_ok && silero_vad_path().is_file() && speech_fixture().is_file()
}

/// Builds a long stream by repeating the speech fixture's samples
/// back-to-back with no inserted silence, so any gap in the resulting
/// `Final` segments reflects streamer behavior, not deliberately-added
/// silence.
fn long_synthetic_stream() -> (Vec<f32>, f32) {
    let (samples, sample_rate) = read_wav_to_f32(&speech_fixture()).expect("fixture wav reads");
    let mut resampler = myna_audio::Resampler::new(sample_rate, TARGET_SAMPLE_RATE_HZ)
        .expect("resampler constructs for the fixture's sample rate");
    let mut single = resampler.process(&samples);
    single.extend(resampler.flush());

    let mut long_samples = Vec::with_capacity(single.len() * FIXTURE_REPEATS);
    for _ in 0..FIXTURE_REPEATS {
        long_samples.extend_from_slice(&single);
    }
    let duration_sec = long_samples.len() as f32 / TARGET_SAMPLE_RATE_HZ as f32;
    (long_samples, duration_sec)
}

#[test]
#[ignore]
fn long_stream_final_segments_cover_the_full_input_with_no_dropped_audio() {
    // Arrange
    if !models_present() {
        eprintln!("skipping: models not present (see scripts/download-models.sh)");
        return;
    }
    let engine = SttEngine::load(&SttConfig {
        model_dir: parakeet_dir(),
        ..Default::default()
    })
    .expect("Parakeet-TDT model loads");
    let vad_cfg = VadConfig {
        model_path: silero_vad_path(),
        ..Default::default()
    };
    let mut streamer =
        SimulatedStreamer::new(Arc::new(engine), &vad_cfg).expect("streamer constructs");
    let (long_samples, total_duration_sec) = long_synthetic_stream();
    assert!(
        total_duration_sec > 10.0,
        "test fixture setup must produce more than 10s of audio, got {total_duration_sec}s"
    );

    // Act
    let mut finals: Vec<(f32, f32)> = Vec::new();
    for chunk in long_samples.chunks(PUSH_CHUNK_SAMPLES) {
        for event in streamer.push(chunk).expect("push succeeds") {
            if let SttEvent::Final { segment } = event {
                finals.push((segment.start_sec, segment.end_sec));
            }
        }
    }
    for event in streamer.finish().expect("finish succeeds") {
        if let SttEvent::Final { segment } = event {
            finals.push((segment.start_sec, segment.end_sec));
        }
    }

    // Assert
    assert!(
        !finals.is_empty(),
        "expected at least one Final segment from a {total_duration_sec}s stream"
    );

    let (first_start, _) = finals[0];
    let (_, last_end) = *finals.last().expect("finals is non-empty");
    assert!(
        first_start <= MAX_TOLERATED_GAP_SEC,
        "first Final segment starts too late ({first_start}s) — leading audio was dropped"
    );
    assert!(
        last_end >= total_duration_sec - MAX_TOLERATED_GAP_SEC,
        "last Final segment ends too early ({last_end}s of {total_duration_sec}s) — \
         trailing audio was dropped instead of flushed on finish()"
    );

    let mut cumulative_gap_sec = 0.0f32;
    for pair in finals.windows(2) {
        let (_, prev_end) = pair[0];
        let (next_start, _) = pair[1];
        assert!(
            next_start >= prev_end - 0.05,
            "Final segments must not overlap: {prev_end}s then {next_start}s"
        );
        cumulative_gap_sec += (next_start - prev_end).max(0.0);
    }
    assert!(
        cumulative_gap_sec <= MAX_TOLERATED_GAP_SEC,
        "cumulative gap between Final segments ({cumulative_gap_sec}s) suggests dropped audio"
    );
}
