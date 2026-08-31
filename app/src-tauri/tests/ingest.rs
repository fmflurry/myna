//! Integration tests for the audio-ingest pipeline (`myna_app::ingest`):
//! WAV canonicalization, transcript backup, `has_audio` derivation, and
//! re-import source resolution — exercised against real temporary
//! directories, mirroring `tests/store.rs`'s tempdir-backed style.
//!
//! All WAV fixtures are generated at test time with `hound`; no binary
//! fixtures are committed.

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use myna_app::error::AppError;
use myna_app::ingest::{
    backup_transcript, convert_to_canonical_wav, has_audio, insert_final_segment,
    merge_track_transcripts, resolve_reimport_source, resolve_retranscribe_tracks,
    transcribe_wav_streaming, SpeakerTrack,
};
use myna_app::store::fs_store::FsMeetingStore;
use myna_app::store::MeetingStore;
use myna_stt::{
    SimulatedStreamer, Speaker, StreamerOptions, SttConfig, SttEngine, Transcript,
    TranscriptSegment, VadConfig,
};

/// Writes a `frames`-frame WAV fixture at `path`: 16-bit PCM, `sample_rate`
/// Hz, `channels` channels, containing a simple sine tone (content doesn't
/// matter for these tests — only rate/channel/frame-count shape does).
fn write_wav_fixture(path: &Path, sample_rate: u32, channels: u16, frames: usize) {
    let spec = hound::WavSpec {
        channels,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec).expect("create wav fixture");
    for i in 0..frames {
        let t = i as f32 / sample_rate as f32;
        let sample = (t * 440.0 * std::f32::consts::TAU).sin();
        let pcm = (sample * i16::MAX as f32 * 0.5) as i16;
        for _ in 0..channels {
            writer.write_sample(pcm).expect("write sample");
        }
    }
    writer.finalize().expect("finalize wav fixture");
}

// --- convert_to_canonical_wav ------------------------------------------

#[test]
fn convert_to_canonical_wav_downsamples_48k_stereo_to_16k_mono() {
    // Arrange: 2.0s of 48 kHz stereo audio.
    let dir = tempfile::tempdir().expect("tempdir");
    let src = dir.path().join("source.wav");
    let dest = dir.path().join("audio.wav");
    let src_frames: usize = 96_000;
    write_wav_fixture(&src, 48_000, 2, src_frames);

    // Act
    let cancel = AtomicBool::new(false);
    let duration_sec =
        convert_to_canonical_wav(&src, &dest, &cancel).expect("convert_to_canonical_wav");

    // Assert: dest is 16 kHz mono.
    let dest_reader = hound::WavReader::open(&dest).expect("open dest wav");
    let dest_spec = dest_reader.spec();
    let dest_frames = dest_reader.duration() as u64;
    assert_eq!(
        dest_spec.sample_rate, 16_000,
        "dest must be resampled to 16 kHz"
    );
    assert_eq!(dest_spec.channels, 1, "dest must be downmixed to mono");

    // Assert: frame count is within tolerance of src_frames / 3.
    //
    // Tolerance rationale: the sinc resampler (myna_audio::Resampler /
    // rubato) trims a fixed output delay and zero-pads the final flushed
    // block up to its internal chunk size before partially truncating it
    // back via `Indexing::partial_len` — both introduce small, deterministic
    // rounding at the boundaries rather than exact arithmetic scaling. 1% of
    // the expected frame count (floor 50 frames, ~3ms at 16kHz) is generous
    // enough to absorb that rounding while still catching a gross bug (wrong
    // ratio, wrong channel count, dropped blocks).
    let expected_frames = src_frames as u64 / 3;
    let tolerance = (expected_frames / 100).max(50);
    let diff = (dest_frames as i64 - expected_frames as i64).unsigned_abs();
    assert!(
        diff <= tolerance,
        "dest frame count {dest_frames} should be within {tolerance} of expected \
         {expected_frames} (src {src_frames} frames / 3)"
    );

    // Assert: returned duration matches dest frame count / 16000.
    let expected_duration = dest_frames as f32 / 16_000.0;
    assert!(
        (duration_sec - expected_duration).abs() < 0.01,
        "returned duration_sec {duration_sec} should match dest frame count / 16000 \
         ({expected_duration})"
    );
}

