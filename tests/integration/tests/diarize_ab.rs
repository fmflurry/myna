//! Model-gated diarization A/B baseline stub: decodes
//! `recordings/track-system.wav` with and without diarization, asserts the
//! STT text is identical, and writes `diarize_baseline.json` for future
//! before/after diffs.
//!
//! `#[ignore]`d: it needs the optional pyannote segmentation + NeMo TitaNet
//! artifacts (`scripts/download-models.sh --only diarization`), the
//! Parakeet-TDT model for the A/B decode legs, and the
//! `recordings/track-system.wav` fixture (same fixture the
//! `diarize::tests` unit test in `myna-stt` uses). Self-skips (passes
//! trivially) when anything is missing, so `cargo test --workspace --
//! --ignored` stays green on a machine without them. This is a stub on
//! purpose: no tuning, no thresholds, no behavior change — it only records
//! the current operating point (DER/JER/F1 proxy metrics via
//! [`myna_stt::evaluate`], RTF, RSS, speaker/segment counts, STT text) so a
//! later diarization change can prove it did not regress.
//!
//! The A/B comparison mirrors the app's production path: leg A is the plain
//! offline decode, leg B maps those segments to bare `others` (the
//! system-track attribution `apply_diarize_result` starts from — see
//! app/src-tauri/src/commands/import.rs) and relabels via
//! [`myna_stt::relabel_others`]. The quality metrics reuse
//! [`myna_stt::evaluate`] against a single-speaker full-span reference (the
//! fixture ships with no hand-labeled speaker turns; a real reference can
//! replace [`single_speaker_reference`] without touching the stub).
//!
//! Run with `cargo test -p myna-integration-tests --release --locked --
//! --ignored --nocapture diarize_ab`. The baseline lands at
//! `$CARGO_TARGET_DIR/diarize_baseline.json` (default `<repo>/target/`).

use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::time::Instant;

use myna_integration_tests::repo_root;
use myna_stt::{
    evaluate, relabel_others, DiarizeConfig, DiarizeResult, DiarizeSegment, Diarizer, Speaker,
    SttConfig, SttEngine, Transcript, TranscriptSegment,
};

/// Fixture name as recorded in the baseline JSON (repo-relative).
const FIXTURE_RELATIVE: &str = "recordings/track-system.wav";

/// Directories searched, in order, for downloaded model artifacts: the
/// `MYNA_MODELS_DIR` override first, then the packaged-app location
/// (`~/myna/models`, matching `scripts/download-models.sh`'s default
/// destination), then the repo-relative `models/` dir.
fn models_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(dir) = std::env::var("MYNA_MODELS_DIR") {
        roots.push(PathBuf::from(dir));
    }
    if let Some(home) = std::env::var_os("HOME") {
        roots.push(PathBuf::from(home).join("myna").join("models"));
    }
    roots.push(repo_root().join("models"));
    roots
}

/// First existing `relative` artifact under [`models_roots`].
fn find_artifact(relative: &str) -> Option<PathBuf> {
    models_roots()
        .iter()
        .map(|root| root.join(relative))
        .find(|path| path.is_file())
}

fn segmentation_model() -> Option<PathBuf> {
    find_artifact("pyannote-segmentation-3-0/sherpa-onnx-pyannote-segmentation-3-0/model.int8.onnx")
}

fn embedding_model() -> Option<PathBuf> {
    find_artifact("nemo-titanet/nemo_en_titanet_small.onnx")
}

/// Parakeet-TDT model directory, when all four artifacts are present.
fn parakeet_dir() -> Option<PathBuf> {
    const ARTIFACTS: [&str; 4] = [
        "encoder.int8.onnx",
        "decoder.int8.onnx",
        "joiner.int8.onnx",
        "tokens.txt",
    ];
    models_roots()
        .iter()
        .map(|root| root.join("parakeet-tdt-0.6b-v3-int8"))
        .find(|dir| ARTIFACTS.iter().all(|file| dir.join(file).is_file()))
}

/// Speech fixture shared with the `diarize::tests` unit test in `myna-stt`.
fn speech_fixture() -> Option<PathBuf> {
    let path = repo_root().join(FIXTURE_RELATIVE);
    path.is_file().then_some(path)
}

/// Destination of the baseline JSON: `$CARGO_TARGET_DIR` when set (cargo
/// sets it for build scripts; tests fall back to `<repo>/target/`), so the
/// stub never writes into the tracked source tree.
fn baseline_path() -> PathBuf {
    let dir = std::env::var("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| repo_root().join("target"));
    dir.join("diarize_baseline.json")
}

/// Single-speaker full-span reference over the fixture. See the module docs
/// for why this stands in for a hand-labeled reference.
fn single_speaker_reference(audio_sec: f32) -> DiarizeResult {
    DiarizeResult {
        num_speakers: 1,
        segments: vec![DiarizeSegment {
            start_sec: 0.0,
            end_sec: audio_sec,
            speaker_index: 0,
        }],
    }
}

fn audio_duration_sec(path: &Path) -> Option<f32> {
    let (samples, sample_rate) = myna_stt::read_wav_to_f32(path).ok()?;
    if sample_rate == 0 {
        return None;
    }
    Some(samples.len() as f32 / sample_rate as f32)
}

/// Point-sample of the current process's resident set size, in MiB.
/// Diagnostic only — recorded in the baseline, never asserted against.
fn current_rss_mb() -> u64 {
    proc_status_rss_mb().or_else(ps_rss_mb).unwrap_or(0)
}

/// Resident set size from Linux `/proc/self/status` (`VmHWM`, falling back
/// to `VmRSS`), in MiB. `None` off-Linux or on parse failure.
fn proc_status_rss_mb() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let mut hwm_kb = None;
    let mut rss_kb = None;
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("VmHWM:") {
            hwm_kb = parse_kb(rest);
        } else if let Some(rest) = line.strip_prefix("VmRSS:") {
            rss_kb = parse_kb(rest);
        }
    }
    hwm_kb.or(rss_kb).map(|kb| kb / 1024)
}

