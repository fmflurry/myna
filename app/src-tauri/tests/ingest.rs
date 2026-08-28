//! Integration tests for the audio-ingest pipeline (`myna_app::ingest`):
//! WAV canonicalization, transcript backup, `has_audio` derivation, and
//! re-import source resolution — exercised against real temporary
//! directories, mirroring `tests/store.rs`'s tempdir-backed style.
//!
//! All WAV fixtures are generated at test time with `hound`; no binary
//! fixtures are committed.

use std::path::{Path, PathBuf};

use myna_app::error::AppError;
use myna_app::ingest::{
    backup_transcript, convert_to_canonical_wav, has_audio, resolve_reimport_source,
};
use myna_app::store::fs_store::FsMeetingStore;
use myna_app::store::MeetingStore;
use myna_stt::{Transcript, TranscriptSegment};

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
    let duration_sec = convert_to_canonical_wav(&src, &dest).expect("convert_to_canonical_wav");

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
    convert_to_canonical_wav(&src, &dest).expect("convert_to_canonical_wav");

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
    let result = convert_to_canonical_wav(&invalid_src, &dest);

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
    backup_transcript(&meeting_dir, &transcript).expect("backup_transcript");

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