#[test]
fn convert_to_canonical_wav_on_already_canonical_source_preserves_frame_count() {
    // Arrange: source already 16 kHz mono.
    let dir = tempfile::tempdir().expect("tempdir");
    let src = dir.path().join("source.wav");
    let dest = dir.path().join("audio.wav");
    let src_frames: usize = 32_000; // 2.0s at 16kHz
    write_wav_fixture(&src, 16_000, 1, src_frames);

    // Act
    let cancel = AtomicBool::new(false);
    convert_to_canonical_wav(&src, &dest, &cancel).expect("convert_to_canonical_wav");

    // Assert: identity path must not corrupt or drop samples — exact match.
    let dest_reader = hound::WavReader::open(&dest).expect("open dest wav");
    let dest_spec = dest_reader.spec();
    let dest_frames = dest_reader.duration() as u64;
    assert_eq!(dest_spec.sample_rate, 16_000);
    assert_eq!(dest_spec.channels, 1);
    assert_eq!(
        dest_frames, src_frames as u64,
        "an already-16kHz-mono source must produce a dest with the identical frame count"
    );
}

#[test]
fn convert_to_canonical_wav_leaves_existing_dest_untouched_on_failure() {
    // Arrange: an invalid (non-WAV) source, and a dest that already has
    // known, meaningful content (as if a previous successful import wrote
    // it).
    let dir = tempfile::tempdir().expect("tempdir");
    let invalid_src = dir.path().join("not-a-wav.wav");
    std::fs::write(&invalid_src, b"this is not a RIFF/WAVE file at all")
        .expect("write invalid fixture");

    let dest = dir.path().join("audio.wav");
    let original_content: &[u8] = b"pre-existing canonical audio content";
    std::fs::write(&dest, original_content).expect("seed existing dest");

    // Act
    let cancel = AtomicBool::new(false);
    let result = convert_to_canonical_wav(&invalid_src, &dest, &cancel);

    // Assert: conversion fails rather than silently producing garbage.
    assert!(
        result.is_err(),
        "converting a non-WAV source must fail, not succeed"
    );

    // Assert: atomicity — dest is byte-identical to before, and no .tmp file
    // is left behind.
    let dest_content = std::fs::read(&dest).expect("dest should still exist");
    assert_eq!(
        dest_content, original_content,
        "a failed conversion must leave the pre-existing dest byte-identical"
    );
    let tmp_path = dest.with_extension("wav.tmp");
    assert!(
        !tmp_path.exists(),
        "a failed conversion must not leave a .wav.tmp file behind"
    );
}

// --- backup_transcript ---------------------------------------------------

#[test]
fn backup_transcript_copies_existing_transcript_before_overwrite() {
    // Arrange: a saved meeting that already has a transcript.
    let dir = tempfile::tempdir().expect("tempdir");
    let store = FsMeetingStore::new(dir.path());
    let transcript = Transcript::default().with_segment(TranscriptSegment {
        start_sec: 0.0,
        end_sec: 1.5,
        text: "original transcript".to_string(),
        speaker: myna_stt::Speaker::default(),
        speaker_pinned: false,
    });
    let meeting = store.create("Re-transcribe me").expect("create");
    let with_transcript = meeting.with_transcript(transcript.clone());
    store.save(&with_transcript).expect("save with transcript");

    let meeting_dir = dir.path().join("meetings").join(meeting.id.to_string());
    let backup_path = meeting_dir.join("transcript.previous.json");
    assert!(
        !backup_path.exists(),
        "no backup should exist before backup_transcript runs"
    );

    // Act
    backup_transcript(
        &meeting_dir,
        &transcript,
        &std::collections::BTreeMap::new(),
    )
    .expect("backup_transcript");

    // Assert: transcript.previous.json now holds the original transcript.
    assert!(
        backup_path.exists(),
        "backup_transcript must write transcript.previous.json"
    );
    let raw = std::fs::read_to_string(&backup_path).expect("read backup");
    let restored: Transcript = serde_json::from_str(&raw).expect("backup must be valid json");
    assert_eq!(
        restored, transcript,
        "backup content must round-trip the original transcript exactly"
    );
}

