//! Audio import ("ingest") pipeline: validating a user-supplied audio file,
//! converting it to Myna's canonical 16 kHz mono WAV format, and re-running
//! transcription against an existing or newly imported recording.
//!
//! RED-step stub: every public function below is declared with an
//! `unimplemented!()` body only so `tests/ingest.rs` (and this module's own
//! `#[cfg(test)] mod tests`) type-check and can run (and fail) before the
//! GREEN step fills in real bodies. Do not add real logic here — that is the
//! `coder` agent's job, driven by these tests.

use std::path::{Path, PathBuf};

use myna_stt::Transcript;

use crate::error::AppError;

/// Length, in seconds, of each block [`convert_to_canonical_wav`] reads and
/// resamples at a time, so a long import never loads the whole source file
/// into memory at once.
pub const INGEST_CHUNK_SEC: f32 = 1.0;

/// File extensions [`validate_source_path`] accepts as an import source,
/// compared case-insensitively.
pub const SUPPORTED_IMPORT_EXTENSIONS: &[&str] = &["wav"];

/// Pure guard for starting an audio import: `Busy` when an import is already
/// running, or when a recording is active (importing while recording would
/// race the recording's own `audio.wav` write). Mirrors
/// `crate::session::guard_start` / `guard_stop`.
pub fn guard_import(import_in_flight: bool, recording_active: bool) -> Result<(), AppError> {
    let _ = (import_in_flight, recording_active);
    unimplemented!("guard_import: RED-step stub, implemented in the GREEN step")
}

/// Canonicalizes and validates a user-supplied source path for import.
///
/// Errors when: the path is missing, is not a file, its extension is not in
/// [`SUPPORTED_IMPORT_EXTENSIONS`] (case-insensitively), or the canonicalized
/// path resolves inside `meetings_root` (which would mean reading the very
/// `audio.wav` the import is about to overwrite).
pub fn validate_source_path(path: &Path, meetings_root: &Path) -> Result<PathBuf, AppError> {
    let _ = (path, meetings_root);
    unimplemented!("validate_source_path: RED-step stub, implemented in the GREEN step")
}

/// Converts any WAV (any sample rate, any channel count, int or float PCM)
/// at `src` into a canonical 16 kHz mono WAV at `dest`, streaming
/// [`INGEST_CHUNK_SEC`]-sized blocks rather than loading the whole file.
///
/// Writes to `dest.with_extension("wav.tmp")` first, then renames over
/// `dest`, so a failed conversion never destroys an existing `audio.wav`.
/// Returns the destination's duration in seconds.
pub fn convert_to_canonical_wav(src: &Path, dest: &Path) -> Result<f32, AppError> {
    let _ = (src, dest);
    unimplemented!("convert_to_canonical_wav: RED-step stub, implemented in the GREEN step")
}

/// Derives whether a meeting has recorded/imported audio, from the
/// filesystem rather than `Meeting::audio_path` (which currently has zero
/// callers and is always `None` on disk).
pub fn has_audio(audio_path: &Path) -> bool {
    let _ = audio_path;
    unimplemented!("has_audio: RED-step stub, implemented in the GREEN step")
}

/// Backs up an existing transcript to `<meeting_dir>/transcript.previous.json`
/// before a re-transcribe overwrites it, so a bad re-transcription doesn't
/// silently destroy the previous result.
pub fn backup_transcript(meeting_dir: &Path, transcript: &Transcript) -> Result<(), AppError> {
    let _ = (meeting_dir, transcript);
    unimplemented!("backup_transcript: RED-step stub, implemented in the GREEN step")
}

