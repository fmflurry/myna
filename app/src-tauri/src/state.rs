//! Shared, Tauri-managed application state: the meeting store, the active
//! recording session (if any), and lazily-loaded, cached STT and
//! summarization engines.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use myna_llm::Summarizer;
use myna_stt::{DiarizeConfig, Diarizer, SttConfig, SttEngine};
use tauri::AppHandle;

use crate::domain::MeetingId;
use crate::error::AppError;
use crate::paths;
use crate::session::RecordingSession;
use crate::store::folder_store::FsFolderStore;
use crate::store::fs_store::FsMeetingStore;

/// Directory name (under the resolved models root) containing the
/// Parakeet-TDT STT model artifacts.
const STT_MODEL_DIR_NAME: &str = "parakeet-tdt-0.6b-v3-int8";

/// Directory (under the resolved models root) containing the pyannote-3.0
/// speaker-segmentation model artifact [`Diarizer`] loads, nested one level
/// further than most other model dirs — see [`DIARIZE_SEG_FILE_NAME`].
const DIARIZE_SEG_DIR_NAME: &str =
    "pyannote-segmentation-3-0/sherpa-onnx-pyannote-segmentation-3-0";
/// File name of the pyannote segmentation model, within
/// [`DIARIZE_SEG_DIR_NAME`].
const DIARIZE_SEG_FILE_NAME: &str = "model.int8.onnx";
/// Directory (under the resolved models root) containing the NeMo TitaNet
/// speaker-embedding model artifact [`Diarizer`] loads.
const DIARIZE_EMB_DIR_NAME: &str = "nemo-titanet";
/// File name of the NeMo TitaNet embedding model, within
/// [`DIARIZE_EMB_DIR_NAME`].
const DIARIZE_EMB_FILE_NAME: &str = "nemo_en_titanet_small.onnx";

/// Lower bound on the number of threads the STT engine decodes with,
/// regardless of detected parallelism.
pub const STT_ENGINE_THREADS_MIN: i32 = 2;

/// Upper bound on the number of threads the STT engine decodes with.
///
/// sherpa-onnx's `OfflineModelConfig` exposes a single `num_threads` field
/// applied to *all three* Parakeet-TDT ORT sessions (encoder, decoder,
/// joiner) — there is no per-session control. The transducer decoder and
/// joiner run tiny per-step ops (one frame/token at a time), far too small
/// to parallelize; profiling showed those pools spending nearly all their
/// time spinning in `ThreadPoolTempl::WorkerLoop`/`SpinPause` rather than
/// doing useful work. ONNX Runtime's own fix for this,
/// `session.intra_op.allow_spinning`, exists in the linked runtime but is
/// unreachable through sherpa-onnx 1.13.6 (no config field, no env-var
/// equivalent) — bounding `num_threads` down is the only lever available.
/// `8` previously accepted that spin cost in exchange for encoder
/// throughput (the encoder *is* real parallel work — measured 146-158% CPU
/// in `.LGemmU8X8`/`Im2col`); `4` trades some encoder wall-time for
/// materially less idle spinning in the decoder/joiner pools.
pub const STT_ENGINE_THREADS_MAX: i32 = 4;

/// Fallback thread count used when [`std::thread::available_parallelism`]
/// fails to detect the machine's CPU count. Kept equal to
/// [`STT_ENGINE_THREADS_MAX`] so `clamp_thread_count(None)` returns the
/// same tuned value rather than reintroducing the 8-thread spin cost
/// documented on [`STT_ENGINE_THREADS_MAX`] through the undetected-CPU
/// fallback path.
pub const STT_ENGINE_THREADS_FALLBACK: i32 = 4;

/// Number of threads the STT engine decodes with: detected available
/// parallelism, clamped to [`STT_ENGINE_THREADS_MIN`] and
/// [`STT_ENGINE_THREADS_MAX`], falling back to
/// [`STT_ENGINE_THREADS_FALLBACK`] when detection fails. A fixed low
/// constant (previously `2`) left most cores idle during decode; measured
/// decode RTF was ~0.13 at 2 threads.
fn stt_engine_threads() -> i32 {
    let detected = std::thread::available_parallelism()
        .map(|n| n.get() as i32)
        .ok();
    clamp_thread_count(detected)
}