// --- has_audio -------------------------------------------------------------

#[test]
fn has_audio_reflects_whether_audio_wav_exists_on_disk() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let store = FsMeetingStore::new(dir.path());
    let meeting = store.create("No audio yet").expect("create");
    let audio_path = store.audio_path(meeting.id);

    // Assert: no audio.wav yet.
    assert!(
        !has_audio(&audio_path),
        "a fresh meeting has no audio.wav yet"
    );

    // Act: touch audio.wav.
    std::fs::write(&audio_path, b"RIFF....WAVEfmt ").expect("touch audio.wav");

    // Assert: now true.
    assert!(
        has_audio(&audio_path),
        "has_audio must reflect audio.wav's presence once it is written"
    );
}

// --- resolve_retranscribe_tracks (Phase 5: speaker-aware re-transcribe) ----

#[test]
fn resolve_retranscribe_tracks_returns_both_tracks_speaker_tagged_when_both_exist() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let mic_track = dir.path().join("track-mic.wav");
    let system_track = dir.path().join("track-system.wav");
    write_wav_fixture(&mic_track, 16_000, 1, 1_600);
    write_wav_fixture(&system_track, 16_000, 1, 1_600);

    // Act
    let tracks = resolve_retranscribe_tracks(&mic_track, &system_track);

    // Assert
    assert_eq!(
        tracks.len(),
        2,
        "both track files exist, so both must be returned"
    );
    assert_eq!(tracks[0].path, mic_track);
    assert_eq!(tracks[0].speaker, Speaker::me());
    assert_eq!(tracks[1].path, system_track);
    assert_eq!(tracks[1].speaker, Speaker::others());
}

#[test]
fn resolve_retranscribe_tracks_returns_only_mic_when_only_mic_track_exists() {
    // Arrange: only `track-mic.wav` exists on disk.
    let dir = tempfile::tempdir().expect("tempdir");
    let mic_track = dir.path().join("track-mic.wav");
    let system_track = dir.path().join("track-system.wav"); // never written
    write_wav_fixture(&mic_track, 16_000, 1, 1_600);

    // Act
    let tracks = resolve_retranscribe_tracks(&mic_track, &system_track);

    // Assert: only the mic track, stamped `me` -- the missing system track
    // must never be synthesized.
    assert_eq!(tracks.len(), 1, "the absent system track must not appear");
    assert_eq!(tracks[0].path, mic_track);
    assert_eq!(tracks[0].speaker, Speaker::me());
}

#[test]
fn resolve_retranscribe_tracks_returns_empty_when_neither_track_exists() {
    // Arrange: a legacy meeting (or an externally imported one) with no
    // per-track WAVs at all.
    let dir = tempfile::tempdir().expect("tempdir");
    let mic_track = dir.path().join("track-mic.wav");
    let system_track = dir.path().join("track-system.wav");

    // Act
    let tracks = resolve_retranscribe_tracks(&mic_track, &system_track);

    // Assert: empty tells the caller to fall back to `audio.wav` itself,
    // stamped `unknown` -- never fabricating attribution that was never
    // captured.
    assert!(
        tracks.is_empty(),
        "neither track file exists, so no track must be returned"
    );
}

// --- merge_track_transcripts (Phase 5: speaker-aware re-transcribe) --------

