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
    speech_fixture_for("en")
}

/// Path to the `<lang>.wav` speech fixture (e.g. `"en"`, `"fr"`, `"de"`,
/// `"es"`) shipped alongside the Parakeet-TDT model artifacts, if it is
/// present on disk.
pub fn speech_fixture_for(lang: &str) -> Option<PathBuf> {
    let path = parakeet_dir().join("test_wavs").join(format!("{lang}.wav"));
    path.is_file().then_some(path)
}

/// Directory containing hand-corrected ground-truth transcripts for the
/// Parakeet-TDT speech fixtures (see [`speech_fixture_for`]). Tracked in
/// git (unlike `models/`) since these are small, purpose-authored text
/// files, not downloaded artifacts.
fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures")
}

/// Reads the hand-corrected ground-truth transcript for the `<lang>.wav`
/// speech fixture (e.g. `"en"`, `"fr"`, `"de"`, `"es"`), if present.
///
/// The returned text is trimmed of surrounding whitespace but otherwise
/// verbatim; callers that need word-error-rate comparisons should feed it
/// through [`wer`], which normalizes case and punctuation itself.
pub fn reference_transcript(lang: &str) -> Option<String> {
    let path = fixtures_dir().join(format!("{lang}.txt"));
    std::fs::read_to_string(path)
        .ok()
        .map(|text| text.trim().to_string())
}

/// Splits `text` into a normalized word vector for word-error-rate
/// comparison: lowercased, punctuation-stripped, whitespace-split.
fn normalize_words(text: &str) -> Vec<String> {
    text.split_whitespace()
        .map(|word| {
            word.chars()
                .filter(|c| c.is_alphanumeric())
                .collect::<String>()
                .to_lowercase()
        })
        .filter(|word| !word.is_empty())
        .collect()
}

/// Word error rate between `reference` and `hypothesis`: the Levenshtein
/// (edit) distance between their normalized word vectors ([`normalize_words`])
/// divided by the reference word count.
///
/// Returns `0.0` when the reference is empty (nothing to get wrong) even if
/// the hypothesis is not, avoiding a division by zero.
pub fn wer(reference: &str, hypothesis: &str) -> f32 {
    let reference_words = normalize_words(reference);
    let hypothesis_words = normalize_words(hypothesis);

    if reference_words.is_empty() {
        return 0.0;
    }

    // Plain O(n*m) edit-distance DP over two rolling rows (no crate
    // dependency): `previous_row[j]` is the edit distance between the first
    // `i - 1` reference words and the first `j` hypothesis words.
    let mut previous_row: Vec<usize> = (0..=hypothesis_words.len()).collect();
    let mut current_row = vec![0usize; hypothesis_words.len() + 1];

    for (i, reference_word) in reference_words.iter().enumerate() {
        current_row[0] = i + 1;
        for (j, hypothesis_word) in hypothesis_words.iter().enumerate() {
            let substitution_cost = usize::from(reference_word != hypothesis_word);
            current_row[j + 1] = (previous_row[j] + substitution_cost)
                .min(previous_row[j + 1] + 1)
                .min(current_row[j] + 1);
        }
        std::mem::swap(&mut previous_row, &mut current_row);
    }

    previous_row[hypothesis_words.len()] as f32 / reference_words.len() as f32
}

/// Whether every model this test suite depends on (Parakeet-TDT, Silero
/// VAD, Qwen2.5 GGUF) — and the English speech fixture used to exercise
/// them — is present on disk.
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

    parakeet_ok && qwen_gguf().is_file() && silero_vad().is_file() && speech_fixture().is_some()
}
