//! Model-backed regression test for the streaming-onset defect: the
//! VAD-segmented path used to drop the leading word of an utterance because
//! it decoded exactly what the VAD reported as the segment start, with no
//! pre-roll — see `SimulatedStreamer`'s `PRE_ROLL_SEC` constant for the
//! full diagnosis (measured on this exact fixture).
//!
//! `#[ignore]`d for the same reason as `tests/long_stream.rs`: it needs the
//! downloaded Parakeet-TDT and Silero VAD model artifacts (see
//! `scripts/download-models.sh`) and is slow. Run with `cargo test -p
//! myna-stt --release --locked -- --ignored onset_preroll`. Self-skips
//! (passes trivially) when the models are not present.

use std::path::PathBuf;
use std::sync::Arc;

use myna_stt::{SimulatedStreamer, SttConfig, SttEngine, SttEvent, VadConfig, VAD_WINDOW_SIZE};

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

/// The `es` fixture: its ground truth begins "No preguntes...", and its
/// leading word "No" spans `0.000s..0.240s` per the offline, full-context
/// decode — with essentially zero lead-in silence before it. This is
/// exactly the shape that exposes the VAD's confirmation-lag onset defect
/// (see `PRE_ROLL_SEC`'s docs): there is no silence margin to absorb the
/// VAD's own internal lookback shortfall.
fn speech_fixture() -> PathBuf {
    parakeet_dir().join("test_wavs").join("es.wav")
}

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

/// Normalizes a hypothesis word for comparison: lowercase, with the accent
/// on "qué" not required — this test guards the *dropped word* defect, not
/// the separate (and, per diagnosis, unrelated) accent-loss defect.
fn first_word_lowercase(text: &str) -> Option<String> {
    text.split_whitespace().next().map(|w| {
        w.trim_matches(|c: char| !c.is_alphanumeric())
            .to_lowercase()
    })
}

#[test]
#[ignore]
fn streaming_final_segment_keeps_the_leading_word_of_an_utterance_with_no_lead_in_silence() {
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
    let (samples, sample_rate) =
        myna_stt::read_wav_to_f32(&speech_fixture()).expect("fixture wav reads");
    let mut resampler = myna_audio::Resampler::new(sample_rate, 16_000)
        .expect("resampler constructs for the fixture's sample rate");
    let mut samples_16k = resampler.process(&samples);
    samples_16k.extend(resampler.flush());

    // Act
    let mut finals: Vec<(f32, String)> = Vec::new();
    for chunk in samples_16k.chunks(VAD_WINDOW_SIZE) {
        for event in streamer.push(chunk).expect("push succeeds") {
            if let SttEvent::Final { segment } = event {
                finals.push((segment.start_sec, segment.text));
            }
        }
    }
    for event in streamer.finish().expect("finish succeeds") {
        if let SttEvent::Final { segment } = event {
            finals.push((segment.start_sec, segment.text));
        }
    }

    // Assert
    assert!(
        !finals.is_empty(),
        "expected at least one Final segment from the es fixture"
    );
    let (first_start_sec, first_text) = &finals[0];
    let first_word = first_word_lowercase(first_text);

    assert_eq!(
        first_word.as_deref(),
        Some("no"),
        "leading word \"No\" was dropped from the streaming hypothesis: \
         first_start_sec={first_start_sec:.3} first_text={first_text:?} \
         (all finals: {finals:?})"
    );
}