#[test]
fn merge_track_transcripts_stamps_and_sorts_both_speakers_ascending_by_start_sec() {
    // Arrange: mic segments start later than the interleaved system segment,
    // so a naive concatenation (mic-then-system) would NOT already be sorted
    // -- only an actual sort proves the merge is speaker- and time-aware.
    let mic_transcript = Transcript::default()
        .with_segment(TranscriptSegment {
            start_sec: 2.0,
            end_sec: 3.0,
            text: "mic second".to_string(),
            speaker: Speaker::default(),
            speaker_pinned: false,
        })
        .with_segment(TranscriptSegment {
            start_sec: 4.0,
            end_sec: 5.0,
            text: "mic third".to_string(),
            speaker: Speaker::default(),
            speaker_pinned: false,
        });
    let system_transcript = Transcript::default().with_segment(TranscriptSegment {
        start_sec: 0.0,
        end_sec: 1.0,
        text: "system first".to_string(),
        speaker: Speaker::default(),
        speaker_pinned: false,
    });

    // Act
    let merged = merge_track_transcripts(vec![
        (Speaker::me(), mic_transcript),
        (Speaker::others(), system_transcript),
    ]);

    // Assert: ascending by start_sec...
    let starts: Vec<f32> = merged.segments.iter().map(|s| s.start_sec).collect();
    assert_eq!(
        starts,
        vec![0.0, 2.0, 4.0],
        "merged segments must be sorted ascending by start_sec"
    );
    // ...and both speakers are present, each stamped correctly.
    assert_eq!(merged.segments[0].speaker, Speaker::others());
    assert_eq!(merged.segments[0].text, "system first");
    assert_eq!(merged.segments[1].speaker, Speaker::me());
    assert_eq!(merged.segments[1].text, "mic second");
    assert_eq!(merged.segments[2].speaker, Speaker::me());
    assert_eq!(merged.segments[2].text, "mic third");
}

#[test]
fn merge_track_transcripts_with_only_a_mic_track_stamps_everything_me_never_fabricating_others() {
    // Arrange: a mic-only capture -- there is no system-track transcript at
    // all (not even an empty one), mirroring what `resolve_retranscribe_tracks`
    // returns when only `track-mic.wav` exists.
    let mic_transcript = Transcript::default()
        .with_segment(TranscriptSegment {
            start_sec: 0.0,
            end_sec: 1.0,
            text: "hello".to_string(),
            speaker: Speaker::default(),
            speaker_pinned: false,
        })
        .with_segment(TranscriptSegment {
            start_sec: 1.0,
            end_sec: 2.0,
            text: "team".to_string(),
            speaker: Speaker::default(),
            speaker_pinned: false,
        });

    // Act
    let merged = merge_track_transcripts(vec![(Speaker::me(), mic_transcript)]);

    // Assert: every segment is `me`, and none is `others` or `others:<id>`.
    assert_eq!(merged.segments.len(), 2);
    assert!(
        merged.segments.iter().all(|s| s.speaker == Speaker::me()),
        "a mic-only re-transcribe must stamp every segment `me`, got: {:?}",
        merged.segments
    );
}

#[test]
fn merge_track_transcripts_fallback_case_stamps_everything_unknown() {
    // Arrange: the "neither track file exists" fallback -- a single
    // pseudo-track built from `audio.wav`, stamped `unknown` per
    // `run_retranscribe`'s documented fallback (never a fabricated `me` or
    // `others`).
    let fallback_transcript = Transcript::default().with_segment(TranscriptSegment {
        start_sec: 0.0,
        end_sec: 1.0,
        text: "hello team".to_string(),
        speaker: Speaker::default(),
        speaker_pinned: false,
    });

    // Act
    let merged = merge_track_transcripts(vec![(Speaker::unknown(), fallback_transcript)]);

    // Assert
    assert_eq!(merged.segments.len(), 1);
    assert_eq!(merged.segments[0].speaker, Speaker::unknown());
}

// --- insert_final_segment (live-decode ordering fix) -----------------------

fn segment_at(start_sec: f32, text: &str) -> TranscriptSegment {
    TranscriptSegment {
        start_sec,
        end_sec: start_sec + 1.0,
        text: text.to_string(),
        speaker: Speaker::default(),
        speaker_pinned: false,
    }
}

#[test]
fn insert_final_segment_keeps_transcript_ascending_by_start_sec_regardless_of_arrival_order() {
    // Arrange: mirrors the real bug report -- two short mic segments finish
    // decoding (and so arrive) before a long system segment that actually
    // started earlier. A naive append (the pre-fix behavior) would leave the
    // 0s segment third; only a sorted insert produces ascending order.
    let mut transcript = Transcript::default();

    // Act: feed finalized segments out of chronological order.
    insert_final_segment(&mut transcript, segment_at(4.0, "mic first arrival"));
    insert_final_segment(&mut transcript, segment_at(16.0, "mic second arrival"));
    insert_final_segment(&mut transcript, segment_at(0.0, "system third arrival"));

    // Assert
    let starts: Vec<f32> = transcript.segments.iter().map(|s| s.start_sec).collect();
    assert_eq!(
        starts,
        vec![0.0, 4.0, 16.0],
        "transcript must stay ordered ascending by start_sec regardless of arrival order, got: {:?}",
        transcript.segments
    );
}

