//! First-run model initialization: drives `scripts/download-models.sh` from
//! inside the app so onboarding can fetch missing models without a terminal.
//!
//! The script is resolved repo-relative in dev builds and from the bundled
//! resources in release builds (see `bundle.resources` in
//! `tauri.conf.json`). Each missing artifact (parakeet / qwen / vad /
//! diarization) is fetched by one sequential `bash <script> --dest
//! <models_root> --only <artifact>` run (`--only diarization` fetches both
//! pyannote + TitaNet together), emitting `models://progress` per artifact
//! and `models://done` when the run ends. The runner iterates the full
//! `missing_artifacts` queue so a fresh-install `Initialize` bundles the
//! optional diarization models; the terminal `all_present` gate remains
//! core-only.

use std::env;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::commands::models::{models_status_at, ModelsStatusDto};
use crate::error::AppError;
use crate::events::{
    ModelDownloadDonePayload, ModelDownloadProgressPayload, MODELS_DONE, MODELS_PROGRESS,
};
use crate::paths;

/// Directory (relative to the repo root in dev builds, or to the bundled
/// resource directory in release builds) containing the download script.
const SCRIPT_DIR_NAME: &str = "scripts";

/// File name of the idempotent download script driven by this module.
const SCRIPT_FILE_NAME: &str = "download-models.sh";

/// Directories appended to the child process' `PATH`. GUI apps on macOS do
/// not inherit the login shell's PATH, so `hf` (installed by pip into
/// `~/.local/bin`) would otherwise be invisible to the spawned script.
///
/// Appended *after* whatever `PATH` the process inherited, never prepended:
/// `/usr/local/bin` is group-writable on a stock macOS install, so
/// prepending it would let anything placed there shadow a same-named binary
/// the inherited `PATH` would otherwise have resolved from `/usr/bin` or
/// `/bin`.
const CHILD_PATH_APPEND: [&str; 2] = ["/opt/homebrew/bin", "/usr/local/bin"];

/// How often the runner re-checks whether the current download child has
/// exited. Cancellation is delivered by killing the child, so this only
/// bounds how long an exited child can go unnoticed.
const POLL_INTERVAL: Duration = Duration::from_millis(100);

const CHILD_MUTEX_POISONED: &str = "model download child mutex poisoned";

/// One downloadable model artifact, named the way
/// `scripts/download-models.sh --only` expects it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DownloadArtifact {
    /// Parakeet-TDT STT model (`--only parakeet`).
    Parakeet,
    /// Qwen2.5-Instruct GGUF summarization model (`--only qwen`).
    Qwen,
    /// Silero VAD ONNX model (`--only vad`).
    Vad,
    /// Speaker diarization models (pyannote + TitaNet) bundled as a single
    /// `--only diarization` selector (`scripts/download-models.sh` fetches
    /// both artifacts together).
    Diarization,
}

impl DownloadArtifact {
    /// The `--only` selector understood by `scripts/download-models.sh`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Parakeet => "parakeet",
            Self::Qwen => "qwen",
            Self::Vad => "vad",
            Self::Diarization => "diarization",
        }
    }
}

/// Derives the artifacts still missing from a [`ModelsStatusDto`] presence
/// report, in the order the sequential runner should fetch them.
///
/// Extracted as a pure function over the presence oracle's output so the
/// derivation is unit-testable against a `tempfile::tempdir()` without
/// spawning any download.
pub fn missing_artifacts(status: &ModelsStatusDto) -> Vec<DownloadArtifact> {
    let mut missing = Vec::new();
    if !status.parakeet.present {
        missing.push(DownloadArtifact::Parakeet);
    }
    if !status.qwen.present {
        missing.push(DownloadArtifact::Qwen);
    }
    if !status.silero.present {
        missing.push(DownloadArtifact::Vad);
    }
    if !status.diarization.present {
        missing.push(DownloadArtifact::Diarization);
    }
    missing
}

/// Returns the diarization artifact alone when the diarization models are
/// missing, otherwise an empty list. Used by the one-click
/// `start_diarization_download` path for existing installs where core
/// (`parakeet`/`qwen`/`silero`) is already present but diarization was never
/// fetched (`all_present` is core-only).
pub fn missing_diarization_artifacts(status: &ModelsStatusDto) -> Vec<DownloadArtifact> {
    if status.diarization.present {
        Vec::new()
    } else {
        vec![DownloadArtifact::Diarization]
    }
}