fn parse_kb(rest: &str) -> Option<u64> {
    rest.split_whitespace().next()?.parse::<u64>().ok()
}

/// Resident set size via `ps -o rss=` (KiB) for the current pid. Portable
/// fallback for macOS, where `/proc` does not exist.
fn ps_rss_mb() -> Option<u64> {
    let output = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let kb: u64 = String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse()
        .ok()?;
    Some(kb / 1024)
}

/// Runs `run` on the current thread while a sampler thread records peak
/// process RSS every 5 ms; returns the output alongside that peak (MiB).
fn peak_rss_mb_during<T>(run: impl FnOnce() -> T) -> (T, u64) {
    let peak = Arc::new(AtomicU64::new(current_rss_mb()));
    let stop = Arc::new(AtomicBool::new(false));
    let (sampler_peak, sampler_stop) = (Arc::clone(&peak), Arc::clone(&stop));
    let sampler = std::thread::spawn(move || {
        while !sampler_stop.load(Ordering::Relaxed) {
            sampler_peak.fetch_max(current_rss_mb(), Ordering::Relaxed);
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    });
    let output = run();
    stop.store(true, Ordering::Relaxed);
    sampler.join().expect("RSS sampler thread must not panic");
    (output, peak.load(Ordering::Relaxed))
}

#[test]
#[ignore]
fn diarize_ab_writes_baseline_and_preserves_stt_text() {
    // Arrange: skip-cleanly gate — fixture, diarization models, and the STT
    // model for the A/B decode legs must all be present.
    let Some(fixture) = speech_fixture() else {
        eprintln!("skipping: fixture {FIXTURE_RELATIVE} not present");
        return;
    };
    let (Some(segmentation), Some(embedding), Some(parakeet)) =
        (segmentation_model(), embedding_model(), parakeet_dir())
    else {
        eprintln!(
            "skipping: diarization/STT models not present \
             (see scripts/download-models.sh --only diarization)"
        );
        return;
    };

    // Leg A: plain offline decode (pre-diarization text).
    let engine = SttEngine::load(&SttConfig {
        model_dir: parakeet,
        ..Default::default()
    })
    .expect("Parakeet-TDT model loads");
    let transcript = engine
        .transcribe_wav(&fixture)
        .expect("offline decode succeeds");
    let pre_text = transcript.full_text();

    // Diarize leg: timed, with peak-RSS sampling.
    let diarizer = Diarizer::load(&DiarizeConfig {
        segmentation_model: segmentation,
        embedding_model: embedding,
        ..DiarizeConfig::default()
    })
    .expect("diarizer loads");
    let audio_sec = audio_duration_sec(&fixture).expect("fixture wav reads");
    let start = Instant::now();
    let (result, peak_rss_mb) = peak_rss_mb_during(|| {
        diarizer
            .diarize_wav(&fixture)
            .expect("diarize_wav succeeds")
    });
    let wall_sec = start.elapsed().as_secs_f32();
    let rtf = wall_sec / audio_sec;
    let metrics = evaluate(&single_speaker_reference(audio_sec), &result);

    // Leg B: production relabel path over bare-`others` segments.
    let others = Transcript {
        segments: transcript
            .segments
            .iter()
            .map(|segment| TranscriptSegment {
                speaker: Speaker::others(),
                ..segment.clone()
            })
            .collect(),
    };
    let post_text = relabel_others(&others, &result).full_text();

    // Assert: diarization must not alter STT text (WER-preservation lock).
    assert_eq!(
        pre_text, post_text,
        "diarization relabeling must not alter STT text"
    );

    // Baseline: record the current operating point for future diffs.
    let baseline = serde_json::json!({
        "fixture": FIXTURE_RELATIVE,
        "der_proxy": metrics.der_proxy,
        "jer_proxy": metrics.jer_proxy,
        "overlap_f1": metrics.overlap_f1,
        "rtf": rtf,
        "rss_mb": peak_rss_mb,
        "num_speakers": result.num_speakers,
        "num_segments": result.segments.len(),
        "audio_sec": audio_sec,
        "wall_sec": wall_sec,
        "stt_chars": pre_text.len(),
        "stt_text": pre_text,
        "wer_preserved": true,
    });
    let out_path = baseline_path();
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).expect("baseline dir creates");
    }
    std::fs::write(
        &out_path,
        serde_json::to_string_pretty(&baseline).expect("baseline serializes"),
    )
    .expect("baseline writes");
    println!(
        "MYNA_DIARIZE_AB baseline={} der_proxy={:.4} jer_proxy={:.4} \
         overlap_f1={:.4} rtf={rtf:.4} rss_mb={peak_rss_mb} speakers={} \
         segments={} stt_chars={}",
        out_path.display(),
        metrics.der_proxy,
        metrics.jer_proxy,
        metrics.overlap_f1,
        result.num_speakers,
        result.segments.len(),
        pre_text.len(),
    );
}
