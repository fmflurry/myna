//! Regression coverage for `commands::import` — previously zero tests
//! existed for this module, which is how the CRITICAL recording/import
//! concurrency gap (code review finding 1) shipped unnoticed.
//!
//! `import_audio_blocking` and `retranscribe_meeting_blocking` are private
//! functions that take a real `tauri::AppHandle`, and this workspace has no
//! `tauri::test` mock-app harness (grepped: none exists). Per this
//! codebase's established pattern (`commands::meetings::apply_segment_edit`,
//! `session::guard_start`), the busy/cancellation *decisions* those
//! functions must apply are pulled out into plain, `AppHandle`-free
//! functions — `ingest::guard_import`, `session::guard_not_recording`, and
//! `ingest::convert_to_canonical_wav` — and exercised directly here. The
//! `start_recording_blocking` side of the same concurrency-gap fix
//! (`session::guard_start`) is covered in `tests/session.rs`, where its
//! other tests already live.
//!
//! The one scenario that inherently needs a real, model-backed
//! `SimulatedStreamer` (cancelling mid-*transcribe*, as opposed to
//! mid-*conversion*) is covered by an `#[ignore]`d test at the bottom,
//! mirroring the existing model-gated convention in
//! `crates/myna-stt/src/stream.rs`.

use std::path::Path;
use std::sync::atomic::AtomicBool;

use myna_app::domain::MeetingId;
use myna_app::error::AppError;
use myna_app::ingest::{convert_to_canonical_wav, guard_import};
use myna_app::session::guard_not_recording;

/// Writes a minimal, valid mono WAV fixture with `seconds` of silence at
/// `sample_rate` — long enough to span at least one
/// `convert_to_canonical_wav` block (`ingest::INGEST_CHUNK_SEC`).
fn write_wav_fixture(path: &Path, seconds: f32, sample_rate: u32) {
    let spec = myna_audio::RecordingSpec {
        sample_rate,
        channels: 1,
    };
    let mut recorder =
        myna_audio::WavRecorder::create(path, spec).expect("create wav recorder fixture");
    let frame_count = (sample_rate as f32 * seconds) as usize;
    recorder
        .write(&vec![0.01_f32; frame_count])
        .expect("write wav fixture samples");
    recorder.finalize().expect("finalize wav fixture");
}

// --- CRITICAL finding (1): recording/import concurrency guard ------------

/// `start_recording_blocking` must refuse to start while an import or
/// re-transcribe is in flight — see `tests/session.rs` for the
/// `guard_start`-level regression test (`guard_start` lives in
/// `session.rs`, so its tests live in `tests/session.rs` by this
/// codebase's existing convention). Restated here as the concurrency-gap
/// story is two-sided: this file asserts the *import* side of the guard,
/// `tests/session.rs` asserts the *recording* side.
#[test]
fn import_audio_is_refused_while_a_recording_is_active() {
    // Act: this is exactly the guard `import_audio_blocking` calls —
    // `ingest::guard_import(state.import_busy(), recording_active)` — with
    // no import in flight but a recording active.
    let result = guard_import(false, true);

    // Assert
    let err = result.expect_err("importing while a recording is active must be refused");
    assert!(matches!(err, AppError::Busy(_)));
    let message = err.to_string().to_lowercase();
    assert!(
        message.contains("recording"),
        "message should name the recording conflict, got: {message}"
    );
}

/// Regression test for the CRITICAL bug itself: before the fix,
/// `retranscribe_meeting_blocking` called only `guard_not_recording`, which
/// refuses re-transcribing *the specific meeting currently being recorded*
/// but has no way to know about — and therefore allows — re-transcribing a
/// *different* meeting while some other recording is active. That puts
/// STT-decode-heavy blocking work in direct CPU contention with the live
/// recording's decode worker, which is the exact resource-starvation class
/// that caused the dropped-audio-chunk bug this whole ingest feature exists
/// to repair.
///
/// This pins the combined policy the fixed `retranscribe_meeting_blocking`
/// must implement: `guard_not_recording` alone is demonstrably
/// insufficient (it returns `Ok` for a different meeting), so
/// `ingest::guard_import` — which discriminates only on "is any recording
/// active", never on meeting identity — must also run, unconditionally.
#[test]
fn retranscribe_is_refused_while_any_recording_is_active_even_for_a_different_meeting() {
    // Arrange: a recording is active for `recording_meeting`, and the
    // re-transcribe request targets an unrelated `target_meeting`.
    let recording_meeting = MeetingId::new();
    let target_meeting = MeetingId::new();

    // Act / Assert: `guard_not_recording` alone — the *only* check the
    // unfixed code ran — wrongly allows this, because the two meeting ids
    // differ.
    let not_recording_result = guard_not_recording(Some(recording_meeting), target_meeting);
    assert!(
        not_recording_result.is_ok(),
        "guard_not_recording is meeting-scoped and must not itself catch a different \
         meeting's recording — this is exactly the gap guard_import must close"
    );

    // Act / Assert: `guard_import`, driven only by whether *any* recording
    // is active, correctly refuses regardless of which meeting is
    // recording. `retranscribe_meeting_blocking` must call this alongside
    // `guard_not_recording`, not instead of it.
    let recording_active = true; // any session present, independent of meeting id
    let guard_import_result = guard_import(false, recording_active);
    assert!(
        matches!(guard_import_result, Err(AppError::Busy(_))),
        "guard_import must refuse a re-transcribe while any recording is active, \
         regardless of which meeting is being recorded"
    );
}

