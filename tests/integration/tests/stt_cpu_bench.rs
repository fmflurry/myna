//! `#[ignore]`d CPU benchmark for VAD-segmented simulated streaming.
//!
//! Feeds a fixed-length synthetic workload through [`SimulatedStreamer`] as
//! fast as possible (no real-time pacing — unlike
//! `crates/myna-stt/tests/partial_commit.rs`, which paces chunk delivery
//! deliberately to exercise the wall-clock partial throttle) and prints one
//! machine-readable line of wall-clock, RTF and thread-count metrics for
//! `scripts/bench-stt-cpu.sh` to parse and correlate against sampled process
//! CPU/thread usage.
//!
//! `#[ignore]`d for the same reason as `tests/stt_pipeline.rs`: it needs the
//! downloaded Parakeet-TDT and Silero VAD model artifacts (see
//! `scripts/download-models.sh`) and is slow. Self-skips (passes trivially)
//! when the models are not present, so `cargo test --workspace -- --ignored`
//! stays green on a machine without them.
//!
//! Run directly with:
//! `cargo test -p myna-integration-tests --release --locked -- --ignored
//! --nocapture stt_streaming_cpu_benchmark`
//! or via `scripts/bench-stt-cpu.sh`, which also samples process CPU time
//! and thread count.

use std::env;
use std::sync::Arc;
use std::time::Instant;

use myna_integration_tests::{models_present, parakeet_dir, silero_vad, speech_fixture};
use myna_stt::{read_wav_to_f32, SimulatedStreamer, SttConfig, SttEngine, SttEvent, VadConfig};

/// Sample rate every VAD/STT component in `myna-stt` operates at (mirrors
/// `myna_stt::TARGET_SAMPLE_RATE`, which is an `i32`; the resampler API
/// needs a `u32`).
const TARGET_SAMPLE_RATE_HZ: u32 = 16_000;

/// Target length, in seconds, of the synthesized benchmark workload.
const BENCH_DURATION_SEC: f32 = 180.0;

/// Push chunk size, mirroring `crates/myna-stt/tests/long_stream.rs`'s
/// `PUSH_CHUNK_SAMPLES`: deliberately not a multiple of `VAD_WINDOW_SIZE`
/// (512), so every `push()` call leaves a partial window that must be
/// carried over rather than dropped.
const PUSH_CHUNK_SAMPLES: usize = 4_000;

/// Silence inserted between repeats of the speech fixture, in seconds.
/// Must exceed `myna_stt::DEFAULT_MIN_SILENCE_SEC` (0.5s) so the VAD closes
/// each repeat's segment naturally instead of gluing every repeat into one
/// unbounded utterance.
const SILENCE_BETWEEN_REPEATS_SEC: f32 = 0.6;

/// Environment variable overriding the STT engine's thread count for this
/// benchmark, so one binary can sweep e.g. 8 vs 4 threads with no rebuild.
const BENCH_THREADS_ENV: &str = "MYNA_BENCH_STT_THREADS";

/// Default thread count when [`BENCH_THREADS_ENV`] is unset — matches the
/// app's `STT_ENGINE_THREADS_FALLBACK` / `STT_ENGINE_THREADS_MAX` in
/// `app/src-tauri/src/state.rs`.
const DEFAULT_BENCH_THREADS: i32 = 8;

/// Number of STT decode threads to benchmark with: [`BENCH_THREADS_ENV`] if
/// set and parseable, otherwise [`DEFAULT_BENCH_THREADS`].
fn bench_num_threads() -> i32 {
    env::var(BENCH_THREADS_ENV)
        .ok()
        .and_then(|value| value.parse::<i32>().ok())
        .unwrap_or(DEFAULT_BENCH_THREADS)
}

/// Builds a synthetic stream at least `target_sec` long by repeating the
/// English speech fixture, resampled to [`TARGET_SAMPLE_RATE_HZ`], with
/// [`SILENCE_BETWEEN_REPEATS_SEC`] of digital silence inserted between
/// repeats so the VAD segments the workload into multiple utterances
/// instead of one unbounded one (mirrors
/// `crates/myna-stt/tests/long_stream.rs::long_synthetic_stream`, but
/// repeats to a target duration rather than a fixed repeat count, and
/// inserts silence rather than gluing repeats back-to-back).
fn synthetic_stream(target_sec: f32) -> (Vec<f32>, f32) {
    let fixture = speech_fixture().expect("models_present() confirmed the fixture exists");
    let (samples, sample_rate) = read_wav_to_f32(&fixture).expect("fixture wav reads");
    let mut resampler = myna_audio::Resampler::new(sample_rate, TARGET_SAMPLE_RATE_HZ)
        .expect("resampler constructs for the fixture's sample rate");
    let mut single = resampler.process(&samples);
    single.extend(resampler.flush());

    let silence_len = (SILENCE_BETWEEN_REPEATS_SEC * TARGET_SAMPLE_RATE_HZ as f32) as usize;
    let silence = vec![0.0f32; silence_len];

    let mut long_samples: Vec<f32> = Vec::new();
    while (long_samples.len() as f32 / TARGET_SAMPLE_RATE_HZ as f32) < target_sec {
        long_samples.extend_from_slice(&single);
        long_samples.extend_from_slice(&silence);
    }
    let duration_sec = long_samples.len() as f32 / TARGET_SAMPLE_RATE_HZ as f32;
    (long_samples, duration_sec)
}

#[test]
#[ignore]
fn stt_streaming_cpu_benchmark() {
    // Arrange
    if !models_present() {
        eprintln!("skipping: models not present (see scripts/download-models.sh)");
        return;
    }
    let threads = bench_num_threads();
    let cfg = SttConfig {
        model_dir: parakeet_dir(),
        num_threads: threads,
        ..Default::default()
    };
    let engine = SttEngine::load(&cfg).expect("Parakeet-TDT model loads");
    let vad_cfg = VadConfig {
        model_path: silero_vad(),
        ..Default::default()
    };
    let mut streamer =
        SimulatedStreamer::new(Arc::new(engine), &vad_cfg).expect("streamer constructs");
    let (samples, audio_sec) = synthetic_stream(BENCH_DURATION_SEC);

    // Act
    //
    // No `thread::sleep` between chunks — unlike
    // `crates/myna-stt/tests/partial_commit.rs`, which paces delivery to
    // exercise the real-time partial throttle, this benchmark wants maximum
    // decode throughput to measure CPU cost, not throttle behavior.
    let mut partials = 0usize;
    let mut finals = 0usize;
    let start = Instant::now();
    for chunk in samples.chunks(PUSH_CHUNK_SAMPLES) {
        for event in streamer.push(chunk).expect("push succeeds") {
            match event {
                SttEvent::Partial { .. } => partials += 1,
                SttEvent::Final { .. } => finals += 1,
            }
        }
    }
    for event in streamer.finish().expect("finish succeeds") {
        match event {
            SttEvent::Partial { .. } => partials += 1,
            SttEvent::Final { .. } => finals += 1,
        }
    }
    let wall_sec = start.elapsed().as_secs_f32();
    let rtf = wall_sec / audio_sec;

    // Assert / report: a single machine-readable line for
    // `scripts/bench-stt-cpu.sh` (or a human) to parse.
    println!(
        "MYNA_BENCH audio_sec={audio_sec:.3} wall_sec={wall_sec:.3} rtf={rtf:.4} \
         partials={partials} finals={finals} threads={threads}"
    );
}
