//! Model-gated end-to-end regression test for the reported symptom: a long
//! continuous utterance's live partial transcript used to show only its
//! trailing ~[`PARTIAL_WINDOW_SEC`]-worth of audio until the segment
//! finalized (see `stream::PartialCommitState`'s docs). Feeds a >15s
//! synthetic utterance through [`SimulatedStreamer`] in realistic chunks
//! and asserts the *last* live partial emitted for a long segment already
//! covers substantially the whole segment — not just the trailing window.
//!
//! [`PARTIAL_WINDOW_SEC`]: myna_stt::SimulatedStreamer
//!
//! `#[ignore]`d for the same reason as `tests/long_stream.rs`: it needs the
//! downloaded Parakeet-TDT and Silero VAD model artifacts (see
//! `scripts/download-models.sh`) and is slow. Run with
//! `cargo test -p myna-stt --release --locked -- --ignored`. Self-skips
//! (passes trivially) when the models are not present, so the default
//! `cargo test -p myna-stt` run stays green without them.

use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use myna_stt::{read_wav_to_f32, SimulatedStreamer, SttConfig, SttEngine, SttEvent, VadConfig};

/// Sample rate every VAD/STT component in `myna-stt` operates at (mirrors
/// `myna_stt::TARGET_SAMPLE_RATE`, which is an `i32`; the resampler API
/// needs a `u32`).
const TARGET_SAMPLE_RATE_HZ: u32 = 16_000;

/// Push chunk size — 250ms, mirroring a realistic live-capture chunk (and
/// `tests/long_stream.rs`'s chunking, deliberately not a multiple of
/// `VAD_WINDOW_SIZE`).
const PUSH_CHUNK_SAMPLES: usize = 4_000;

/// How many times to repeat the speech fixture back-to-back. `en.wav` is
/// ~3.8s at its native rate, so 5 repeats comfortably clears the >15s the
/// brief calls for.
const FIXTURE_REPEATS: usize = 5;

/// The synthetic utterance built by [`long_synthetic_utterance`] must be
/// longer than this for the test setup itself to be meaningful.
const MIN_UTTERANCE_SEC: f32 = 15.0;

/// How many words the last live partial for the long segment is allowed to
/// still be missing relative to that segment's eventual `Final` text. A
/// live partial's most recent ~[`PARTIAL_WINDOW_SEC`] is expected to still
/// be unstable (see `stream::PartialCommitState`'s docs — partials
/// routinely rewrite already-displayed words), so this allows a small
/// margin rather than requiring an exact match; it must stay far smaller
/// than the whole segment's word count to actually prove the fix.
const MAX_MISSING_WORDS: usize = 4;

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

/// Builds a long, continuous synthetic utterance by repeating the speech
/// fixture's samples back-to-back with no inserted silence — mirrors
/// `tests/long_stream.rs`'s approach.
fn long_synthetic_utterance() -> (Vec<f32>, f32) {
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

/// One VAD-segmented utterance's outcome: the `Final` text sherpa produced
/// for it, its duration, and the last live `Partial` text seen before that
/// `Final` fired (`None` if the segment finalized before any partial was
/// ever throttled through).
struct UtteranceOutcome {
    final_text: String,
    duration_sec: f32,
    last_partial_text: Option<String>,
}

#[test]
#[ignore]
fn last_partial_before_finalization_covers_substantially_the_whole_long_utterance() {
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
    let (long_samples, total_duration_sec) = long_synthetic_utterance();
    assert!(
        total_duration_sec > MIN_UTTERANCE_SEC,
        "test fixture setup must produce more than {MIN_UTTERANCE_SEC}s of audio, got {total_duration_sec}s"
    );

    // Act: feed the long stream in realistic chunks, pairing each `Final`
    // with the last `Partial` seen for that same utterance (VAD-segment).
    //
    // Paced with a real sleep matching each chunk's audio duration: unlike
    // the fake-clock `PartialThrottle` unit tests in `stream.rs`,
    // `SimulatedStreamer` has no injectable clock (it calls `Instant::now()`
    // directly), and that throttle is real-wall-clock-based by design (see
    // `PARTIAL_INTERVAL_SEC`'s docs). Blasting 19s of audio through
    // `push()` with no delay — as a real capture callback never would —
    // completes in a couple hundred milliseconds of CPU time, so the 1s
    // throttle would let only one or two decodes fire for the entire
    // utterance, defeating the point of this test. Real-time pacing is
    // required here, not a test artifact to work around.
    let chunk_duration =
        Duration::from_secs_f32(PUSH_CHUNK_SAMPLES as f32 / TARGET_SAMPLE_RATE_HZ as f32);
    let mut outcomes: Vec<UtteranceOutcome> = Vec::new();
    let mut pending_last_partial: Option<String> = None;
    for chunk in long_samples.chunks(PUSH_CHUNK_SAMPLES) {
        thread::sleep(chunk_duration);
        for event in streamer.push(chunk).expect("push succeeds") {
            match event {
                SttEvent::Partial { text } => pending_last_partial = Some(text),
                SttEvent::Final { segment } => {
                    outcomes.push(UtteranceOutcome {
                        final_text: segment.text,
                        duration_sec: segment.end_sec - segment.start_sec,
                        last_partial_text: pending_last_partial.take(),
                    });
                }
            }
        }
    }
    for event in streamer.finish().expect("finish succeeds") {
        if let SttEvent::Final { segment } = event {
            outcomes.push(UtteranceOutcome {
                final_text: segment.text,
                duration_sec: segment.end_sec - segment.start_sec,
                last_partial_text: pending_last_partial.take(),
            });
        }
    }

    // Assert
    assert!(
        !outcomes.is_empty(),
        "expected at least one Final segment from a {total_duration_sec}s stream"
    );

    // Pick whichever VAD segment ended up longest — normally the whole
    // repeated stream stays one continuous utterance, but this stays
    // robust even if VAD split it, by directly testing the regression
    // against the segment it's actually meaningful for.
    let longest = outcomes
        .iter()
        .max_by(|a, b| a.duration_sec.total_cmp(&b.duration_sec))
        .expect("outcomes is non-empty");
    assert!(
        longest.duration_sec > MIN_UTTERANCE_SEC / 2.0,
        "the longest VAD segment ({}s) is too short for this test to meaningfully exercise a \
         long-utterance partial — check VAD segmentation of the repeated fixture",
        longest.duration_sec
    );

    let last_partial = longest.last_partial_text.as_deref().unwrap_or_else(|| {
        panic!(
            "expected at least one live Partial before the {}s segment finalized",
            longest.duration_sec
        )
    });
    let final_word_count = longest.final_text.split_whitespace().count();
    let last_partial_word_count = last_partial.split_whitespace().count();

    assert!(
        last_partial_word_count + MAX_MISSING_WORDS >= final_word_count,
        "last live partial ({last_partial_word_count} words: {last_partial:?}) must cover \
         substantially the whole {}s utterance ({final_word_count} words: {:?}), not just the \
         trailing PARTIAL_WINDOW_SEC — this is the direct regression test for the reported \
         symptom",
        longest.duration_sec,
        longest.final_text,
    );
}