/// Resolves the download script for the running app: repo-relative in dev
/// builds, bundled-resource-relative in release builds. Errors when the
/// script is missing on disk so a broken bundle fails loudly instead of
/// spawning `bash` against a nonexistent file.
pub fn resolve_init_script(app: &AppHandle) -> Result<PathBuf, AppError> {
    let candidate = init_script_path(
        cfg!(debug_assertions),
        &paths::repo_root(),
        app.path().resource_dir().ok().as_deref(),
    );
    ensure_script_exists(&candidate)
}

/// Pure core of [`resolve_init_script`], parameterized on debug-vs-release,
/// the dev repo root, and the (optional) bundled resource directory.
fn init_script_path(is_debug_build: bool, dev_root: &Path, resource_dir: Option<&Path>) -> PathBuf {
    if is_debug_build {
        return dev_root.join(SCRIPT_DIR_NAME).join(SCRIPT_FILE_NAME);
    }
    resource_dir
        .map(|dir| dir.join(SCRIPT_DIR_NAME).join(SCRIPT_FILE_NAME))
        .unwrap_or_else(|| PathBuf::from(SCRIPT_FILE_NAME))
}

/// Errors when `candidate` is not an existing file on disk.
fn ensure_script_exists(candidate: &Path) -> Result<PathBuf, AppError> {
    if candidate.is_file() {
        Ok(candidate.to_path_buf())
    } else {
        Err(AppError::NotFound(format!(
            "model download script not found at {}",
            candidate.display()
        )))
    }
}

/// Builds the `PATH` value handed to the download child: the app's own
/// (inherited) `PATH` first, then the GUI-unfriendly append directories (so
/// `hf` and friends still resolve even though GUI apps don't inherit the
/// login shell's PATH) -- never the reverse, so a group-writable directory
/// like `/usr/local/bin` can never shadow a same-named binary the inherited
/// `PATH` would otherwise have resolved first.
///
/// Pure over its inputs so the construction is unit-testable without
/// touching the real process environment.
fn build_child_path(home_dir: Option<&Path>, current: Option<&OsStr>) -> OsString {
    let mut own_parts: Vec<PathBuf> = Vec::new();
    if let Some(home) = home_dir {
        own_parts.push(home.join(".local").join("bin"));
    }
    own_parts.extend(CHILD_PATH_APPEND.iter().copied().map(PathBuf::from));

    let mut parts: Vec<PathBuf> = Vec::new();
    if let Some(current) = current {
        parts.extend(env::split_paths(current));
    }
    parts.extend(own_parts.iter().cloned());

    env::join_paths(&parts)
        .unwrap_or_else(|_| env::join_paths(&own_parts).expect("own PATH dirs always join"))
}

/// [`build_child_path`] against the real process environment.
fn child_path() -> OsString {
    let home = env::var_os("HOME").map(PathBuf::from);
    build_child_path(home.as_deref(), env::var_os("PATH").as_deref())
}

/// Spawns one `bash <script> --dest <models_root> --only <artifact>` child
/// with the augmented `PATH` from [`child_path`].
fn spawn_artifact_download(
    script: &Path,
    models_root: &Path,
    artifact: DownloadArtifact,
) -> Result<Child, AppError> {
    Command::new("/bin/bash")
        .arg(script)
        .arg("--dest")
        .arg(models_root)
        .arg("--only")
        .arg(artifact.as_str())
        .env("PATH", child_path())
        .spawn()
        .map_err(AppError::Io)
}

/// Progress and completion notifications produced by a download run. The
/// production worker maps these onto Tauri events; tests collect them into
/// a `Vec` for assertions.
#[derive(Debug)]
pub enum ModelDownloadEvent {
    /// Emitted before each artifact's download starts.
    Progress {
        artifact: &'static str,
        index: usize,
        total: usize,
    },
    /// Emitted exactly once, when the run ends for any reason.
    Done(ModelDownloadDonePayload),
}

/// How one per-artifact step ended.
enum StepOutcome {
    /// The script exited successfully.
    Completed,
    /// The run was cancelled (or superseded) during this step.
    Cancelled,
    /// The step failed; carries a human-readable description.
    Failed(String),
}

/// Drives sequential per-artifact model downloads, holding the current
/// child so [`ModelDownloadManager::cancel`] can kill it mid-download.
///
/// State is the `Mutex<Option<Child>>` slot plus a `running` flag (the
/// concurrent-start guard) and a `generation` counter that keeps a stale
/// worker from touching a newer run's state after
/// cancel-then-immediately-restart.
pub struct ModelDownloadManager {
    child: Mutex<Option<Child>>,
    running: AtomicBool,
    generation: AtomicU64,
}

