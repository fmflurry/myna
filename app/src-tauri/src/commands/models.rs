//! Model-presence detection for onboarding: are Parakeet, Qwen, and Silero
//! present under the models root?
//!
//! In-app downloading is out of scope — when a model is missing, the UI
//! shows a blocking onboarding screen that tells the user to run
//! [`DOWNLOAD_COMMAND`].

use std::path::Path;

use serde::Serialize;
use tauri::AppHandle;

use crate::error::AppError;
use crate::paths;

/// Shell command the onboarding screen tells the user to run when one or
/// more models are missing. `--dest <resolved models root>` is appended so
/// the command is actionable even when `MYNA_MODELS_DIR` overrides the
/// default location.
const DOWNLOAD_COMMAND: &str = "./scripts/download-models.sh";

/// Directory name (under the resolved models root) containing the
/// Parakeet-TDT STT model artifacts.
const PARAKEET_DIR_NAME: &str = "parakeet-tdt-0.6b-v3-int8";
/// Directory name (under the resolved models root) containing the Qwen GGUF
/// summarization model.
const QWEN_DIR_NAME: &str = "qwen2.5-3b-instruct";
/// Directory name (under the resolved models root) containing the Silero
/// VAD model artifact.
const SILERO_DIR_NAME: &str = "silero-vad";

const PARAKEET_EXPECTED_FILES: [&str; 4] = [
    "encoder.int8.onnx",
    "decoder.int8.onnx",
    "joiner.int8.onnx",
    "tokens.txt",
];
const QWEN_EXPECTED_FILES: [&str; 1] = ["qwen2.5-3b-instruct-q4_k_m.gguf"];
const SILERO_EXPECTED_FILES: [&str; 1] = ["silero_vad.onnx"];

/// Presence and expected-files listing for a single model, IPC-facing.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelSlot {
    pub present: bool,
    pub path: String,
    pub expected_files: Vec<String>,
}

/// Presence of every model Myna needs, IPC-facing.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelsStatusDto {
    pub parakeet: ModelSlot,
    pub qwen: ModelSlot,
    pub silero: ModelSlot,
    pub all_present: bool,
    /// The real, resolved directory the app is looking in for models (e.g.
    /// `~/myna/models`, or the `MYNA_MODELS_DIR` override), so onboarding
    /// can tell the user exactly where models are expected rather than an
    /// invisible internal path.
    pub models_root: String,
}

/// Reports whether each required model's expected files are present under
/// `models_root`.
///
/// Extracted as a pure function over a plain `&Path` (rather than an
/// `AppHandle`) so presence detection is unit-testable against a
/// `tempfile::tempdir()` without loading any model.
pub fn models_status_at(models_root: &Path) -> ModelsStatusDto {
    let parakeet = model_slot(models_root, PARAKEET_DIR_NAME, &PARAKEET_EXPECTED_FILES);
    let qwen = model_slot(models_root, QWEN_DIR_NAME, &QWEN_EXPECTED_FILES);
    let silero = model_slot(models_root, SILERO_DIR_NAME, &SILERO_EXPECTED_FILES);
    let all_present = parakeet.present && qwen.present && silero.present;

    ModelsStatusDto {
        parakeet,
        qwen,
        silero,
        all_present,
        models_root: models_root.to_string_lossy().into_owned(),
    }
}

/// Builds a [`ModelSlot`] for `dir_name` under `models_root`, present only
/// when every file in `expected_files` exists.
fn model_slot(models_root: &Path, dir_name: &str, expected_files: &[&str]) -> ModelSlot {
    let dir = models_root.join(dir_name);
    let present = expected_files.iter().all(|file| dir.join(file).is_file());
    let expected_files = expected_files.iter().map(|file| file.to_string()).collect();

    ModelSlot {
        present,
        path: dir.to_string_lossy().into_owned(),
        expected_files,
    }
}

/// Reports model presence under the resolved models root.
///
/// `async fn`: [`paths::models_root`] can itself do filesystem work
/// (creating the data root, or resolving the bundled resource directory),
/// and this then stats every expected file for all three models, so the
/// call runs inside [`tauri::async_runtime::spawn_blocking`] rather than
/// the main thread.
#[tauri::command]
pub async fn models_status(app: AppHandle) -> Result<ModelsStatusDto, AppError> {
    tauri::async_runtime::spawn_blocking(move || Ok(models_status_at(&paths::models_root(&app))))
        .await
        .unwrap_or_else(|_| {
            Err(AppError::Store(
                "models_status worker thread panicked".to_string(),
            ))
        })
}

/// Shell command the onboarding screen shows the user for downloading
/// models, pointed at the actual resolved models root so the command works
/// even when `MYNA_MODELS_DIR` overrides the default location.
///
/// Stays synchronous: it resolves the same root as [`models_status`], but
/// does none of that command's additional per-file existence checks (3
/// models times up to 4 files each) on top — just a handful of bounded
/// `exists()`/`create_dir_all` calls and a string format, genuinely
/// microseconds-scale, so it is not worth an async hop.
#[tauri::command]
pub fn download_command(app: AppHandle) -> String {
    let models_root = paths::models_root(&app);
    format!(
        "{DOWNLOAD_COMMAND} --dest {}",
        models_root.to_string_lossy()
    )
}
