//! Model-presence detection for onboarding: are Parakeet, Qwen, and Silero
//! present under the models root? Plus the in-app download commands that
//! drive `scripts/download-models.sh` through [`crate::model_init`] —
//! `start_model_download` / `start_diarization_download` spawn a sequential
//! run over the missing artifacts, `cancel_model_download` kills it, and
//! progress arrives on the `models://` event stream.

use std::path::Path;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::error::AppError;
use crate::model_init::{self, DownloadArtifact, ModelDownloadManager};
use crate::paths;

/// Directory name (under the resolved models root) containing the
/// Parakeet-TDT STT model artifacts.
const PARAKEET_DIR_NAME: &str = "parakeet-tdt-0.6b-v3-int8";
/// Directory name (under the resolved models root) containing the Qwen GGUF
/// summarization model.
const QWEN_DIR_NAME: &str = "qwen2.5-7b-instruct";
/// Directory name (under the resolved models root) containing the Silero
/// VAD model artifact.
const SILERO_DIR_NAME: &str = "silero-vad";
/// Directory (under the resolved models root) containing the pyannote-3.0
/// speaker-segmentation model artifact, nested one level further than the
/// other model dirs. Mirrors `state::DIARIZE_SEG_DIR_NAME` — not reused
/// directly because that one is private to its module.
const DIARIZE_SEGMENTATION_DIR_NAME: &str =
    "pyannote-segmentation-3-0/sherpa-onnx-pyannote-segmentation-3-0";
/// Directory (under the resolved models root) containing the NeMo TitaNet
/// speaker-embedding model artifact. Mirrors `state::DIARIZE_EMB_DIR_NAME`.
const DIARIZE_EMBEDDING_DIR_NAME: &str = "nemo-titanet";

const PARAKEET_EXPECTED_FILES: [&str; 4] = [
    "encoder.int8.onnx",
    "decoder.int8.onnx",
    "joiner.int8.onnx",
    "tokens.txt",
];
/// Split GGUF: the q4_k_m distribution ships as two shards, so presence
/// requires both files (llama.cpp loads them starting from the first).
const QWEN_EXPECTED_FILES: [&str; 2] = [
    "qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf",
    "qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf",
];
const SILERO_EXPECTED_FILES: [&str; 1] = ["silero_vad.onnx"];
const DIARIZE_SEGMENTATION_EXPECTED_FILES: [&str; 1] = ["model.int8.onnx"];
const DIARIZE_EMBEDDING_EXPECTED_FILES: [&str; 1] = ["nemo_en_titanet_small.onnx"];

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
    /// Presence of the speaker-diarization models (pyannote-3.0 segmentation
    /// and NeMo TitaNet embedding). Deliberately EXCLUDED from [`all_present`] —
    /// see that field's docs. Manual-only, optional feature: fetched via
    /// `./scripts/download-models.sh --only diarization`, never part of the
    /// default download, so gating onboarding on it would lock every
    /// existing user out of the app until they fetch an extra ~45 MiB they
    /// may never use.
    ///
    /// [`all_present`]: ModelsStatusDto::all_present
    pub diarization: ModelSlot,
    /// Whether the models onboarding screen gates on: parakeet, qwen, and
    /// silero ONLY. Deliberately does NOT include `diarization` — see that
    /// field's docs.
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
    let diarization = diarization_slot(models_root);
    // Deliberately excludes `diarization` — see `ModelsStatusDto::diarization`'s docs.
    let all_present = parakeet.present && qwen.present && silero.present;

    ModelsStatusDto {
        parakeet,
        qwen,
        silero,
        diarization,
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

/// Builds the [`ModelSlot`] for speaker diarization: present only when
/// BOTH the segmentation and embedding model artifacts exist, since
/// [`myna_stt::Diarizer::load`] needs both to load at all. Unlike
/// [`model_slot`], this spans two independent directories rather than one,
/// so `path` reports `models_root` itself (the common ancestor a "run this
/// download command" hint can point at) and `expected_files` lists each
/// artifact's full path relative to it.
fn diarization_slot(models_root: &Path) -> ModelSlot {
    let segmentation = models_root
        .join(DIARIZE_SEGMENTATION_DIR_NAME)
        .join(DIARIZE_SEGMENTATION_EXPECTED_FILES[0]);
    let embedding = models_root
        .join(DIARIZE_EMBEDDING_DIR_NAME)
        .join(DIARIZE_EMBEDDING_EXPECTED_FILES[0]);
    let present = segmentation.is_file() && embedding.is_file();

    ModelSlot {
        present,
        path: models_root.to_string_lossy().into_owned(),
        expected_files: vec![
            format!(
                "{DIARIZE_SEGMENTATION_DIR_NAME}/{}",
                DIARIZE_SEGMENTATION_EXPECTED_FILES[0]
            ),
            format!(
                "{DIARIZE_EMBEDDING_DIR_NAME}/{}",
                DIARIZE_EMBEDDING_EXPECTED_FILES[0]
            ),
        ],
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

/// Blocking core shared by [`start_model_download`] and
/// [`start_diarization_download`]: resolve the script and models root,
/// derive the run's artifact queue via `select`, and hand it to the managed
/// [`ModelDownloadManager`]. Resolves quickly — the download itself runs on
/// the manager's worker thread and reports via `models://` events.
fn start_download_blocking(
    app: &AppHandle,
    select: fn(&ModelsStatusDto) -> Vec<DownloadArtifact>,
) -> Result<(), AppError> {
    let manager = app.state::<Arc<ModelDownloadManager>>().inner().clone();
    let script = model_init::resolve_init_script(app)?;
    let models_root = paths::models_root(app);
    let artifacts = select(&models_status_at(&models_root));
    manager.start(app.clone(), script, models_root, artifacts)
}

/// Starts an in-app download of every missing model artifact (parakeet,
/// qwen, vad, and — when absent — diarization), sequentially. Resolves as
/// soon as the run is spawned; per-artifact progress and the terminal
/// outcome arrive on `models://progress` / `models://done`. Rejects with
/// [`AppError::Busy`] when a run is already in flight.
#[tauri::command]
pub async fn start_model_download(app: AppHandle) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        start_download_blocking(&app, model_init::missing_artifacts)
    })
    .await
    .unwrap_or_else(|_| {
        Err(AppError::Store(
            "start_model_download worker thread panicked".to_string(),
        ))
    })
}