#[test]
fn insert_final_segment_preserves_arrival_order_among_equal_start_sec() {
    // Arrange / Act: three segments sharing the same start_sec, inserted in
    // a specific arrival order.
    let mut transcript = Transcript::default();
    insert_final_segment(&mut transcript, segment_at(1.0, "first"));
    insert_final_segment(&mut transcript, segment_at(1.0, "second"));
    insert_final_segment(&mut transcript, segment_at(1.0, "third"));

    // Assert: stable insert -- equal start_sec keeps arrival order, never an
    // unstable sort's arbitrary reordering.
    let texts: Vec<&str> = transcript
        .segments
        .iter()
        .map(|s| s.text.as_str())
        .collect();
    assert_eq!(texts, vec!["first", "second", "third"]);
}

// --- backup_transcript: still round-trips a dual-track (multi-speaker) ----
// --- transcript, unchanged from a single-speaker one -----------------------

#[test]
fn backup_transcript_round_trips_a_dual_track_speaker_tagged_transcript() {
    // Arrange: a transcript exactly like `merge_track_transcripts` would
    // produce from a dual-track re-transcribe -- both `me` and bare `others`
    // segments, interleaved by start_sec.
    let dir = tempfile::tempdir().expect("tempdir");
    let meeting_dir = dir.path().join("meeting");
    std::fs::create_dir_all(&meeting_dir).expect("create meeting dir fixture");

    let transcript = Transcript::default()
        .with_segment(TranscriptSegment {
            start_sec: 0.0,
            end_sec: 1.0,
            text: "hi there".to_string(),
            speaker: Speaker::others(),
            speaker_pinned: false,
        })
        .with_segment(TranscriptSegment {
            start_sec: 1.0,
            end_sec: 2.0,
            text: "hello".to_string(),
            speaker: Speaker::me(),
            speaker_pinned: false,
        });

    // Act
    backup_transcript(
        &meeting_dir,
        &transcript,
        &std::collections::BTreeMap::new(),
    )
    .expect("backup_transcript");

    // Assert: the backup round-trips both speaker labels exactly --
    // `backup_transcript` itself is speaker-agnostic (it just serializes
    // whatever `Transcript` it's given), so this pins that the pre-existing
    // backup mechanism keeps working unchanged now that dual-track
    // re-transcribes feed it multi-speaker transcripts.
    let backup_path = meeting_dir.join("transcript.previous.json");
    let raw = std::fs::read_to_string(&backup_path).expect("read backup");
    let restored: Transcript = serde_json::from_str(&raw).expect("backup must be valid json");
    assert_eq!(restored, transcript);
    assert_eq!(restored.segments[0].speaker, Speaker::others());
    assert_eq!(restored.segments[1].speaker, Speaker::me());
}

// --- transcribe_tracks_streaming: full pipeline, model-backed --------------

/// Resolves the repo root the same way [`parakeet_dir`]/[`silero_vad_path`]
/// below do, for building canonical per-track WAV fixtures from the real
/// speech fixture at test time.
fn convert_speech_fixture_to_canonical(dest: &Path) {
    let cancel = std::sync::atomic::AtomicBool::new(false);
    convert_to_canonical_wav(
        &parakeet_dir().join("test_wavs").join("en.wav"),
        dest,
        &cancel,
    )
    .expect("convert real speech fixture to canonical 16kHz mono");
}

#[test]
#[ignore = "requires downloaded Parakeet-TDT + Silero VAD models (see \
            scripts/download-models.sh) to construct a real SttEngine/SimulatedStreamer. \
            Run manually with `cargo test -p myna-app --locked -- --ignored`."]