impl Default for ModelDownloadManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ModelDownloadManager {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
            running: AtomicBool::new(false),
            generation: AtomicU64::new(0),
        }
    }

    /// Whether a download run is currently in flight.
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::Acquire)
    }

    /// Reserves the manager for a new run, returning the run's generation.
    /// Rejects with [`AppError::Busy`] when a run is already in flight.
    fn try_reserve(&self) -> Result<u64, AppError> {
        if self.running.swap(true, Ordering::AcqRel) {
            return Err(AppError::Busy("a model download is already in progress"));
        }
        Ok(self.generation.fetch_add(1, Ordering::AcqRel) + 1)
    }

    /// Starts a background run that downloads `artifacts` sequentially,
    /// emitting `models://progress` / `models://done` events on `app`.
    /// Rejects with [`AppError::Busy`] when a run is already in flight.
    pub fn start(
        self: &Arc<Self>,
        app: AppHandle,
        script: PathBuf,
        models_root: PathBuf,
        artifacts: Vec<DownloadArtifact>,
    ) -> Result<(), AppError> {
        let generation = self.try_reserve()?;
        let manager = Arc::clone(self);
        let spawned = std::thread::Builder::new()
            .name("model-download".to_string())
            .spawn(move || {
                manager.run_sequence(
                    &script,
                    &models_root,
                    &artifacts,
                    generation,
                    &mut |event| emit_model_event(&app, event),
                );
            });
        if let Err(error) = spawned {
            // Roll the reservation back so a retry isn't locked out.
            self.finish_run(generation);
            return Err(AppError::Io(error));
        }
        Ok(())
    }

    /// Kills the in-flight download child, if any. The worker notices the
    /// cancellation, reaps, and emits a cancelled `models://done`.
    pub fn cancel(&self) {
        self.running.store(false, Ordering::Release);
        if let Some(mut child) = self.child.lock().expect(CHILD_MUTEX_POISONED).take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    /// Whether a run with the given generation may still act: it must both
    /// be flagged running and still be the current generation.
    fn is_active(&self, generation: u64) -> bool {
        self.running.load(Ordering::Acquire)
            && self.generation.load(Ordering::Acquire) == generation
    }

    /// Releases the run's state, but only if `generation` is still current —
    /// a superseded worker must not clobber a newer run's slot or flag.
    fn finish_run(&self, generation: u64) {
        if self.generation.load(Ordering::Acquire) == generation {
            *self.child.lock().expect(CHILD_MUTEX_POISONED) = None;
            self.running.store(false, Ordering::Release);
        }
    }

    /// Emits the terminal [`ModelDownloadEvent::Done`] and releases the run.
    fn finish_with(
        &self,
        on_event: &mut dyn FnMut(ModelDownloadEvent),
        generation: u64,
        success: bool,
        cancelled: bool,
        message: Option<String>,
    ) {
        on_event(ModelDownloadEvent::Done(ModelDownloadDonePayload {
            success,
            cancelled,
            message,
        }));
        self.finish_run(generation);
    }

    /// The sequential runner: one `bash` child per artifact.
    ///
    /// Each artifact is fetched via `bash <script> --dest <models_root>
    /// --only <artifact>` (including `--only diarization` which fetches both
    /// pyannote + TitaNet together). The runner iterates the full `artifacts`
    /// slice derived from [`missing_artifacts`] so a fresh-install queue
    /// `[Parakeet, Qwen, Vad, Diarization]` is fully executed; the terminal
    /// `all_present` gate remains core-only (parakeet/qwen/silero) and is
    /// evaluated only at the end so the optional diarization artifact is
    /// bundled without changing the onboarding gate.
    fn run_sequence(
        &self,
        script: &Path,
        models_root: &Path,
        artifacts: &[DownloadArtifact],
        generation: u64,
        on_event: &mut dyn FnMut(ModelDownloadEvent),
    ) {
        let total = artifacts.len();
        for (index, artifact) in artifacts.iter().enumerate() {
            if !self.is_active(generation) {
                self.finish_with(on_event, generation, false, true, None);
                return;
            }
            on_event(ModelDownloadEvent::Progress {
                artifact: artifact.as_str(),
                index,
                total,
            });
            match self.run_step(script, models_root, *artifact, generation) {
                StepOutcome::Completed => {}
                StepOutcome::Cancelled => {
                    self.finish_with(on_event, generation, false, true, None);
                    return;
                }
                StepOutcome::Failed(message) => {
                    self.finish_with(on_event, generation, false, false, Some(message));
                    return;
                }
            }
        }

        let all_present = models_status_at(models_root).all_present;
        let message = (!all_present)
            .then(|| "the download script finished but some models are still missing".to_string());
        self.finish_with(on_event, generation, all_present, false, message);
    }

    /// Runs one artifact's download to completion, registering the child in
    /// the slot so [`ModelDownloadManager::cancel`] can kill it.
    fn run_step(
        &self,
        script: &Path,
        models_root: &Path,
        artifact: DownloadArtifact,
        generation: u64,
    ) -> StepOutcome {
        let mut child = match spawn_artifact_download(script, models_root, artifact) {
            Ok(child) => child,
            Err(error) => return StepOutcome::Failed(error.to_string()),
        };

        {
            let mut slot = self.child.lock().expect(CHILD_MUTEX_POISONED);
            if !self.is_active(generation) {
                // Cancelled between spawn and registration: kill the orphan
                // here, since `cancel` already ran and saw an empty slot.
                let _ = child.kill();
                let _ = child.wait();
                return StepOutcome::Cancelled;
            }
            *slot = Some(child);
        }

        let status = loop {
            if !self.is_active(generation) {
                // `cancel` has already taken and reaped the child.
                return StepOutcome::Cancelled;
            }
            let mut slot = self.child.lock().expect(CHILD_MUTEX_POISONED);
            match slot.as_mut() {
                Some(running_child) => match running_child.try_wait() {
                    Ok(Some(status)) => {
                        *slot = None;
                        break status;
                    }
                    Ok(None) => {}
                    Err(error) => {
                        *slot = None;
                        return StepOutcome::Failed(error.to_string());
                    }
                },
                // The only code path that empties the slot mid-run is
                // `cancel`, which has already reaped the child.
                None => return StepOutcome::Cancelled,
            }
            drop(slot);
            std::thread::sleep(POLL_INTERVAL);
        };

        if !status.success() {
            return StepOutcome::Failed(format!(
                "download of '{}' failed with exit status {status}",
                artifact.as_str()
            ));
        }
        StepOutcome::Completed
    }
}

