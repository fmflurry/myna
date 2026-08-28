//! Model-backed `myna-stt` pipeline tests: offline decode and VAD-segmented
//! simulated streaming against the real Parakeet-TDT and Silero VAD models.
//!
//! `#[ignore]`d because they require the downloaded model artifacts (see
//! `scripts/download-models.sh`) and are slow relative to the rest of the
//! suite. Each test self-skips (passes trivially, printing why) when
//! `myna_integration_tests::models_present()` is `false`, so `cargo test
//! --workspace -- --ignored` remains green on a machine without models.
//!
//! Run with `cargo test -p myna-integration-tests --release --locked --
//! --ignored`. A debug build of llama.cpp / sherpa-onnx is drastically
//! slower and unrepresentative of real latency; these tests only touch
//! `myna-stt`, but the `--release` recommendation applies to the whole
//! ignored suite.

use myna_integration_tests::{models_present, parakeet_dir, silero_vad, speech_fixture};
use myna_stt::{SimulatedStreamer, SttConfig, SttEngine, SttEvent, VadConfig, VAD_WINDOW_SIZE};

/// Sample rate every VAD/STT component in `myna-stt` operates at
/// (mirrors `myna_stt::TARGET_SAMPLE_RATE`, which is an `i32`; the
/// resampler API needs a `u32`).
const TARGET_SAMPLE_RATE_HZ: u32 = 16_000;

#[test]
#[ignore]
fn transcribe_wav_produces_a_non_empty_text_transcript_with_a_real_word() {
    // Arrange
    if !models_present() {
        eprintln!("skipping: models not present (see scripts/download-models.sh)");
        return;
    }
    let cfg = SttConfig {
        model_dir: parakeet_dir(),
        ..Default::default()
    };
    let engine = SttEngine::load(&cfg).expect("Parakeet-TDT model loads");
    let fixture = speech_fixture().expect("models_present() confirmed the fixture exists");

    // Act
    let transcript = engine
        .transcribe_wav(&fixture)
        .expect("offline decode succeeds");
    let text = transcript.full_text();

    // Assert
    assert!(!text.trim().is_empty(), "transcript text must not be empty");
    let lower = text.to_lowercase();
    assert!(
        lower
            .split_whitespace()
            .any(|word| !word.is_empty() && word.chars().all(|c| c.is_alphabetic())),
        "expected at least one alphabetic word in transcript, got {text:?}"
    );
}

#[test]
#[ignore]
fn simulated_streamer_emits_partial_and_final_events_with_non_decreasing_start_times() {
    // Arrange
    if !models_present() {
        eprintln!("skipping: models not present (see scripts/download-models.sh)");
        return;
    }
    let cfg = SttConfig {
        model_dir: parakeet_dir(),
        ..Default::default()
    };
    let engine = SttEngine::load(&cfg).expect("Parakeet-TDT model loads");
    let vad_cfg = VadConfig {
        model_path: silero_vad(),
        ..Default::default()
    };
    let mut streamer =
        SimulatedStreamer::new(engine.into(), &vad_cfg).expect("streamer constructs");
    let fixture = speech_fixture().expect("models_present() confirmed the fixture exists");
    let (samples, sample_rate) = myna_stt::read_wav_to_f32(&fixture).expect("fixture wav reads");
    // The fixture is not necessarily recorded at the streamer's required
    // sample rate; normalize it exactly like the capture pipeline does
    // before feeding fixed-size chunks to the streamer.
    let mut resampler = myna_audio::Resampler::new(sample_rate, TARGET_SAMPLE_RATE_HZ)
        .expect("resampler constructs for the fixture's sample rate");
    let mut samples_16k = resampler.process(&samples);
    samples_16k.extend(resampler.flush());

    // Act
    //
    // `SimulatedStreamer::push` throttles `Partial` events against wall-clock
    // time (see `PARTIAL_INTERVAL_SEC` in `myna_stt::stream`), so this loop
    // paces chunk delivery to roughly the chunk's real-time duration, the
    // same way a live microphone feed would.
    let chunk_real_time = std::time::Duration::from_secs_f64(
        VAD_WINDOW_SIZE as f64 / f64::from(TARGET_SAMPLE_RATE_HZ),
    );
    let mut partial_count = 0usize;
    let mut final_start_secs: Vec<f32> = Vec::new();
    for chunk in samples_16k.chunks(VAD_WINDOW_SIZE) {
        for event in streamer.push(chunk).expect("push succeeds") {
            match event {
                SttEvent::Partial { .. } => partial_count += 1,
                SttEvent::Final { segment } => final_start_secs.push(segment.start_sec),
            }
        }
        std::thread::sleep(chunk_real_time);
    }
    for event in streamer.finish().expect("finish succeeds") {
        match event {
            SttEvent::Partial { .. } => partial_count += 1,
            SttEvent::Final { segment } => final_start_secs.push(segment.start_sec),
        }
    }

    // Assert
    assert!(partial_count >= 1, "expected at least one Partial event");
    assert!(
        !final_start_secs.is_empty(),
        "expected at least one Final event"
    );
    for pair in final_start_secs.windows(2) {
        assert!(
            pair[0] <= pair[1],
            "Final segment start_sec values must be monotonically non-decreasing: {final_start_secs:?}"
        );
    }
}