fn transcribe_tracks_streaming_dual_track_end_to_end_stamps_both_speakers_sorted() {
    // Arrange
    if !models_present() {
        eprintln!("skipping: models not present (see scripts/download-models.sh)");
        return;
    }
    let dir = tempfile::tempdir().expect("tempdir");
    let mic_track = dir.path().join("track-mic.wav");
    let system_track = dir.path().join("track-system.wav");
    convert_speech_fixture_to_canonical(&mic_track);
    convert_speech_fixture_to_canonical(&system_track);

    let engine = Arc::new(
        SttEngine::load(&SttConfig {
            model_dir: parakeet_dir(),
            ..Default::default()
        })
        .expect("Parakeet-TDT model loads"),
    );
    let vad_cfg = VadConfig {
        model_path: silero_vad_path(),
        ..Default::default()
    };
    let cancel = AtomicBool::new(false);
    let tracks = vec![
        SpeakerTrack {
            path: mic_track,
            speaker: Speaker::me(),
        },
        SpeakerTrack {
            path: system_track,
            speaker: Speaker::others(),
        },
    ];

    // Act
    let (transcript, _duration_sec) = myna_app::ingest::transcribe_tracks_streaming(
        &tracks,
        &engine,
        &vad_cfg,
        &cancel,
        &mut |_event| {},
        &mut |_processed, _total| {},
    )
    .expect("dual-track transcribe succeeds");

    // Assert: both speakers present, and ascending by start_sec.
    assert!(
        !transcript.segments.is_empty(),
        "expected at least one Final segment from real speech audio"
    );
    assert!(
        transcript
            .segments
            .iter()
            .any(|s| s.speaker == Speaker::me()),
        "expected at least one `me` segment (from track-mic.wav)"
    );
    assert!(
        transcript
            .segments
            .iter()
            .any(|s| s.speaker == Speaker::others()),
        "expected at least one bare `others` segment (from track-system.wav)"
    );
    for pair in transcript.segments.windows(2) {
        assert!(
            pair[0].start_sec <= pair[1].start_sec,
            "segments must be sorted ascending by start_sec: {:?}",
            transcript.segments
        );
    }
}

#[test]
#[ignore = "requires downloaded Parakeet-TDT + Silero VAD models (see \
            scripts/download-models.sh) to construct a real SttEngine/SimulatedStreamer. \
            Run manually with `cargo test -p myna-app --locked -- --ignored`."]
fn transcribe_tracks_streaming_legacy_fallback_from_audio_wav_succeeds_and_stamps_unknown() {
    // Arrange: a "legacy meeting" -- neither track file exists, only
    // `audio.wav` (here already staged canonical, as `run_retranscribe`'s
    // fallback branch would produce via `convert_to_canonical_wav`).
    if !models_present() {
        eprintln!("skipping: models not present (see scripts/download-models.sh)");
        return;
    }
    let dir = tempfile::tempdir().expect("tempdir");
    let mic_track = dir.path().join("track-mic.wav");
    let system_track = dir.path().join("track-system.wav");
    assert!(
        resolve_retranscribe_tracks(&mic_track, &system_track).is_empty(),
        "fixture setup: neither track file must exist for this test"
    );

    let staged_audio = dir.path().join("audio.wav.staged");
    convert_speech_fixture_to_canonical(&staged_audio);

    let engine = Arc::new(
        SttEngine::load(&SttConfig {
            model_dir: parakeet_dir(),
            ..Default::default()
        })
        .expect("Parakeet-TDT model loads"),
    );
    let vad_cfg = VadConfig {
        model_path: silero_vad_path(),
        ..Default::default()
    };
    let cancel = AtomicBool::new(false);
    let tracks = vec![SpeakerTrack {
        path: staged_audio,
        speaker: Speaker::unknown(),
    }];

    // Act
    let result = myna_app::ingest::transcribe_tracks_streaming(
        &tracks,
        &engine,
        &vad_cfg,
        &cancel,
        &mut |_event| {},
        &mut |_processed, _total| {},
    );

    // Assert: the meeting re-transcribes successfully rather than erroring,
    // and every segment is `unknown` -- no attribution is ever fabricated
    // for a source with no track separation.
    let (transcript, _duration_sec) = result.expect("legacy fallback re-transcribe must succeed");
    assert!(!transcript.segments.is_empty());
    assert!(
        transcript
            .segments
            .iter()
            .all(|s| s.speaker == Speaker::unknown()),
        "every segment from the audio.wav fallback must be `unknown`, got: {:?}",
        transcript.segments
    );
}