/// Maps a [`ModelDownloadEvent`] onto the `models://` Tauri events.
fn emit_model_event(app: &AppHandle, event: ModelDownloadEvent) {
    match event {
        ModelDownloadEvent::Progress {
            artifact,
            index,
            total,
        } => {
            let _ = app.emit(
                MODELS_PROGRESS,
                ModelDownloadProgressPayload {
                    artifact: artifact.to_string(),
                    index: index as u32,
                    total: total as u32,
                },
            );
        }
        ModelDownloadEvent::Done(payload) => {
            let _ = app.emit(MODELS_DONE, payload);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::Instant;

    use super::*;

    // ---- Pure seams: artifact derivation, path resolution, PATH build ----

    #[test]
    fn missing_artifacts_derives_every_artifact_from_an_empty_models_root() {
        // Arrange
        let dir = tempfile::tempdir().expect("tempdir");
        let status = models_status_at(dir.path());

        // Act
        let missing = missing_artifacts(&status);

        // Assert
        assert_eq!(
            missing,
            vec![
                DownloadArtifact::Parakeet,
                DownloadArtifact::Qwen,
                DownloadArtifact::Vad,
                DownloadArtifact::Diarization
            ]
        );
    }

    #[test]
    fn missing_artifacts_skips_present_slots() {
        // Arrange: only parakeet present.
        let dir = tempfile::tempdir().expect("tempdir");
        seed_model(dir.path(), "parakeet-tdt-0.6b-v3-int8", "encoder.int8.onnx");
        seed_model(dir.path(), "parakeet-tdt-0.6b-v3-int8", "decoder.int8.onnx");
        seed_model(dir.path(), "parakeet-tdt-0.6b-v3-int8", "joiner.int8.onnx");
        seed_model(dir.path(), "parakeet-tdt-0.6b-v3-int8", "tokens.txt");
        let status = models_status_at(dir.path());

        // Act
        let missing = missing_artifacts(&status);

        // Assert
        assert_eq!(
            missing,
            vec![
                DownloadArtifact::Qwen,
                DownloadArtifact::Vad,
                DownloadArtifact::Diarization
            ]
        );
    }

    #[test]
    fn missing_artifacts_is_empty_when_all_present() {
        // Arrange: all 4 artifacts present (including diarization's two files).
        let dir = tempfile::tempdir().expect("tempdir");
        for (dir_name, file) in [
            ("parakeet-tdt-0.6b-v3-int8", "encoder.int8.onnx"),
            ("parakeet-tdt-0.6b-v3-int8", "decoder.int8.onnx"),
            ("parakeet-tdt-0.6b-v3-int8", "joiner.int8.onnx"),
            ("parakeet-tdt-0.6b-v3-int8", "tokens.txt"),
            (
                "qwen2.5-7b-instruct",
                "qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf",
            ),
            (
                "qwen2.5-7b-instruct",
                "qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf",
            ),
            ("silero-vad", "silero_vad.onnx"),
            (
                "pyannote-segmentation-3-0/sherpa-onnx-pyannote-segmentation-3-0",
                "model.int8.onnx",
            ),
            ("nemo-titanet", "nemo_en_titanet_small.onnx"),
        ] {
            seed_model(dir.path(), dir_name, file);
        }
        let status = models_status_at(dir.path());

        // Act
        let missing = missing_artifacts(&status);

        // Assert
        assert!(missing.is_empty());
    }

    #[test]
    fn missing_artifacts_yields_diarization_only_when_core_present() {
        // Arrange: parakeet, qwen, silero present; diarization absent — the
        // real state of an existing user's models root. This is the Phase 1
        // bundling edge: onboarding (core missing) queues diarization, but an
        // existing install with core present must not be gated on it.
        let dir = tempfile::tempdir().expect("tempdir");
        for (dir_name, file) in [
            ("parakeet-tdt-0.6b-v3-int8", "encoder.int8.onnx"),
            ("parakeet-tdt-0.6b-v3-int8", "decoder.int8.onnx"),
            ("parakeet-tdt-0.6b-v3-int8", "joiner.int8.onnx"),
            ("parakeet-tdt-0.6b-v3-int8", "tokens.txt"),
            (
                "qwen2.5-7b-instruct",
                "qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf",
            ),
            (
                "qwen2.5-7b-instruct",
                "qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf",
            ),
            ("silero-vad", "silero_vad.onnx"),
        ] {
            seed_model(dir.path(), dir_name, file);
        }
        let status = models_status_at(dir.path());

        // Act
        let missing = missing_artifacts(&status);

        // Assert: diarization is the only remaining artifact, yet all_present
        // stays true so existing users are not locked out.
        assert_eq!(missing, vec![DownloadArtifact::Diarization]);
        assert!(
            status.all_present,
            "all_present must remain core-only (parakeet/qwen/silero)"
        );
        assert!(!status.diarization.present);
    }

    #[test]
    fn missing_diarization_artifacts_returns_single_diarization_when_missing() {
        // Arrange: core present, diarization absent — existing install.
        let dir = tempfile::tempdir().expect("tempdir");
        for (dir_name, file) in [
            ("parakeet-tdt-0.6b-v3-int8", "encoder.int8.onnx"),
            ("parakeet-tdt-0.6b-v3-int8", "decoder.int8.onnx"),
            ("parakeet-tdt-0.6b-v3-int8", "joiner.int8.onnx"),
            ("parakeet-tdt-0.6b-v3-int8", "tokens.txt"),
            (
                "qwen2.5-7b-instruct",
                "qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf",
            ),
            (
                "qwen2.5-7b-instruct",
                "qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf",
            ),
            ("silero-vad", "silero_vad.onnx"),
        ] {
            seed_model(dir.path(), dir_name, file);
        }
        let status = models_status_at(dir.path());

        // Act
        let missing = missing_diarization_artifacts(&status);

        // Assert
        assert_eq!(missing, vec![DownloadArtifact::Diarization]);
    }

    #[test]
    fn missing_diarization_artifacts_is_empty_when_present() {
        // Arrange: all 4 present including diarization's two files.
        let dir = tempfile::tempdir().expect("tempdir");
        for (dir_name, file) in [
            (
                "pyannote-segmentation-3-0/sherpa-onnx-pyannote-segmentation-3-0",
                "model.int8.onnx",
            ),
            ("nemo-titanet", "nemo_en_titanet_small.onnx"),
        ] {
            seed_model(dir.path(), dir_name, file);
        }
        let mut status = models_status_at(dir.path());
        // Manually force diarization present while core still missing — only
        // diarization.present matters for this helper.
        status.diarization.present = true;

        // Act
        let missing = missing_diarization_artifacts(&status);

        // Assert
        assert!(missing.is_empty());
    }

    #[test]
    fn init_script_path_resolves_repo_relative_in_dev() {
        // Act
        let path = init_script_path(true, Path::new("/repo"), None);

        // Assert
        assert_eq!(path, PathBuf::from("/repo/scripts/download-models.sh"));
    }

    #[test]
    fn init_script_path_resolves_into_bundled_resources_in_release() {
        // Act
        let path = init_script_path(false, Path::new("/repo"), Some(Path::new("/App/Resources")));

        // Assert
        assert_eq!(
            path,
            PathBuf::from("/App/Resources/scripts/download-models.sh")
        );
    }

    #[test]
    fn init_script_path_falls_back_to_bare_name_without_resource_dir() {
        // Act
        let path = init_script_path(false, Path::new("/repo"), None);

        // Assert
        assert_eq!(path, PathBuf::from("download-models.sh"));
    }

    #[test]
    fn resolve_errors_when_script_is_missing_on_disk() {
        // Arrange
        let dir = tempfile::tempdir().expect("tempdir");

        // Act
        let resolved = ensure_script_exists(&dir.path().join("nope.sh"));

        // Assert
        assert!(matches!(resolved, Err(AppError::NotFound(_))));
    }

    #[test]
    fn build_child_path_appends_gui_unfriendly_dirs_after_the_inherited_path() {
        // Arrange
        let home = Path::new("/Users/tester");
        let current = OsStr::new("/usr/bin:/bin");

        // Act
        let joined = build_child_path(Some(home), Some(current));

        // Assert: the inherited PATH comes first, so a same-named binary
        // already resolvable through it always wins over the group-writable
        // /usr/local/bin. Confirmed this fails against the pre-fix code,
        // which prepended these dirs ahead of the inherited PATH.
        let parts: Vec<PathBuf> = env::split_paths(&joined).collect();
        assert_eq!(parts[0], Path::new("/usr/bin"));
        assert_eq!(parts[1], Path::new("/bin"));
        assert_eq!(parts[2], Path::new("/Users/tester/.local/bin"));
        assert_eq!(parts[3], Path::new("/opt/homebrew/bin"));
        assert_eq!(parts[4], Path::new("/usr/local/bin"));
    }

    #[test]
    fn build_child_path_handles_missing_home_and_current() {
        // Act
        let joined = build_child_path(None, None);

        // Assert
        let parts: Vec<PathBuf> = env::split_paths(&joined).collect();
        assert_eq!(
            parts,
            vec![
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/usr/local/bin")
            ]
        );
    }

    // ---- Concurrent-start guard ----

    #[test]
    fn try_reserve_rejects_concurrent_starts() {
        // Arrange
        let manager = ModelDownloadManager::new();

        // Act / Assert
        assert!(manager.try_reserve().is_ok());
        assert!(matches!(manager.try_reserve(), Err(AppError::Busy(_))));
    }

    // ---- Fake-script harness ----

    /// Creates a marker file for one model under `models_root/dir_name`.
    fn seed_model(models_root: &Path, dir_name: &str, file_name: &str) {
        let dir = models_root.join(dir_name);
        fs::create_dir_all(&dir).expect("create model dir fixture");
        fs::write(dir.join(file_name), b"model").expect("write model fixture file");
    }

    fn write_script(dir: &Path, body: &str) -> PathBuf {
        let path = dir.join("fake-download.sh");
        fs::write(&path, body).expect("write fake script");
        path
    }

    /// Parses `--dest`/`--only` like the real script, then materializes the
    /// marker files `models_status_at` expects for the requested artifact.
    const SUCCESS_SCRIPT: &str = r#"#!/usr/bin/env bash
set -euo pipefail
dest=""; only=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dest) dest="$2"; shift 2 ;;
    --only) only="$2"; shift 2 ;;
    *) echo "unexpected arg: $1" >&2; exit 64 ;;
  esac
