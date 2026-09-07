//! Model-presence detection tests, exercised against `tempfile::tempdir()`.
//!
//! No test in this file loads a real model — [`models_status_at`] is a
//! pure function over a plain `&Path`.

use std::fs;
use std::path::Path;

use myna_app::commands::models::models_status_at;
use myna_app::paths;

/// Creates an empty file at `path`, creating parent directories as needed.
fn touch(path: &Path) {
    fs::create_dir_all(path.parent().expect("parent dir")).expect("create parent dir");
    fs::write(path, b"").expect("write file");
}

#[test]
fn reports_nothing_present_with_no_artifacts() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");

    // Act
    let status = models_status_at(dir.path());

    // Assert
    assert!(!status.all_present);
    assert!(!status.parakeet.present);
    assert!(!status.qwen.present);
    assert!(!status.silero.present);
    assert_eq!(
        status.parakeet.expected_files,
        vec![
            "encoder.int8.onnx",
            "decoder.int8.onnx",
            "joiner.int8.onnx",
            "tokens.txt",
        ]
    );
    assert_eq!(
        status.qwen.expected_files,
        vec![
            "qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf",
            "qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf",
        ]
    );
    assert_eq!(status.silero.expected_files, vec!["silero_vad.onnx"]);
    assert_eq!(status.models_root, dir.path().to_string_lossy());
}

#[test]
fn reports_partial_artifacts_as_not_present() {
    // Arrange: only some of Parakeet's expected files exist, Silero is
    // entirely absent, and Qwen has only the first shard of its split GGUF
    // — the presence gate requires both shards.
    let dir = tempfile::tempdir().expect("tempdir");
    touch(
        &dir.path()
            .join("parakeet-tdt-0.6b-v3-int8")
            .join("encoder.int8.onnx"),
    );
    touch(
        &dir.path()
            .join("qwen2.5-7b-instruct")
            .join("qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf"),
    );

    // Act
    let status = models_status_at(dir.path());

    // Assert
    assert!(!status.all_present);
    assert!(!status.parakeet.present);
    assert!(
        !status.qwen.present,
        "first shard alone must not count as present"
    );
    assert!(!status.silero.present);
}

#[test]
fn reports_all_present_with_complete_artifacts() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let parakeet_dir = dir.path().join("parakeet-tdt-0.6b-v3-int8");
    for file in [
        "encoder.int8.onnx",
        "decoder.int8.onnx",
        "joiner.int8.onnx",
        "tokens.txt",
    ] {
        touch(&parakeet_dir.join(file));
    }
    let qwen_dir = dir.path().join("qwen2.5-7b-instruct");
    for file in [
        "qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf",
        "qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf",
    ] {
        touch(&qwen_dir.join(file));
    }
    touch(&dir.path().join("silero-vad").join("silero_vad.onnx"));

    // Act
    let status = models_status_at(dir.path());

    // Assert
    assert!(status.all_present);
    assert!(status.parakeet.present);
    assert!(status.qwen.present);
    assert!(status.silero.present);
    assert_eq!(
        status.parakeet.path,
        parakeet_dir.to_string_lossy().into_owned()
    );
}

/// [`paths::resolve_models_root`] takes its `MYNA_MODELS_DIR` override and
/// debug-vs-release as explicit parameters (rather than reading real process
/// env vars), so precedence is exercised here without mutating
/// process-global state — which would otherwise require `unsafe`, forbidden
/// workspace-wide. Models never consult the data-dir override or the
/// persisted storage pointer: meetings follow the effective data root,
/// models stay pinned to the fixed `~/myna/models`.
#[test]
fn models_root_override_wins_regardless_of_debug_or_release() {
    // Arrange
    let override_dir = tempfile::tempdir().expect("tempdir");

    // Act / Assert
    assert_eq!(
        paths::resolve_models_root(Some(override_dir.path().to_path_buf()), true),
        override_dir.path()
    );
    assert_eq!(
        paths::resolve_models_root(Some(override_dir.path().to_path_buf()), false),
        override_dir.path()
    );
}

#[test]
fn models_root_release_build_resolves_to_fixed_models_root() {
    // Arrange: no MYNA_MODELS_DIR override — the release path is the fixed
    // `~/myna/models`, never under a custom data root.

    // Act
    let resolved = paths::resolve_models_root(None, false);

    // Assert: pinned to the fixed location (ends in `models`, not under a
    // caller-supplied data root).
    assert_eq!(
        resolved.file_name().expect("file name").to_string_lossy(),
        "models"
    );
}