// --- resolve_reimport_source -----------------------------------------------

#[test]
fn resolve_reimport_source_errors_not_found_with_neither_existing_nor_supplied_audio() {
    // Act
    let result = resolve_reimport_source(None, None);

    // Assert
    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "re-transcribing with no existing audio.wav and no supplied path must be \
         AppError::NotFound, got: {result:?}"
    );
}

#[test]
fn resolve_reimport_source_prefers_an_explicitly_supplied_path() {
    // Arrange
    let existing = PathBuf::from("/tmp/existing-audio.wav");
    let supplied = PathBuf::from("/tmp/supplied-source.wav");

    // Act
    let result = resolve_reimport_source(Some(existing), Some(supplied.clone()))
        .expect("should resolve when a path is supplied");

    // Assert
    assert_eq!(
        result, supplied,
        "an explicitly supplied path must take precedence over the existing audio.wav"
    );
}

#[test]
fn resolve_reimport_source_falls_back_to_existing_audio_when_none_supplied() {
    // Arrange
    let existing = PathBuf::from("/tmp/existing-audio.wav");

    // Act
    let result = resolve_reimport_source(Some(existing.clone()), None)
        .expect("should resolve using the existing audio.wav");

    // Assert
    assert_eq!(result, existing);
}

// --- transcribe_wav_streaming -----------------------------------------

/// Resolves the repo root from this crate's manifest directory
/// (`app/src-tauri/../..`), mirroring `crates/myna-stt/tests/long_stream.rs`.
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

/// Whether the Parakeet-TDT and Silero VAD models
/// [`transcribe_wav_streaming_returns_err_and_accumulates_nothing_when_cancel_is_pre_set`]
/// depends on are present on disk — mirrors
/// `crates/myna-stt/tests/long_stream.rs`'s `models_present`.
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

    parakeet_ok && silero_vad_path().is_file()
}

#[test]
#[ignore = "requires downloaded Parakeet-TDT + Silero VAD models (see \
            scripts/download-models.sh) to construct a real SttEngine/SimulatedStreamer. \
            Run manually with `cargo test -p myna-app --locked -- --ignored`."]
fn transcribe_wav_streaming_returns_err_and_accumulates_nothing_when_cancel_is_pre_set() {
    // Arrange
    if !models_present() {
        eprintln!("skipping: models not present (see scripts/download-models.sh)");
        return;
    }

    let dir = tempfile::tempdir().expect("tempdir");
    let wav_path = dir.path().join("source.wav");
    write_wav_fixture(&wav_path, 16_000, 1, 16_000 * 3); // 3s of 16kHz mono audio

    let engine = SttEngine::load(&SttConfig {
        model_dir: parakeet_dir(),
        ..Default::default()
    })
    .expect("Parakeet-TDT model loads");
    let vad_cfg = VadConfig {
        model_path: silero_vad_path(),
        ..Default::default()
    };
    let mut streamer = SimulatedStreamer::with_options(
        Arc::new(engine),
        &vad_cfg,
        StreamerOptions {
            emit_partials: false,
        },
    )
    .expect("streamer constructs");

    let cancel = AtomicBool::new(true); // pre-set before the first block is read.
    let mut events_seen = 0usize;
    let mut progress_calls = 0usize;

    // Act
    let result = transcribe_wav_streaming(
        &wav_path,
        &mut streamer,
        &cancel,
        &mut |_event| events_seen += 1,
        &mut |_processed_sec, _total_sec| progress_calls += 1,
    );

    // Assert: errors, and never touches the streamer or reports any
    // progress — a pre-set cancel must be observed before the first block.
    assert!(
        result.is_err(),
        "a pre-set cancel flag must make transcribe_wav_streaming return Err"
    );
    assert_eq!(
        events_seen, 0,
        "no SttEvent should ever be produced once cancel was already set"
    );
    assert_eq!(
        progress_calls, 0,
        "no progress should ever be reported once cancel was already set"
    );
}
