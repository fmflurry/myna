//! Model-backed word-error-rate regression test for `myna-stt`'s
//! VAD-segmented simulated streaming, over four hand-corrected
//! ground-truth fixtures (`tests/integration/fixtures/{en,fr,de,es}.txt`).
//!
//! Establishes a fresh accuracy baseline so later cadence/tuning changes to
//! `myna-stt` (VAD thresholds, partial-commit timing, resampling, ...) can
//! be proven not to regress transcription accuracy, independent of any
//! historical numbers.
//!
//! `#[ignore]`d for the same reason as `tests/stt_pipeline.rs`: it needs
//! the downloaded Parakeet-TDT and Silero VAD model artifacts (see
//! `scripts/download-models.sh`) and is slow. Self-skips (passes trivially)
//! when the models are not present, so `cargo test --workspace --
//! --ignored` stays green on a machine without them.
//!
//! Run with `cargo test -p myna-integration-tests --release --locked --
//! --ignored --nocapture streaming_wer`.

use std::sync::Arc;

use myna_integration_tests::{
    models_present, parakeet_dir, reference_transcript, silero_vad, speech_fixture_for, wer,
};
use myna_stt::{SimulatedStreamer, SttConfig, SttEngine, SttEvent, VadConfig, VAD_WINDOW_SIZE};

/// Sample rate every VAD/STT component in `myna-stt` operates at (mirrors
/// `myna_stt::TARGET_SAMPLE_RATE`, which is an `i32`; the resampler API
/// needs a `u32`).
const TARGET_SAMPLE_RATE_HZ: u32 = 16_000;

/// Maximum acceptable word error rate, per fixture language.
///
/// Chosen as a fresh baseline threshold (not derived from any prior
/// measurement — see the module docs) that a correct, unregressed decode
/// clears comfortably while still catching a real accuracy regression.
///
/// Budgets are per-language, not a single shared constant, because `es` has
/// a known real defect (see below) that the others do not: forcing it under
/// the same 0.05 budget as `en`/`fr`/`de` would hide the defect by either
/// failing the suite forever or (worse) prompting someone to loosen every
/// language's budget to make it pass.
///
/// A budget may only ever be LOWERED, never raised, without a written
/// justification (a comment here explaining what changed and why the
/// regression is expected/acceptable).
const WER_BUDGETS: &[(&str, f32)] = &[
    ("en", 0.05),
    ("fr", 0.05),
    ("de", 0.05),
    // es: 0.15, not 0.05. Lowered from 0.20 (never raised — see the
    // struct-level rule above) after fixing the streaming-onset defect: the
    // VAD-segmented path used to drop the leading word ("No") because the
    // VAD's own reported segment start lands after the true acoustic onset
    // (diagnosed and fixed via `SimulatedStreamer`'s `PRE_SPEECH_RETAIN_SEC`
    // / `PRE_ROLL_SEC` pre-roll in `crates/myna-stt/src/stream.rs`; see
    // `crates/myna-stt/tests/onset_preroll.rs` for the dedicated
    // regression test). Measured after the fix: `es` wer=0.1176 (down from
    // 0.1765). `0.15` keeps headroom above that measurement without hiding
    // a regression. A *separate*, unfixed defect remains on this fixture:
    // both occurrences of `qué` lose their accent (`qué` -> `que`) in the
    // streaming hypothesis despite sitting well inside the segment, far
    // from the pre-roll boundary — this is not the same root cause as the
    // dropped leading word and is not addressed here.
    ("es", 0.15),
];

/// Look up the WER budget for `lang`, panicking if `LANGUAGES` and
/// `WER_BUDGETS` ever drift out of sync.
fn wer_budget_for(lang: &str) -> f32 {
    WER_BUDGETS
        .iter()
        .find(|(candidate, _)| *candidate == lang)
        .map(|(_, budget)| *budget)
        .unwrap_or_else(|| panic!("no WER_BUDGETS entry for lang={lang}"))
}

/// Fixture languages exercised by this test, matching
/// `tests/integration/fixtures/{lang}.txt` and
/// `models/parakeet-tdt-0.6b-v3-int8/test_wavs/{lang}.wav`.
const LANGUAGES: [&str; 4] = ["en", "fr", "de", "es"];

#[test]
#[ignore]
fn streaming_wer_stays_within_budget() {
    // Arrange
    if !models_present() {
        eprintln!("skipping: models not present (see scripts/download-models.sh)");
        return;
    }
    let cfg = SttConfig {
        model_dir: parakeet_dir(),
        ..Default::default()
    };
    let engine = Arc::new(SttEngine::load(&cfg).expect("Parakeet-TDT model loads"));
    let vad_cfg = VadConfig {
        model_path: silero_vad(),
        ..Default::default()
    };

    for lang in LANGUAGES {
        let fixture = speech_fixture_for(lang)
            .unwrap_or_else(|| panic!("speech fixture for lang={lang} is present on disk"));
        let reference = reference_transcript(lang).unwrap_or_else(|| {
            panic!("ground-truth transcript for lang={lang} exists at tests/integration/fixtures/{lang}.txt")
        });

        // Act
        let mut streamer =
            SimulatedStreamer::new(Arc::clone(&engine), &vad_cfg).expect("streamer constructs");
        let (samples, sample_rate) =
            myna_stt::read_wav_to_f32(&fixture).expect("fixture wav reads");
        // The fixture is not necessarily recorded at the streamer's required
        // sample rate; normalize it exactly like the capture pipeline does
        // before feeding fixed-size chunks to the streamer.
        let mut resampler = myna_audio::Resampler::new(sample_rate, TARGET_SAMPLE_RATE_HZ)
            .expect("resampler constructs for the fixture's sample rate");
        let mut samples_16k = resampler.process(&samples);
        samples_16k.extend(resampler.flush());

        let mut hypothesis_segments: Vec<String> = Vec::new();
        for chunk in samples_16k.chunks(VAD_WINDOW_SIZE) {
            for event in streamer.push(chunk).expect("push succeeds") {
                if let SttEvent::Final { segment } = event {
                    hypothesis_segments.push(segment.text);
                }
            }
        }
        for event in streamer.finish().expect("finish succeeds") {
            if let SttEvent::Final { segment } = event {
                hypothesis_segments.push(segment.text);
            }
        }
        let hypothesis = hypothesis_segments.join(" ");
        let word_error_rate = wer(&reference, &hypothesis);

        // Report a single machine-readable line per fixture so a
        // before/after diff (e.g. across a VAD tuning change) is readable.
        println!("MYNA_WER lang={lang} wer={word_error_rate:.4}");

        // Assert
        let budget = wer_budget_for(lang);
        assert!(
            word_error_rate <= budget,
            "lang={lang} wer={word_error_rate:.4} exceeds budget {budget}: \
             hypothesis={hypothesis:?} reference={reference:?}"
        );
    }
}
