//! Model-gated diarization eval harness: DER/JER/F1 + RTF/RSS + STT
//! text-preservation over `recordings/track-system.wav`.
//!
//! `#[ignore]`d: it needs the optional pyannote segmentation + NeMo TitaNet
//! artifacts (`scripts/download-models.sh --only diarization`), the
//! Parakeet-TDT model for the STT-preservation leg, and the
//! `recordings/track-system.wav` fixture — the same model paths
//! (`models/pyannote-segmentation-3-0/.../model.int8.onnx`,
//! `models/nemo-titanet/nemo_en_titanet_small.onnx`) and fixture the
//! `diarize::tests` unit test uses. Self-skips (passes trivially) when
//! anything is missing, so `cargo test -p myna-stt` stays green without
//! models.
//!
//! Quality metrics reuse [`myna_stt::evaluate`] (the pure frame-sampling
//! DER/JER/F1 in `crates/myna-stt/src/diarize_eval.rs`) — no tuning, no new
//! models, no behavior change. The fixture ships with no hand-labeled
//! speaker turns, so the hypothesis is scored against a single-speaker
//! full-span reference (`[0, audio_sec)`): `der_proxy` then penalizes
//! over-segmentation into extra speakers and `overlap_f1` measures
//! speech-activity agreement. A future hand-labeled reference can replace
//! [`single_speaker_reference`] without touching the harness plumbing.
//!
//! Prints two machine-readable lines per run for before/after diffing:
//! `MYNA_DIARIZE ...` (quality + perf) and `MYNA_DIARIZE_WER_PRESERVED ...`
//! (STT text-preservation), and asserts the relabeled transcript's text is
//! byte-identical to the plain decode.
//!
//! Run with `cargo test -p myna-stt --release --locked -- --ignored
//! --nocapture diarize_eval`.

use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::time::Instant;

use myna_stt::{
    evaluate, merge_clusters, relabel_others, ClusterEmbedder, ClusterMergeConfig, DiarizeConfig,
    DiarizeResult, DiarizeSegment, Diarizer, Speaker, SttConfig, SttEngine, Transcript,
    TranscriptSegment,
};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

/// Directories searched, in order, for downloaded model artifacts: the
/// `MYNA_MODELS_DIR` override first, then the packaged-app location
/// (`~/myna/models`, matching `scripts/download-models.sh`'s default
/// destination), then the repo-relative `models/` dir the `diarize::tests`
/// unit test reads from.
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