/// Sanity check: once no recording is active at all, both guards agree the
/// re-transcribe may proceed (baseline for the test above).
#[test]
fn retranscribe_is_allowed_when_no_recording_is_active() {
    // Arrange
    let target_meeting = MeetingId::new();

    // Act
    let not_recording_result = guard_not_recording(None, target_meeting);
    let guard_import_result = guard_import(false, false);

    // Assert
    assert!(not_recording_result.is_ok());
    assert!(guard_import_result.is_ok());
}

// --- HIGH finding (3): replace-audio re-transcribe cancellation safety ---

/// `convert_to_canonical_wav` itself must be cancellation-aware (rather
/// than only `transcribe_wav_streaming`'s loop, as before the fix), and the
/// replace-audio re-transcribe path must convert into a *separate staging
/// path*, never directly over the meeting's existing `audio.wav` — so a
/// cancellation mid-conversion can never leave new audio on disk paired
/// with the old (stale) transcript. See `ingest.rs`'s own
/// `convert_to_canonical_wav_cancelled_while_replacing_audio_leaves_the_existing_file_untouched`
/// test for the mechanism-level regression guard; this test additionally
/// documents the exact call shape `run_retranscribe`'s `Some(supplied)`
/// branch must use.
#[test]
fn replace_audio_conversion_cancelled_before_it_starts_never_touches_the_staging_or_dest_path() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let source = dir.path().join("new-source.wav");
    write_wav_fixture(&source, 2.0, 16_000);

    let dest = dir.path().join("audio.wav");
    let original_bytes = b"PRE-EXISTING-MEETING-AUDIO";
    std::fs::write(&dest, original_bytes).expect("seed pre-existing audio.wav");

    // `run_retranscribe`'s replace-audio branch must derive a staging path
    // distinct from `dest` (e.g. `dest.with_extension("wav.staged")`) and
    // convert into *that*, never into `dest` directly.
    let staged = dest.with_extension("wav.staged");
    let cancel = AtomicBool::new(true);

    // Act
    let result = convert_to_canonical_wav(&source, &staged, &cancel);

    // Assert
    assert!(
        matches!(result, Err(AppError::Cancelled)),
        "expected AppError::Cancelled, got: {result:?}"
    );
    assert!(
        !staged.exists(),
        "a cancelled conversion must not leave a staged replacement file behind"
    );
    let dest_bytes = std::fs::read(&dest).expect("dest must still exist");
    assert_eq!(
        dest_bytes, original_bytes,
        "the meeting's existing audio.wav must be byte-identical after a cancelled \
         replace-audio conversion — it was never the conversion's destination"
    );
}

// --- Cancel during the transcribe phase --------------------------------

/// Regression test for the HIGH finding (2) cancellation-error-surface fix:
/// cancelling mid-transcribe must return `AppError::Cancelled` (which
/// serializes as `{code: "CANCELLED"}`), not `AppError::Store` (which
/// serializes as a generic `{code: "STORE"}` error banner) — the Angular
/// side is being updated in parallel to suppress the error banner
/// specifically for `code: "CANCELLED"`, so the variant is a contract, not
/// cosmetic.
///
/// Ignored by default: constructing a real `SimulatedStreamer` requires a
/// loaded `SttEngine`, which requires the downloaded Parakeet-TDT + Silero
/// VAD model artifacts (`./scripts/download-models.sh`) and several
/// seconds to load — exactly the situation
/// `crates/myna-stt/src/stream.rs`'s existing
/// `with_options_emit_partials_false_suppresses_partial_events_end_to_end`
/// test is gated the same way for. Run manually with model artifacts
/// present via `cargo test --workspace --locked -- --ignored
/// transcribe_wav_streaming_cancelled_before_it_starts_returns_cancelled`.
#[test]
#[ignore = "requires downloaded Parakeet-TDT + Silero VAD model artifacts to construct a real \
            SttEngine/SimulatedStreamer; run manually via \
            `./scripts/download-models.sh` then `cargo test --workspace --locked -- --ignored`"]
fn transcribe_wav_streaming_cancelled_before_it_starts_returns_cancelled() {
    use myna_app::ingest::transcribe_wav_streaming;
    use myna_stt::{SimulatedStreamer, SttConfig, SttEngine, SttEvent, VadConfig};
    use std::sync::Arc;

    // Arrange: a real (model-backed) streamer — never actually driven,
    // since cancellation is checked before the first block is read — and a
    // cancellation flag already set before the call.
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let models_root = Path::new(manifest_dir).join("../../models");
    let engine = SttEngine::load(&SttConfig {
        model_dir: models_root.join("parakeet-tdt-0.6b-v3-int8"),
        num_threads: 2,
        debug: false,
        ..SttConfig::default()
    })
    .expect("load a real SttEngine from downloaded model artifacts");
    let vad_cfg = VadConfig {
        model_path: models_root.join("silero-vad/silero_vad.onnx"),
        ..VadConfig::default()
    };
    let mut streamer =
        SimulatedStreamer::new(Arc::new(engine), &vad_cfg).expect("construct streamer");

    let dir = tempfile::tempdir().expect("tempdir");
    let wav_path = dir.path().join("source.wav");
    write_wav_fixture(&wav_path, 2.0, 16_000);

    let cancel = AtomicBool::new(true);
    let mut on_event = |_event: SttEvent| {};
    let mut on_progress = |_processed: f32, _total: f32| {};

    // Act
    let result = transcribe_wav_streaming(
        &wav_path,
        &mut streamer,
        &cancel,
        &mut on_event,
        &mut on_progress,
    );

    // Assert
    assert!(
        matches!(result, Err(AppError::Cancelled)),
        "expected AppError::Cancelled, got: {result:?}"
    );
}