done
case "$only" in
  parakeet)
    d="$dest/parakeet-tdt-0.6b-v3-int8"
    mkdir -p "$d"
    for f in encoder.int8.onnx decoder.int8.onnx joiner.int8.onnx tokens.txt; do
      echo x > "$d/$f"
    done
    ;;
  qwen)
    d="$dest/qwen2.5-7b-instruct"
    mkdir -p "$d"
    echo x > "$d/qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf"
    echo x > "$d/qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf"
    ;;
  vad)
    d="$dest/silero-vad"
    mkdir -p "$d"
    echo x > "$d/silero_vad.onnx"
    ;;
  diarization)
    d1="$dest/pyannote-segmentation-3-0/sherpa-onnx-pyannote-segmentation-3-0"
    mkdir -p "$d1"
    echo x > "$d1/model.int8.onnx"
    d2="$dest/nemo-titanet"
    mkdir -p "$d2"
    echo x > "$d2/nemo_en_titanet_small.onnx"
    ;;
  *) echo "unexpected --only: $only" >&2; exit 64 ;;
esac
"#;

    /// Records the `PATH` it was spawned with, then exits successfully
    /// without creating any model artifact.
    const PATH_PROBE_SCRIPT: &str = r#"#!/usr/bin/env bash
set -euo pipefail
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dest) dest="$2"; shift 2 ;;
    --only) shift 2 ;;
    *) shift ;;
  esac