/// Speech fixture shared with the `diarize::tests` unit test: already 16 kHz
/// mono, matching what pyannote-3.0 expects, with no resampling required.
fn speech_fixture() -> Option<PathBuf> {
    let path = repo_root().join("recordings").join("track-system.wav");
    path.is_file().then_some(path)
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
/// Diagnostic only — never asserted against.
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
fn diarize_eval_reports_metrics_and_preserves_stt_text() {
    // Arrange: skip-cleanly gate — fixture, diarization models, and the STT
    // model for the preservation leg must all be present.
    let Some(fixture) = speech_fixture() else {
        eprintln!("skipping: fixture recordings/track-system.wav not present");
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
    let diarizer = Diarizer::load(&DiarizeConfig {
        segmentation_model: segmentation,
        embedding_model: embedding,
        ..DiarizeConfig::default()
    })
    .expect("diarizer loads");
    let audio_sec = audio_duration_sec(&fixture).expect("fixture wav reads");

    // Act: timed diarization with peak-RSS sampling.
    let start = Instant::now();
    let (result, peak_rss_mb) = peak_rss_mb_during(|| {
        diarizer
            .diarize_wav(&fixture)
            .expect("diarize_wav succeeds")
    });
    let wall_sec = start.elapsed().as_secs_f32();
    let rtf = wall_sec / audio_sec;

    let metrics = evaluate(&single_speaker_reference(audio_sec), &result);
    println!(
        "MYNA_DIARIZE der_proxy={:.4} jer_proxy={:.4} overlap_f1={:.4} \
         rtf={rtf:.4} rss_mb={peak_rss_mb} speakers={} segments={} \
         audio_sec={audio_sec:.3} wall_sec={wall_sec:.3}",
        metrics.der_proxy,
        metrics.jer_proxy,
        metrics.overlap_f1,
        result.num_speakers,
        result.segments.len(),
    );

    // WER-preservation leg: diarization must never alter STT text. The app
    // attributes system-track segments as bare `others` before relabeling
    // (see `apply_diarize_result` in app/src-tauri/src/commands/import.rs),
    // so exercise that production path rather than the raw decode output
    // (whose `unknown` speakers relabeling trivially leaves alone).
    let engine = SttEngine::load(&SttConfig {
        model_dir: parakeet,
        ..Default::default()
    })
    .expect("Parakeet-TDT model loads");
    let transcript = engine
        .transcribe_wav(&fixture)
        .expect("offline decode succeeds");
    let pre_text = transcript.full_text();
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
    println!(
        "MYNA_DIARIZE_WER_PRESERVED chars={} segments={}",
        pre_text.len(),
        transcript.segments.len(),
    );

    // Assert
    assert_eq!(
        pre_text, post_text,
        "diarization relabeling must not alter STT text"
    );
}

/// One clustering configuration exercised by [`diarize_threshold_sweep`].
struct SweepConfig {
    threshold: f32,
    num_clusters: i32,
    min_duration_on: f32,
}

/// The sweep grid: today's baseline (`threshold` 0.5, `num_clusters` -1)
/// first, then stricter agglomeration thresholds, then the pinned
/// ground-truth speaker count, then a raised `min_duration_on` to see whether
/// dropping sliver segments alone reduces the cluster count.
fn sweep_configs() -> Vec<SweepConfig> {
    let mut configs: Vec<SweepConfig> = [0.5_f32, 0.6, 0.7, 0.8, 0.9]
        .into_iter()
        .map(|threshold| SweepConfig {
            threshold,
            num_clusters: -1,
            min_duration_on: DiarizeConfig::default().min_duration_on,
        })
        .collect();
    configs.push(SweepConfig {
        threshold: DiarizeConfig::default().threshold,
        num_clusters: 2,
        min_duration_on: DiarizeConfig::default().min_duration_on,
    });
    configs.push(SweepConfig {
        threshold: 0.8,
        num_clusters: -1,
        min_duration_on: 0.6,
    });
    configs
}

/// Parameter sweep over a real recording named by `MYNA_DIARIZE_SAMPLE_WAV`
/// (16 kHz mono; never a repo fixture — sample meetings stay outside the
/// tree). Prints one `MYNA_SWEEP ...` line per configuration. Set
/// `MYNA_DIARIZE_SWEEP_BASELINE_ONLY=1` to time the baseline alone before
/// committing to the full grid on a long file.
///
/// Experiment only: production defaults are read from
/// `DiarizeConfig::default()` and never written. Self-skips when the env var
/// or the models are absent.
///
/// Run with `MYNA_DIARIZE_SAMPLE_WAV=/path/to/track-system.wav cargo test
/// -p myna-stt --release --locked -- --ignored --nocapture
/// diarize_threshold_sweep`.
#[test]
#[ignore]
fn diarize_threshold_sweep() {
    // Arrange
    let Some(sample) = std::env::var_os("MYNA_DIARIZE_SAMPLE_WAV").map(PathBuf::from) else {
        eprintln!("skipping: MYNA_DIARIZE_SAMPLE_WAV not set");
        return;
    };
    if !sample.is_file() {
        eprintln!("skipping: MYNA_DIARIZE_SAMPLE_WAV={sample:?} is not a file");
        return;
    }
    let (Some(segmentation), Some(embedding)) = (segmentation_model(), embedding_model()) else {
        eprintln!(
            "skipping: diarization models not present \
             (see scripts/download-models.sh --only diarization)"
        );
        return;
    };
    let baseline_only = std::env::var_os("MYNA_DIARIZE_SWEEP_BASELINE_ONLY").is_some();
    let audio_sec = audio_duration_sec(&sample).expect("sample wav reads");
    let configs = sweep_configs();
    let selected = if baseline_only { 1 } else { configs.len() };
    println!(
        "MYNA_SWEEP_FILE path={} audio_sec={audio_sec:.3} configs={selected}",
        sample.display()
    );

    // Act
    for sweep in configs.iter().take(selected) {
        let diarizer = Diarizer::load(&DiarizeConfig {
            segmentation_model: segmentation.clone(),
            embedding_model: embedding.clone(),
            threshold: sweep.threshold,
            num_clusters: sweep.num_clusters,
            min_duration_on: sweep.min_duration_on,
            ..DiarizeConfig::default()
        })
        .expect("diarizer loads");
        let start = Instant::now();
        let result = diarizer.diarize_wav(&sample).expect("diarize_wav succeeds");
        let elapsed_ms = start.elapsed().as_millis();

        // Assert-by-report: the sweep has no fixed expectation — the caller
        // reads the printed lines. Nothing here asserts a speaker count.
        println!(
            "MYNA_SWEEP threshold={:.2} num_clusters={} min_on={:.2} speakers={} \
             segments={} elapsed_ms={elapsed_ms}",
            sweep.threshold,
            sweep.num_clusters,
            sweep.min_duration_on,
            result.num_speakers,
            result.segments.len(),
        );
    }
}

/// Clustering thresholds the B1 merge sweep runs on top of: today's
/// production default first, then one stricter value.
const MERGE_SWEEP_THRESHOLDS: [f32; 2] = [0.5, 0.8];
/// Centroid-merge cosine floors tried per clustering threshold.
const MERGE_SWEEP_TAUS: [f32; 4] = [0.55, 0.65, 0.75, 0.85];
/// Short-cluster floors tried per `merge_tau`: `0.0` isolates the merge
/// step alone, `5.0` is the proposed default, `15.0` the aggressive row.
const MERGE_SWEEP_MIN_CLUSTER_SECS: [f32; 3] = [0.0, 5.0, 15.0];

/// B1 sweep over a real recording named by `MYNA_DIARIZE_SAMPLE_WAV`.
///
/// Per clustering `threshold` the models run **once**: one
/// `diarize_samples` pass and one per-cluster embedding pass (the expensive,
/// model-bound steps). The pure `merge_clusters` post-pass is then applied
/// for every `(merge_tau, min_cluster_sec)` pair — microseconds each — so the
/// whole grid costs two diarizations + two embedding passes instead of
/// twenty-four. `elapsed_ms` on each `MYNA_MERGE` row is the sum of the
/// shared diarize + embed time and that row's own merge time, i.e. what a
/// production `diarize_wav` with the flag on would pay. `peak_rss_mb` is the
/// larger of the two model passes' sampled peaks.
///
/// Finally one real `diarize_wav` with `enable_centroid_merge = true`
/// (production defaults for the other knobs) and one with the flag off run
/// back to back, printing `MYNA_MERGE_E2E` / `MYNA_MERGE_E2E_BASELINE` so
/// the memory cost of the pass is measured on the actual production path.
///
/// Experiment only: production defaults are never written. Self-skips when
/// the env var or the models are absent.
///
/// Run with `MYNA_DIARIZE_SAMPLE_WAV=/path/to/track-system.wav cargo test
/// -p myna-stt --release --locked -- --ignored --nocapture
/// diarize_merge_sweep`.
#[test]
#[ignore]
fn diarize_merge_sweep() {
    // Arrange
    let Some(sample) = std::env::var_os("MYNA_DIARIZE_SAMPLE_WAV").map(PathBuf::from) else {
        eprintln!("skipping: MYNA_DIARIZE_SAMPLE_WAV not set");
        return;
    };
    if !sample.is_file() {
        eprintln!("skipping: MYNA_DIARIZE_SAMPLE_WAV={sample:?} is not a file");
        return;
    }
    let (Some(segmentation), Some(embedding)) = (segmentation_model(), embedding_model()) else {
        eprintln!(
            "skipping: diarization models not present \
             (see scripts/download-models.sh --only diarization)"
        );
        return;
    };
    let (samples, sample_rate) = myna_stt::read_wav_to_f32(&sample).expect("sample wav reads");
    let audio_sec = samples.len() as f32 / sample_rate.max(1) as f32;
    println!(
        "MYNA_MERGE_FILE path={} audio_sec={audio_sec:.3} sample_rate={sample_rate} \
         thresholds={} taus={} min_cluster_secs={}",
        sample.display(),
        MERGE_SWEEP_THRESHOLDS.len(),
        MERGE_SWEEP_TAUS.len(),
        MERGE_SWEEP_MIN_CLUSTER_SECS.len(),
    );

    // Act: decomposed grid, then the production path with the flag on vs
    // off (same process, back to back, so RSS deltas are comparable).
    for threshold in MERGE_SWEEP_THRESHOLDS {
        run_merge_grid(&segmentation, &embedding, threshold, &samples, sample_rate);
    }
    drop(samples);
    for enable_centroid_merge in [true, false] {
        run_merge_e2e(&sample, &segmentation, &embedding, enable_centroid_merge);
    }
}

/// One clustering pass + one embedding pass at `threshold`, then every
/// `(merge_tau, min_cluster_sec)` pair of the grid applied to that shared
/// result. Prints one `MYNA_MERGE_PASS` line and one `MYNA_MERGE` line per
/// pair.
fn run_merge_grid(
    segmentation: &Path,
    embedding: &Path,
    threshold: f32,
    samples: &[f32],
    sample_rate: u32,
) {
    let defaults = DiarizeConfig::default();
    let diarizer = Diarizer::load(&DiarizeConfig {
        segmentation_model: segmentation.to_path_buf(),
        embedding_model: embedding.to_path_buf(),
        threshold,
        ..DiarizeConfig::default()
    })
    .expect("diarizer loads");
    let start = Instant::now();
    let (clustered, diarize_rss_mb) = peak_rss_mb_during(|| {
        diarizer
            .diarize_samples(samples)
            .expect("diarize_samples succeeds")
    });
    let diarize_ms = start.elapsed().as_millis();
    drop(diarizer);

    let embedder = ClusterEmbedder::load(embedding, defaults.num_threads, defaults.min_embed_sec)
        .expect("embedder loads");
    let start = Instant::now();
    let (centroids, embed_rss_mb) =
        peak_rss_mb_during(|| embedder.centroids(&clustered, samples, sample_rate));
    let embed_ms = start.elapsed().as_millis();
    drop(embedder);
    let embedded = centroids.iter().filter(|c| c.is_some()).count();
    let peak_rss_mb = diarize_rss_mb.max(embed_rss_mb);
    println!(
        "MYNA_MERGE_PASS threshold={threshold:.2} speakers_before={} segments={} \
         clusters_embedded={embedded} diarize_ms={diarize_ms} embed_ms={embed_ms} \
         diarize_rss_mb={diarize_rss_mb} embed_rss_mb={embed_rss_mb}",
        clustered.num_speakers,
        clustered.segments.len(),
    );

    for merge_tau in MERGE_SWEEP_TAUS {
        for min_cluster_sec in MERGE_SWEEP_MIN_CLUSTER_SECS {
            let cfg = ClusterMergeConfig {
                merge_threshold: merge_tau,
                min_cluster_sec,
            };
            let start = Instant::now();
            let merged = merge_clusters(&clustered, &centroids, &cfg);
            let merge_ms = start.elapsed().as_millis();
            assert!(
                merged
                    .segments
                    .iter()
                    .all(|s| s.speaker_index < merged.num_speakers),
                "dense-index invariant must hold after the merge pass"
            );
            assert_eq!(
                merged.segments.len(),
                clustered.segments.len(),
                "the merge pass relabels, never drops or adds segments"
            );
            println!(
                "MYNA_MERGE threshold={threshold:.2} merge_tau={merge_tau:.2} \
                 min_cluster_sec={min_cluster_sec:.1} speakers_before={} \
                 speakers_after={} segments={} elapsed_ms={} peak_rss_mb={peak_rss_mb}",
                clustered.num_speakers,
                merged.num_speakers,
                merged.segments.len(),
                diarize_ms + embed_ms + merge_ms,
            );
        }
    }
}

/// One real `diarize_wav` over `sample` with `enable_centroid_merge` set as
/// given and every other knob at production default. Prints
/// `MYNA_MERGE_E2E` (flag on) or `MYNA_MERGE_E2E_BASELINE` (flag off).
fn run_merge_e2e(
    sample: &Path,
    segmentation: &Path,
    embedding: &Path,
    enable_centroid_merge: bool,
) {
    let defaults = DiarizeConfig::default();
    let diarizer = Diarizer::load(&DiarizeConfig {
        segmentation_model: segmentation.to_path_buf(),
        embedding_model: embedding.to_path_buf(),
        enable_centroid_merge,
        ..DiarizeConfig::default()
    })
    .expect("diarizer loads");
    let start = Instant::now();
    let (result, peak_rss_mb) =
        peak_rss_mb_during(|| diarizer.diarize_wav(sample).expect("diarize_wav succeeds"));
    let elapsed_ms = start.elapsed().as_millis();
    let tag = if enable_centroid_merge {
        "MYNA_MERGE_E2E"
    } else {
        "MYNA_MERGE_E2E_BASELINE"
    };
    println!(
        "{tag} threshold={:.2} merge_tau={:.2} min_cluster_sec={:.1} min_embed_sec={:.1} \
         speakers={} segments={} elapsed_ms={elapsed_ms} peak_rss_mb={peak_rss_mb}",
        defaults.threshold,
        defaults.merge_threshold,
        defaults.min_cluster_sec,
        defaults.min_embed_sec,
        result.num_speakers,
        result.segments.len(),
    );
}