/// Pure clamping logic behind [`stt_engine_threads`], split out so it can
/// be unit-tested without depending on the host machine's actual CPU
/// count.
pub fn clamp_thread_count(detected: Option<i32>) -> i32 {
    detected
        .unwrap_or(STT_ENGINE_THREADS_FALLBACK)
        .clamp(STT_ENGINE_THREADS_MIN, STT_ENGINE_THREADS_MAX)
}

/// Directory name (under the resolved models root) containing the Qwen GGUF
/// summarization model.
const LLM_MODEL_DIR_NAME: &str = "qwen2.5-3b-instruct";

/// File name of the Qwen GGUF model, within [`LLM_MODEL_DIR_NAME`].
const LLM_MODEL_FILE_NAME: &str = "qwen2.5-3b-instruct-q4_k_m.gguf";

/// What `recording_state` reports while a stop/cancel is finalizing: the
/// meeting whose session has already left [`AppState::session`] but whose
/// save / delete / artifact-cleanup has not completed yet.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StoppingSession {
    pub meeting_id: MeetingId,
    /// Wall-clock seconds frozen at the moment the session was taken —
    /// lets a reloaded webview render the final timer value instead of 0.
    pub elapsed_sec: f32,
}

/// Application state managed by Tauri and injected into every command.
pub struct AppState {
    pub store: Arc<FsMeetingStore>,
    pub folders: Arc<FsFolderStore>,
    pub session: Mutex<Option<RecordingSession>>,
    /// `Some` between the moment `stop_recording`/`cancel_recording` take
    /// the session out of [`AppState::session`] and the moment the final
    /// save / delete / artifact cleanup completes. The session slot is
    /// empty for that whole window (the worker join + final decode is
    /// seconds-scale), so without this marker a webview reloading mid-
    /// stop would poll `recording_state` and see a false `idle` — the
    /// marker is what makes the `stopping` contract reachable.
    stopping: Mutex<Option<StoppingSession>>,
    stt_engine: OnceLock<Arc<SttEngine>>,
    summarizer: OnceLock<Arc<Summarizer>>,
    /// Cached speaker diarizer, loaded on first use by
    /// [`AppState::diarizer`] — mirrors [`AppState::stt_engine`]'s
    /// once-per-app-lifetime caching for the same reason (seconds-scale
    /// model load).
    diarizer: OnceLock<Arc<Diarizer>>,
    /// Shared cancellation flag for the in-flight summarization, if any.
    /// Reset to `false` at the start of every run by
    /// [`AppState::begin_summarization`]; the in-flight
    /// [`Summarizer::summarize`] call observes it and returns
    /// [`myna_llm::LlmError::Cancelled`].
    pub cancel_summary: Arc<AtomicBool>,
    /// `true` while a summarization is running, guarding against
    /// concurrent `summarize_meeting` calls.
    summary_busy: AtomicBool,
    /// Shared cancellation flag for the in-flight import or re-transcribe,
    /// if any. Reset to `false` at the start of every run by
    /// [`AppState::begin_import`]; the in-flight
    /// `ingest::transcribe_wav_streaming` call observes it and stops.
    pub cancel_import: Arc<AtomicBool>,
    /// `true` while an import or re-transcribe is running, guarding against
    /// concurrent `import_audio`/`retranscribe_meeting` calls.
    import_busy: AtomicBool,
}

impl AppState {
    /// Builds fresh state rooted at `store`/`folders`, with no active
    /// session and no STT engine or summarizer loaded yet.
    pub fn new(store: FsMeetingStore, folders: FsFolderStore) -> Self {
        Self {
            store: Arc::new(store),
            folders: Arc::new(folders),
            session: Mutex::new(None),
            stopping: Mutex::new(None),
            stt_engine: OnceLock::new(),
            summarizer: OnceLock::new(),
            diarizer: OnceLock::new(),
            cancel_summary: Arc::new(AtomicBool::new(false)),
            summary_busy: AtomicBool::new(false),
            cancel_import: Arc::new(AtomicBool::new(false)),
            import_busy: AtomicBool::new(false),
        }
    }