done
mkdir -p "$dest"
printf '%s' "$PATH" > "$dest/path.txt"
"#;

    const FAILURE_SCRIPT: &str = "#!/usr/bin/env bash\nexit 3\n";
    const SLEEP_SCRIPT: &str = "#!/usr/bin/env bash\nsleep 30\n";

    /// A manager prepared for a direct `run_sequence` call with generation 1.
    fn reserved_manager() -> ModelDownloadManager {
        let manager = ModelDownloadManager::new();
        manager.running.store(true, Ordering::SeqCst);
        manager.generation.store(1, Ordering::SeqCst);
        manager
    }

    fn done_payload(events: &[ModelDownloadEvent]) -> &ModelDownloadDonePayload {
        match events.last() {
            Some(ModelDownloadEvent::Done(payload)) => payload,
            other => panic!("expected a Done event, got {other:?}"),
        }
    }

    #[test]
    fn run_sequence_downloads_missing_artifacts_until_all_present() {
        // Arrange: fresh-install queue now includes diarization (4 artifacts).
        let tmp = tempfile::tempdir().expect("tempdir");
        let script = write_script(tmp.path(), SUCCESS_SCRIPT);
        let models_root = tmp.path().join("models");
        let manager = reserved_manager();

        // Act
        let mut events = Vec::new();
        manager.run_sequence(
            &script,
            &models_root,
            &[
                DownloadArtifact::Parakeet,
                DownloadArtifact::Qwen,
                DownloadArtifact::Vad,
                DownloadArtifact::Diarization,
            ],
            1,
            &mut |event| events.push(event),
        );

        // Assert: every artifact downloaded, presence oracle satisfied
        // (all_present is core-only but still true after the core three;
        // diarization is additionally present).
        assert!(models_status_at(&models_root).all_present);
        assert!(models_status_at(&models_root).diarization.present);
        let progress: Vec<(&str, usize, usize)> = events
            .iter()
            .filter_map(|event| match event {
                ModelDownloadEvent::Progress {
                    artifact,
                    index,
                    total,
                } => Some((*artifact, *index, *total)),
                _ => None,
            })
            .collect();
        assert_eq!(progress.len(), 4);
        assert_eq!(progress[0], ("parakeet", 0, 4));
        assert_eq!(progress[2], ("vad", 2, 4));
        assert_eq!(progress[3], ("diarization", 3, 4));
        let done = done_payload(&events);
        assert!(done.success);
        assert!(!done.cancelled);
        assert!(done.message.is_none());
        // The run released its state.
        assert!(manager.child.lock().expect("mutex").is_none());
        assert!(!manager.is_running());
    }

    #[test]
    fn run_sequence_emits_done_success_without_spawning_when_nothing_is_missing() {
        // Arrange: all 4 artifacts present, so the derived artifact list is
        // empty; the script must never run (it exits 64 if invoked).
        let tmp = tempfile::tempdir().expect("tempdir");
        let script = write_script(tmp.path(), FAILURE_SCRIPT);
        let models_root = tmp.path().join("models");
        for (dir_name, file) in [
            ("parakeet-tdt-0.6b-v3-int8", "encoder.int8.onnx"),
            ("parakeet-tdt-0.6b-v3-int8", "decoder.int8.onnx"),
            ("parakeet-tdt-0.6b-v3-int8", "joiner.int8.onnx"),
            ("parakeet-tdt-0.6b-v3-int8", "tokens.txt"),
            (
                "qwen2.5-7b-instruct",
                "qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf",
            ),
            (
                "qwen2.5-7b-instruct",
                "qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf",
            ),
            ("silero-vad", "silero_vad.onnx"),
            (
                "pyannote-segmentation-3-0/sherpa-onnx-pyannote-segmentation-3-0",
                "model.int8.onnx",
            ),
            ("nemo-titanet", "nemo_en_titanet_small.onnx"),
        ] {
            seed_model(&models_root, dir_name, file);
        }
        let manager = reserved_manager();
        let artifacts = missing_artifacts(&models_status_at(&models_root));
        assert!(artifacts.is_empty());

        // Act
        let mut events = Vec::new();
        manager.run_sequence(&script, &models_root, &artifacts, 1, &mut |event| {
            events.push(event)
        });

        // Assert
        let done = done_payload(&events);
        assert!(done.success);
        assert_eq!(events.len(), 1, "no progress events expected");
    }

    #[test]
    fn run_sequence_reports_failure_when_the_script_exits_non_zero() {
        // Arrange
        let tmp = tempfile::tempdir().expect("tempdir");
        let script = write_script(tmp.path(), FAILURE_SCRIPT);
        let models_root = tmp.path().join("models");
        let manager = reserved_manager();

        // Act
        let mut events = Vec::new();
        manager.run_sequence(
            &script,
            &models_root,
            &[DownloadArtifact::Parakeet],
            1,
            &mut |event| events.push(event),
        );

        // Assert
        let done = done_payload(&events);
        assert!(!done.success);
        assert!(!done.cancelled);
        assert!(done.message.is_some());
        assert!(!models_status_at(&models_root).all_present);
    }

    #[test]
    fn run_sequence_reports_cancelled_when_never_started() {
        // Arrange: a fresh manager whose `running` flag was never set.
        let tmp = tempfile::tempdir().expect("tempdir");
        let script = write_script(tmp.path(), SUCCESS_SCRIPT);
        let models_root = tmp.path().join("models");
        let manager = ModelDownloadManager::new();

        // Act
        let mut events = Vec::new();
        manager.run_sequence(
            &script,
            &models_root,
            &[DownloadArtifact::Parakeet],
            1,
            &mut |event| events.push(event),
        );

        // Assert: cancelled before any progress was emitted.
        let done = done_payload(&events);
        assert!(!done.success);
        assert!(done.cancelled);
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn cancel_kills_the_running_child_and_reports_cancelled() {
        // Arrange
        let tmp = tempfile::tempdir().expect("tempdir");
        let script = write_script(tmp.path(), SLEEP_SCRIPT);
        let models_root = tmp.path().join("models");
        let manager = Arc::new(reserved_manager());

        let worker = {
            let manager = Arc::clone(&manager);
            let script = script.clone();
            let models_root = models_root.clone();
            std::thread::spawn(move || {
                let mut events = Vec::new();
                manager.run_sequence(
                    &script,
                    &models_root,
                    &[DownloadArtifact::Parakeet],
                    1,
                    &mut |event| events.push(event),
                );
                events
            })
        };

        assert!(
            wait_for_child(&manager),
            "the download child never registered"
        );

        // Act
        let started = Instant::now();
        manager.cancel();
        let events = worker.join().expect("worker thread panicked");

        // Assert: the killed child is reaped promptly, not after `sleep 30`.
        assert!(started.elapsed() < Duration::from_secs(10));
        let done = done_payload(&events);
        assert!(!done.success);
        assert!(done.cancelled);
        assert!(done.message.is_none());
        assert!(!models_status_at(&models_root).all_present);
    }

    #[test]
    fn child_process_receives_augmented_path() {
        // Arrange
        let tmp = tempfile::tempdir().expect("tempdir");
        let script = write_script(tmp.path(), PATH_PROBE_SCRIPT);
        let models_root = tmp.path().join("models");
        let manager = reserved_manager();

        // Act
        let mut events = Vec::new();
        manager.run_sequence(
            &script,
            &models_root,
            &[DownloadArtifact::Vad],
            1,
            &mut |event| events.push(event),
        );

        // Assert: the child saw the GUI-app PATH prepends. (The run itself
        // ends in a "still missing" Done because the probe creates no
        // artifacts — irrelevant here.)
        let recorded = fs::read_to_string(models_root.join("path.txt")).expect("read path probe");
        assert!(
            recorded.contains("/opt/homebrew/bin"),
            "PATH was: {recorded}"
        );
        assert!(recorded.contains("/usr/local/bin"), "PATH was: {recorded}");
        let done = done_payload(&events);
        assert!(!done.success);
    }

    /// Polls until the manager's child slot is occupied (bounded wait).
    fn wait_for_child(manager: &ModelDownloadManager) -> bool {
        for _ in 0..200 {
            if manager.child.lock().expect("mutex").is_some() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        false
    }
}