/// Starts a download of ONLY the diarization artifacts (pyannote +
/// TitaNet) — the one-click path for existing installs where core models
/// are present but diarization was never fetched. Same lifecycle and
/// [`AppError::Busy`] semantics as [`start_model_download`]; no-ops with a
/// successful terminal event when the artifacts are already present.
#[tauri::command]
pub async fn start_diarization_download(app: AppHandle) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        start_download_blocking(&app, model_init::missing_diarization_artifacts)
    })
    .await
    .unwrap_or_else(|_| {
        Err(AppError::Store(
            "start_diarization_download worker thread panicked".to_string(),
        ))
    })
}

/// Kills the in-flight download child, if any. The worker notices, reaps,
/// and emits a cancelled `models://done`. Idempotent: cancelling with no
/// run in flight is a successful no-op.
#[tauri::command]
pub async fn cancel_model_download(app: AppHandle) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<Arc<ModelDownloadManager>>().cancel();
        Ok(())
    })
    .await
    .unwrap_or_else(|_| {
        Err(AppError::Store(
            "cancel_model_download worker thread panicked".to_string(),
        ))
    })
}

#[cfg(test)]
mod diarization_slot_tests {
    use super::*;

    #[test]
    fn diarization_slot_is_absent_when_neither_artifact_is_present() {
        // Arrange
        let dir = tempfile::tempdir().expect("tempdir");

        // Act
        let slot = diarization_slot(dir.path());

        // Assert
        assert!(!slot.present);
        assert_eq!(slot.expected_files.len(), 2);
    }

    #[test]
    fn diarization_slot_is_absent_when_only_one_of_the_two_artifacts_is_present() {
        // Arrange: segmentation present, embedding still missing.
        let dir = tempfile::tempdir().expect("tempdir");
        let segmentation_dir = dir.path().join(DIARIZE_SEGMENTATION_DIR_NAME);
        std::fs::create_dir_all(&segmentation_dir).expect("create segmentation dir fixture");
        std::fs::write(
            segmentation_dir.join(DIARIZE_SEGMENTATION_EXPECTED_FILES[0]),
            b"onnx",
        )
        .expect("write segmentation fixture");

        // Act
        let slot = diarization_slot(dir.path());

        // Assert: BOTH artifacts are required — `Diarizer::load` needs both.
        assert!(!slot.present);
    }

    #[test]
    fn diarization_slot_is_present_only_when_both_artifacts_exist() {
        // Arrange
        let dir = tempfile::tempdir().expect("tempdir");
        let segmentation_dir = dir.path().join(DIARIZE_SEGMENTATION_DIR_NAME);
        std::fs::create_dir_all(&segmentation_dir).expect("create segmentation dir fixture");
        std::fs::write(
            segmentation_dir.join(DIARIZE_SEGMENTATION_EXPECTED_FILES[0]),
            b"onnx",
        )
        .expect("write segmentation fixture");
        let embedding_dir = dir.path().join(DIARIZE_EMBEDDING_DIR_NAME);
        std::fs::create_dir_all(&embedding_dir).expect("create embedding dir fixture");
        std::fs::write(
            embedding_dir.join(DIARIZE_EMBEDDING_EXPECTED_FILES[0]),
            b"onnx",
        )
        .expect("write embedding fixture");

        // Act
        let slot = diarization_slot(dir.path());

        // Assert
        assert!(slot.present);
    }

    #[test]
    fn all_present_is_unaffected_by_diarization_being_absent() {
        // Arrange: parakeet, qwen, and silero all present; diarization
        // artifacts absent entirely — this is the real state of an
        // ordinary user's models root today, before this feature existed.
        let dir = tempfile::tempdir().expect("tempdir");
        seed_model(dir.path(), PARAKEET_DIR_NAME, &PARAKEET_EXPECTED_FILES);
        seed_model(dir.path(), QWEN_DIR_NAME, &QWEN_EXPECTED_FILES);
        seed_model(dir.path(), SILERO_DIR_NAME, &SILERO_EXPECTED_FILES);

        // Act
        let status = models_status_at(dir.path());

        // Assert: the onboarding gate must not regress for every existing
        // user just because diarization shipped.
        assert!(!status.diarization.present);
        assert!(
            status.all_present,
            "all_present must stay true when parakeet/qwen/silero are present, \
             regardless of the diarization slot"
        );
    }

    /// Writes every expected file for one model under `models_root/dir_name`.
    fn seed_model(models_root: &Path, dir_name: &str, expected_files: &[&str]) {
        let dir = models_root.join(dir_name);
        std::fs::create_dir_all(&dir).expect("create model dir fixture");
        for file in expected_files {
            std::fs::write(dir.join(file), b"model").expect("write model fixture file");
        }
    }
}