    /// Returns the cached STT engine, loading it on first use.
    ///
    /// Model load is seconds-scale, so it must run at most once per app
    /// lifetime. Callers that may race (e.g. concurrent `start_recording`
    /// invocations) must serialize through [`AppState::session`] before
    /// calling this, since `OnceLock::get_or_init`'s closure is infallible
    /// and a failed load must not poison the cache.
    pub fn stt_engine(&self, app: &AppHandle) -> Result<Arc<SttEngine>, AppError> {
        if let Some(engine) = self.stt_engine.get() {
            return Ok(Arc::clone(engine));
        }

        let engine = Arc::new(SttEngine::load(&SttConfig {
            model_dir: paths::models_root(app).join(STT_MODEL_DIR_NAME),
            num_threads: stt_engine_threads(),
            debug: false,
            ..SttConfig::default()
        })?);

        Ok(Arc::clone(self.stt_engine.get_or_init(|| engine)))
    }

    /// Returns the cached summarizer, loading it on first use.
    ///
    /// Model load is seconds-scale and `llama_cpp_2::LlamaBackend::init` is
    /// a process-wide singleton — a second `Summarizer::load` in the same
    /// process fails — so this must run at most once per app lifetime.
    /// Callers that may race must serialize through
    /// [`AppState::begin_summarization`] before calling this, for the same
    /// reason [`AppState::stt_engine`] documents.
    pub fn summarizer(&self, app: &AppHandle) -> Result<Arc<Summarizer>, AppError> {
        if let Some(summarizer) = self.summarizer.get() {
            return Ok(Arc::clone(summarizer));
        }

        let summarizer = Arc::new(Summarizer::load(
            &paths::models_root(app)
                .join(LLM_MODEL_DIR_NAME)
                .join(LLM_MODEL_FILE_NAME),
        )?);

        Ok(Arc::clone(self.summarizer.get_or_init(|| summarizer)))
    }

    /// Returns the cached speaker diarizer, loading it on first use. Mirrors
    /// [`AppState::stt_engine`]'s caching discipline and its callers-must-
    /// serialize-first contract — `commands::import::diarize_meeting_blocking`
    /// serializes through [`AppState::begin_import`] before calling this,
    /// exactly like the STT engine and summarizer do for their own busy
    /// guards.
    pub fn diarizer(&self, app: &AppHandle) -> Result<Arc<Diarizer>, AppError> {
        if let Some(diarizer) = self.diarizer.get() {
            return Ok(Arc::clone(diarizer));
        }

        let models_root = paths::models_root(app);
        let diarizer = Arc::new(Diarizer::load(&DiarizeConfig {
            segmentation_model: models_root
                .join(DIARIZE_SEG_DIR_NAME)
                .join(DIARIZE_SEG_FILE_NAME),
            embedding_model: models_root
                .join(DIARIZE_EMB_DIR_NAME)
                .join(DIARIZE_EMB_FILE_NAME),
            num_threads: stt_engine_threads(),
            ..DiarizeConfig::default()
        })?);

        Ok(Arc::clone(self.diarizer.get_or_init(|| diarizer)))
    }

    /// Marks a summarization as in-flight and resets
    /// [`AppState::cancel_summary`] for the new run, failing with
    /// [`AppError::Busy`] if one is already running.
    pub fn begin_summarization(&self) -> Result<(), AppError> {
        if self.summary_busy.swap(true, Ordering::SeqCst) {
            return Err(AppError::Busy("a summarization is already in progress"));
        }
        self.cancel_summary.store(false, Ordering::SeqCst);
        Ok(())
    }

    /// Marks the in-flight summarization as finished, regardless of
    /// outcome. Must be called exactly once per successful
    /// [`AppState::begin_summarization`].
    pub fn end_summarization(&self) {
        self.summary_busy.store(false, Ordering::SeqCst);
    }

    /// Marks an import (or re-transcribe) as in-flight and resets
    /// [`AppState::cancel_import`] for the new run, failing with
    /// [`AppError::Busy`] if one is already running. Mirrors
    /// [`AppState::begin_summarization`].
    pub fn begin_import(&self) -> Result<(), AppError> {
        if self.import_busy.swap(true, Ordering::SeqCst) {
            return Err(AppError::Busy("an import is already in progress"));
        }
        self.cancel_import.store(false, Ordering::SeqCst);
        Ok(())
    }

    /// Marks the in-flight import (or re-transcribe) as finished, regardless
    /// of outcome. Must be called exactly once per successful
    /// [`AppState::begin_import`]. Mirrors [`AppState::end_summarization`].
    pub fn end_import(&self) {
        self.import_busy.store(false, Ordering::SeqCst);
    }

    /// Whether an import or re-transcribe is currently in flight — read-only
    /// accessor for `commands::recording::start_recording_blocking`'s guard.
    pub fn import_busy(&self) -> bool {
        self.import_busy.load(Ordering::SeqCst)
    }