/// Pure decision: resolves the source path a re-transcribe should read from.
/// An explicitly `supplied` path always wins; otherwise falls back to
/// `existing_audio` (the meeting's current `audio.wav`, when
/// [`has_audio`] is `true`); errors with [`AppError::NotFound`] when neither
/// is available.
pub fn resolve_reimport_source(
    existing_audio: Option<PathBuf>,
    supplied: Option<PathBuf>,
) -> Result<PathBuf, AppError> {
    let _ = (existing_audio, supplied);
    unimplemented!("resolve_reimport_source: RED-step stub, implemented in the GREEN step")
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- guard_import ---------------------------------------------------

    #[test]
    fn guard_import_allows_when_nothing_is_in_flight() {
        // Arrange / Act
        let result = guard_import(false, false);

        // Assert
        assert!(result.is_ok());
    }

    #[test]
    fn guard_import_rejects_when_an_import_is_already_running() {
        // Act
        let err = guard_import(true, false).expect_err("should be busy");

        // Assert: variant is Busy, and the message names *this* conflict.
        assert!(matches!(err, AppError::Busy(_)));
        let message = err.to_string();
        assert!(
            message.to_lowercase().contains("import"),
            "message should name the import conflict, got: {message}"
        );
    }

    #[test]
    fn guard_import_rejects_when_a_recording_is_active() {
        // Act
        let err = guard_import(false, true).expect_err("should be busy");

        // Assert: variant is Busy, and the message names *this* conflict.
        assert!(matches!(err, AppError::Busy(_)));
        let message = err.to_string();
        assert!(
            message.to_lowercase().contains("recording"),
            "message should name the recording conflict, got: {message}"
        );
    }

    #[test]
    fn guard_import_rejects_when_both_import_and_recording_are_active() {
        // Act
        let err = guard_import(true, true).expect_err("should be busy");

        // Assert
        assert!(matches!(err, AppError::Busy(_)));
    }

    // --- validate_source_path --------------------------------------------

    #[test]
    fn validate_source_path_rejects_a_missing_file() {
        // Arrange
        let dir = tempfile::tempdir().expect("tempdir");
        let meetings_root = dir.path().join("meetings");
        let missing = dir.path().join("does-not-exist.wav");

        // Act
        let result = validate_source_path(&missing, &meetings_root);

        // Assert
        assert!(result.is_err(), "a missing path must not validate");
    }

    #[test]
    fn validate_source_path_rejects_a_directory() {
        // Arrange
        let dir = tempfile::tempdir().expect("tempdir");
        let meetings_root = dir.path().join("meetings");
        let sub_dir = dir.path().join("a-directory.wav");
        std::fs::create_dir_all(&sub_dir).expect("create dir fixture");

        // Act
        let result = validate_source_path(&sub_dir, &meetings_root);

        // Assert
        assert!(
            result.is_err(),
            "a directory (even with a .wav name) must not validate as a source file"
        );
    }

    #[test]
    fn validate_source_path_rejects_an_unsupported_extension_and_names_it() {
        // Arrange
        let dir = tempfile::tempdir().expect("tempdir");
        let meetings_root = dir.path().join("meetings");
        let mp3 = dir.path().join("recording.mp3");
        std::fs::write(&mp3, b"not really an mp3").expect("write fixture");

        // Act
        let err = validate_source_path(&mp3, &meetings_root).expect_err("mp3 must be rejected");

        // Assert: message names the offending extension AND the supported ones.
        let message = err.to_string().to_lowercase();
        assert!(
            message.contains("mp3"),
            "message should name the offending extension, got: {message}"
        );
        assert!(
            message.contains("wav"),
            "message should list the supported extensions, got: {message}"
        );
    }

    #[test]
    fn validate_source_path_rejects_a_path_with_no_extension() {
        // Arrange
        let dir = tempfile::tempdir().expect("tempdir");
        let meetings_root = dir.path().join("meetings");
        let no_ext = dir.path().join("recording");
        std::fs::write(&no_ext, b"data").expect("write fixture");

        // Act
        let result = validate_source_path(&no_ext, &meetings_root);

        // Assert
        assert!(result.is_err(), "a path with no extension must be rejected");
    }

    #[test]
    fn validate_source_path_accepts_uppercase_wav_extension_case_insensitively() {
        // Arrange
        let dir = tempfile::tempdir().expect("tempdir");
        let meetings_root = dir.path().join("meetings");
        let uppercase_wav = dir.path().join("RECORDING.WAV");
        std::fs::write(&uppercase_wav, b"RIFF....WAVEfmt ").expect("write fixture");

        // Act
        let result = validate_source_path(&uppercase_wav, &meetings_root);

        // Assert
        assert!(
            result.is_ok(),
            "uppercase .WAV must validate case-insensitively, got: {result:?}"
        );
    }

    #[test]
    fn validate_source_path_rejects_a_path_inside_meetings_root() {
        // Arrange
        let dir = tempfile::tempdir().expect("tempdir");
        let meetings_root = dir.path().join("meetings");
        let meeting_dir = meetings_root.join("some-meeting-id");
        std::fs::create_dir_all(&meeting_dir).expect("create meeting dir fixture");
        let inside_path = meeting_dir.join("audio.wav");
        std::fs::write(&inside_path, b"RIFF....WAVEfmt ").expect("write fixture");

        // Act
        let result = validate_source_path(&inside_path, &meetings_root);

        // Assert
        assert!(
            result.is_err(),
            "a source path already inside meetings_root must be rejected \
             (it would read the file about to be overwritten)"
        );
    }
}
