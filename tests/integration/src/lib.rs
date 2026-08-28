//! Fixture-path helpers shared by the cross-crate integration tests in
//! `tests/`.
//!
//! Every helper resolves paths relative to the workspace root rather than
//! this crate's own directory, since the models and templates these tests
//! exercise live at the top level (`models/`, `templates/`), not under
//! `tests/integration/`.

use std::env;
use std::path::{Path, PathBuf};

/// Directory name of the Parakeet-TDT v3 model artifacts, relative to
/// `models/`.
const PARAKEET_MODEL_DIR: &str = "parakeet-tdt-0.6b-v3-int8";
/// Files that must exist inside [`parakeet_dir`] for the model to be
/// considered present.
const PARAKEET_ARTIFACTS: [&str; 4] = [
    "encoder.int8.onnx",
    "decoder.int8.onnx",
    "joiner.int8.onnx",
    "tokens.txt",
];
/// Directory name of the Qwen2.5 GGUF, relative to `models/`.
const QWEN_MODEL_DIR: &str = "qwen2.5-3b-instruct";
/// File name of the Qwen2.5 GGUF inside [`QWEN_MODEL_DIR`].
const QWEN_GGUF_FILE: &str = "qwen2.5-3b-instruct-q4_k_m.gguf";
/// Directory name of the Silero VAD model, relative to `models/`.
const SILERO_VAD_DIR: &str = "silero-vad";
/// File name of the Silero VAD model inside [`SILERO_VAD_DIR`].
const SILERO_VAD_FILE: &str = "silero_vad.onnx";
/// English speech fixture used by the offline decode and streaming tests.
const SPEECH_FIXTURE_FILE: &str = "en.wav";

/// Environment variable that, when set to `1`, forces [`models_present`] to
/// return `false` regardless of what is on disk. Lets CI (or a developer
/// without downloaded models) explicitly opt out of the `#[ignore]`d
/// model-backed tests instead of relying on missing-file autodetection.
const SKIP_MODEL_TESTS_ENV: &str = "MYNA_SKIP_MODEL_TESTS";

/// Resolves the workspace root from this crate's own manifest directory
/// (`tests/integration/../..`), so these helpers work regardless of the
/// process's current working directory.
pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..")
}

/// Directory containing the Parakeet-TDT v3 model artifacts.
pub fn parakeet_dir() -> PathBuf {
    repo_root().join("models").join(PARAKEET_MODEL_DIR)
}

/// Path to the Qwen2.5-Instruct GGUF used for summarization tests.
pub fn qwen_gguf() -> PathBuf {
    repo_root()
        .join("models")
        .join(QWEN_MODEL_DIR)
        .join(QWEN_GGUF_FILE)
}

/// Path to the Silero VAD ONNX model.
pub fn silero_vad() -> PathBuf {
    repo_root()
        .join("models")
        .join(SILERO_VAD_DIR)
        .join(SILERO_VAD_FILE)
}

/// Directory containing the built-in JSON summary templates.
pub fn templates_dir() -> PathBuf {
    repo_root().join("templates")
}

/// Path to the English speech fixture used by the STT pipeline tests,
/// if it is present on disk.
pub fn speech_fixture() -> Option<PathBuf> {
    let path = parakeet_dir().join("test_wavs").join(SPEECH_FIXTURE_FILE);
    path.is_file().then_some(path)
}

/// Whether every model this test suite depends on (Parakeet-TDT, Silero
/// VAD, Qwen2.5 GGUF) is present on disk.
///
/// Always returns `false` when [`SKIP_MODEL_TESTS_ENV`] is set to `1`, so
/// model-backed tests can be disabled explicitly without deleting files.
pub fn models_present() -> bool {
    if env::var(SKIP_MODEL_TESTS_ENV).as_deref() == Ok("1") {
        return false;
    }

    let parakeet_dir = parakeet_dir();
    let parakeet_ok = PARAKEET_ARTIFACTS
        .iter()
        .all(|file_name| parakeet_dir.join(file_name).is_file());

    parakeet_ok && qwen_gguf().is_file() && silero_vad().is_file()
}