    /// Panic-safe counterpart to [`AppState::begin_import`]/
    /// [`AppState::end_import`]: acquires the same busy flag (same
    /// precondition, same [`AppError::Busy`] failure), but returns an RAII
    /// [`ImportGuard`] whose [`Drop`] calls `end_import()` instead of
    /// requiring the caller to call it manually. Because `Drop` runs during
    /// unwinding, a panic anywhere while the guard is alive still releases
    /// the flag — unlike the manual `begin_import()?; <work>; end_import();`
    /// pattern, where a panic in `<work>` skips `end_import()` and leaves
    /// `import_busy` stuck `true` forever (see
    /// `tests/import_guard_panic_safety.rs`).
    ///
    /// Additive: [`AppState::begin_import`]/[`AppState::end_import`]
    /// themselves are untouched, since two pre-existing tests depend on
    /// their current unbound-call semantics.
    pub fn import_guard(&self) -> Result<ImportGuard<'_>, AppError> {
        self.begin_import()?;
        Ok(ImportGuard { state: self })
    }

    /// Panic-safe counterpart to [`AppState::begin_summarization`]/
    /// [`AppState::end_summarization`] — mirrors [`AppState::import_guard`]
    /// for `summary_busy`. See that method's docs for the full rationale.
    pub fn summarization_guard(&self) -> Result<SummarizationGuard<'_>, AppError> {
        self.begin_summarization()?;
        Ok(SummarizationGuard { state: self })
    }

    /// Marks a stop/cancel as finalizing `meeting_id` (with `elapsed_sec`
    /// frozen at take time) and returns an RAII [`StoppingGuard`] that
    /// clears the marker when dropped — so every exit path of the command,
    /// including early `?` returns and panics, releases it once the save /
    /// delete / artifact-cleanup has completed. Call while holding the
    /// session `Mutex`, *before* taking the session out of the slot, so
    /// there is no window where the slot is empty and the marker unset
    /// (the MINOR-1 contract: a reload during the final-decode join must
    /// see `stopping`, never a false `idle`).
    pub fn begin_stopping(&self, meeting_id: MeetingId, elapsed_sec: f32) -> StoppingGuard<'_> {
        *self.lock_stopping() = Some(StoppingSession {
            meeting_id,
            elapsed_sec,
        });
        StoppingGuard { state: self }
    }

    /// Clears the stopping marker. Called by [`StoppingGuard::drop`].
    pub fn end_stopping(&self) {
        *self.lock_stopping() = None;
    }

    /// The in-flight stop/cancel finalization, if any — read by
    /// `commands::recording::recording_state`.
    pub fn stopping(&self) -> Option<StoppingSession> {
        *self.lock_stopping()
    }

    /// Locks the stopping marker, recovering from poisoning: the guarded
    /// value is a single `Option` assignment never read by another thread
    /// mid-write, so a panic while held cannot have left it inconsistent.
    fn lock_stopping(&self) -> MutexGuard<'_, Option<StoppingSession>> {
        self.stopping
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// RAII guard returned by [`AppState::begin_stopping`]. Clears the stopping
/// marker via [`AppState::end_stopping`] when dropped — including during a
/// panic unwind — so the stop/cancel command holds it for the whole
/// finalization body. Mirrors [`ImportGuard`].
pub struct StoppingGuard<'a> {
    state: &'a AppState,
}

impl Drop for StoppingGuard<'_> {
    fn drop(&mut self) {
        self.state.end_stopping();
    }
}

/// RAII guard returned by [`AppState::import_guard`]. Releases the import
/// busy flag via [`AppState::end_import`] when dropped — including during a
/// panic unwind — so callers hold this for the whole guarded body instead of
/// calling `end_import()` manually at the end.
pub struct ImportGuard<'a> {
    state: &'a AppState,
}

impl Drop for ImportGuard<'_> {
    fn drop(&mut self) {
        self.state.end_import();
    }
}

/// RAII guard returned by [`AppState::summarization_guard`]. Releases the
/// summarization busy flag via [`AppState::end_summarization`] when dropped
/// — including during a panic unwind. Mirrors [`ImportGuard`].
pub struct SummarizationGuard<'a> {
    state: &'a AppState,
}

impl Drop for SummarizationGuard<'_> {
    fn drop(&mut self) {
        self.state.end_summarization();
    }
}
