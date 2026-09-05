//! Shared, Tauri-managed application state: the meeting store, the active
//! recording session (if any), and lazily-loaded, evictable model caches
//! ([`ModelSlot`]) for the STT engine, the summarizer, and the diarizer.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant};

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
const LLM_MODEL_DIR_NAME: &str = "qwen2.5-7b-instruct";

/// File name of the Qwen GGUF model, within [`LLM_MODEL_DIR_NAME`]: the
/// first shard of the split q4_k_m distribution — llama.cpp opens it and
/// follows the split metadata to load the companion shard.
const LLM_MODEL_FILE_NAME: &str = "qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf";

/// How long the cached STT engine may sit unused after a recording (or
/// import) completes before [`AppState::evict_stt_if_idle`] releases it.
/// 10 minutes: long enough that back-to-back recordings and
/// record→stop→immediately-retranscribe flows reuse the warm engine (each
/// reload is a seconds-scale Parakeet load), short enough that an app left
/// idle after a meeting gives the ~1 GB of ONNX weights back to the OS.
pub const IDLE_MODEL_TTL: Duration = Duration::from_secs(10 * 60);

/// The pure decision behind [`AppState::evict_stt_if_idle`]: the STT engine
/// is released only when no recording session occupies [`AppState::session`]
/// AND no import/re-transcribe is in flight — both hold a live
/// `Arc<SttEngine>`, and evicting under either would drop the model out
/// from under a decoding worker. Extracted so the guard is unit-testable
/// without a device-backed `RecordingSession` (mirrors the `guard_start`
/// precedent in `commands::recording`).
pub fn stt_evict_allowed(session_active: bool, import_busy: bool) -> bool {
    !session_active && !import_busy
}

/// An evictable cache slot for one lazily-loaded model.
///
/// Replaces the pre-Phase-3 `OnceLock<Arc<T>>` fields, which could load a
/// model but never release one — every GB-scale artifact a session ever
/// touched stayed resident until process exit. A `ModelSlot` holds an
/// `Option<Arc<T>>` with three lifecycle operations:
///
/// - [`ModelSlot::get_or_load`]: return the cached model, or load it (once
///   — the slot mutex serializes concurrent acquires through the load).
///   A failed load surfaces as `Err` and leaves the slot empty and
///   retryable, so unlike `OnceLock` no caller-serialization contract is
///   needed to avoid poisoning a failed load into the cache.
/// - [`ModelSlot::release_if_last`] / [`ModelSlot::evict_if_idle`]: drop
///   the cached model — but only when the slot is the sole `Arc` holder,
///   so a release can never pull a model out from under a live operation.
///   The model's `Drop` runs outside the slot mutex.
/// - [`ModelSlot::weak`] / [`ModelSlot::arc_count`]: test seams that make
///   an actual drop observable (`weak.upgrade().is_none()`), which the
///   `OnceLock` cache could not express at all.
///
/// Reload tradeoff: releasing after each operation means the next
/// user-triggered summarization/diarization pays a seconds-scale model
/// load. Both are explicit, infrequent, user-initiated operations where a
/// progress wait is already expected; the alternative (the old behavior)
/// was to hold the RAM forever, which is the leak this type exists to fix.
pub struct ModelSlot<T> {
    current: Mutex<Option<Arc<T>>>,
    last_used: Mutex<Instant>,
}

impl<T> ModelSlot<T> {
    /// An empty slot, stamped "used now" so a never-acquired model is
    /// never considered idle-expired.
    pub fn new() -> Self {
        Self {
            current: Mutex::new(None),
            last_used: Mutex::new(Instant::now()),
        }
    }

    /// Returns the cached model, loading it via `load` on a miss and
    /// stamping `last_used`. The slot mutex is held across `load`, so two
    /// racing acquires load once, not twice.
    pub fn get_or_load(
        &self,
        load: impl FnOnce() -> Result<Arc<T>, AppError>,
    ) -> Result<Arc<T>, AppError> {
        let model = {
            let mut current = self.lock_current();
            match current.as_ref() {
                Some(cached) => Arc::clone(cached),
                None => {
                    let loaded = load()?;
                    *current = Some(Arc::clone(&loaded));
                    loaded
                }
            }
        };
        *self.lock_last_used() = Instant::now();
        Ok(model)
    }

    /// End-of-operation release: if the slot is the only remaining holder
    /// of the cached model (the caller has dropped its own `Arc`), take it
    /// out and drop it. Returns whether the model was released. Refused —
    /// without dropping — while any live operation still holds a reference.
    pub fn release_if_last(&self) -> bool {
        self.take_if(|model| Arc::strong_count(model) == 1)
            .is_some()
    }

    /// Idle-time eviction: like [`ModelSlot::release_if_last`], but also
    /// requires the slot to have gone untouched for `ttl`. Never blocks:
    /// every lock is `try_lock`, because this runs on the synchronous
    /// `recording_state`/`list_input_devices` command path and must not
    /// stall the main thread behind an in-flight load. A refused attempt
    /// is harmless — the next poll retries after the TTL.
    pub fn evict_if_idle(&self, ttl: Duration) -> bool {
        let idle = match self.last_used.try_lock() {
            Ok(last_used) => last_used.elapsed() >= ttl,
            Err(_) => false,
        };
        if !idle {
            return false;
        }
        let mut current = match self.current.try_lock() {
            Ok(current) => current,
            Err(_) => return false,
        };
        let evict = current
            .as_ref()
            .is_some_and(|model| Arc::strong_count(model) == 1);
        // Take first, release the guard, THEN drop the model: a
        // `Summarizer`/`SttEngine` Drop joins worker threads, and that
        // teardown must not run holding the slot mutex.
        let evicted = if evict { current.take() } else { None };
        drop(current);
        evicted.is_some()
    }

    /// Stamps `last_used` now, restarting the [`IDLE_MODEL_TTL`] countdown
    /// from the end of an operation rather than its start (a 30-minute
    /// recording would otherwise find its engine "expired" the instant it
    /// stopped).
    pub fn touch(&self) {
        *self.lock_last_used() = Instant::now();
    }

    /// Test seam: a `Weak` handle to the cached model, or `None` when the
    /// slot is empty. `weak.upgrade().is_none()` after a release/eviction
    /// is the proof that the model was actually dropped, not just
    /// forgotten.
    pub fn weak(&self) -> Option<Weak<T>> {
        self.lock_current().as_ref().map(Arc::downgrade)
    }

    /// Test seam: the strong count of the cached model (`None` when the
    /// slot is empty) — 1 means only the slot holds it, 2+ means a live
    /// operation does too.
    pub fn arc_count(&self) -> Option<usize> {
        self.lock_current().as_ref().map(Arc::strong_count)
    }

    fn take_if(&self, pred: impl FnOnce(&Arc<T>) -> bool) -> Option<Arc<T>> {
        let mut current = self.lock_current();
        if current.as_ref().is_some_and(pred) {
            current.take()
        } else {
            None
        }
    }

    /// Poison recovery: a panic inside `load` (step 1) leaves the slot
    /// `None` (the assignment in step 2 never ran), and a panic during
    /// eviction leaves a plain `Option` assignment — neither can corrupt
    /// the value, mirroring `lock_stopping`'s rationale.
    fn lock_current(&self) -> MutexGuard<'_, Option<Arc<T>>> {
        self.current
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn lock_last_used(&self) -> MutexGuard<'_, Instant> {
        self.last_used
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl<T> Default for ModelSlot<T> {
    fn default() -> Self {
        Self::new()
    }
}

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
    /// Cached STT engine in an evictable slot: released by
    /// [`AppState::evict_stt_if_idle`] once no session/import holds it and
    /// [`IDLE_MODEL_TTL`] has passed since its last use.
    stt_engine: ModelSlot<SttEngine>,
    /// Cached summarizer in an evictable slot: released at the end of
    /// every `run_summarization` via [`AppState::release_summarizer`].
    summarizer: ModelSlot<Summarizer>,
    /// Cached speaker diarizer in an evictable slot: released at the end
    /// of every `run_diarize` via [`AppState::release_diarizer`] — mirrors
    /// [`AppState::summarizer`]'s end-of-operation lifecycle.
    diarizer: ModelSlot<Diarizer>,
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
            stt_engine: ModelSlot::new(),
            summarizer: ModelSlot::new(),
            diarizer: ModelSlot::new(),
            cancel_summary: Arc::new(AtomicBool::new(false)),
            summary_busy: AtomicBool::new(false),
            cancel_import: Arc::new(AtomicBool::new(false)),
            import_busy: AtomicBool::new(false),
        }
    }

    /// Returns the cached STT engine, loading it on first use after any
    /// eviction.
    ///
    /// Model load is seconds-scale, so the slot caches it;
    /// [`AppState::evict_stt_if_idle`] releases it again once no session
    /// or import holds a reference and [`IDLE_MODEL_TTL`] has passed.
    /// Callers that begin an operation (recording, import, re-transcribe)
    /// acquire through their busy guard first and keep the returned `Arc`
    /// for the operation's whole duration, which is what makes eviction
    /// race-free: [`ModelSlot::evict_if_idle`] refuses while any live
    /// reference exists.
    pub fn stt_engine(&self, app: &AppHandle) -> Result<Arc<SttEngine>, AppError> {
        self.stt_engine.get_or_load(|| {
            Ok(Arc::new(SttEngine::load(&SttConfig {
                model_dir: paths::models_root(app).join(STT_MODEL_DIR_NAME),
                num_threads: stt_engine_threads(),
                debug: false,
                ..SttConfig::default()
            })?))
        })
    }

    /// Returns the cached summarizer, loading it on first use after any
    /// release.
    ///
    /// Model load is seconds-scale. Since Phase 3 the cache is *not*
    /// once-per-lifetime: `run_summarization` ends every operation with
    /// [`AppState::release_summarizer`], returning the ~5 GB of weights
    /// and KV cache to the OS immediately. A reload is safe: the
    /// `LlamaBackend::drop` in llama-cpp-2 0.1.154 resets the
    /// once-per-process init flag and calls `llama_backend_free`, and
    /// `Summarizer::drop` joins the inference worker synchronously (proven
    /// by the model-gated `summarizer_reloads_after_being_dropped` test),
    /// so the next summarization pays a seconds-scale load. Summarizations
    /// are explicit, infrequent, user-triggered operations, which is the
    /// tradeoff; holding the model forever was the leak. Callers must
    /// still serialize through [`AppState::begin_summarization`] so only
    /// one operation references the model at a time.
    pub fn summarizer(&self, app: &AppHandle) -> Result<Arc<Summarizer>, AppError> {
        self.summarizer.get_or_load(|| {
            Ok(Arc::new(Summarizer::load(
                &paths::models_root(app)
                    .join(LLM_MODEL_DIR_NAME)
                    .join(LLM_MODEL_FILE_NAME),
            )?))
        })
    }

    /// Returns the cached speaker diarizer, loading it on first use after
    /// any release. Mirrors [`AppState::summarizer`]'s end-of-operation
    /// lifecycle: `commands::import::run_diarize` releases it via
    /// [`AppState::release_diarizer`] when the diarization completes, and
    /// `diarize_meeting_blocking` serializes callers through
    /// [`AppState::import_guard`] so exactly one operation holds it at a
    /// time.
    pub fn diarizer(&self, app: &AppHandle) -> Result<Arc<Diarizer>, AppError> {
        self.diarizer.get_or_load(|| {
            let models_root = paths::models_root(app);
            Ok(Arc::new(Diarizer::load(&DiarizeConfig {
                segmentation_model: models_root
                    .join(DIARIZE_SEG_DIR_NAME)
                    .join(DIARIZE_SEG_FILE_NAME),
                embedding_model: models_root
                    .join(DIARIZE_EMB_DIR_NAME)
                    .join(DIARIZE_EMB_FILE_NAME),
                num_threads: stt_engine_threads(),
                ..DiarizeConfig::default()
            })?))
        })
    }

    /// End-of-operation release for the summarizer slot (see
    /// [`AppState::summarizer`] for the reload tradeoff). Returns whether
    /// the model was actually dropped. Called by `commands::summary` once
    /// the operation's own `Arc` has been dropped.
    pub fn release_summarizer(&self) -> bool {
        self.summarizer.release_if_last()
    }

    /// End-of-operation release for the diarizer slot — the
    /// [`AppState::release_summarizer`] counterpart for `run_diarize`.
    pub fn release_diarizer(&self) -> bool {
        self.diarizer.release_if_last()
    }

    /// Restarts the STT engine's [`IDLE_MODEL_TTL`] countdown from *now*.
    /// Called when an operation that used the engine finishes (stop/cancel
    /// recording, import, re-transcribe), so "idle" means idle since the
    /// last use, not idle since the last acquire.
    pub fn touch_stt_last_used(&self) {
        self.stt_engine.touch();
    }

    /// Releases the cached STT engine when the app has genuinely gone idle
    /// from it: no recording session in the slot, no import/re-transcribe
    /// in flight ([`stt_evict_allowed`]), and [`IDLE_MODEL_TTL`] elapsed
    /// since the last use. Never blocks (all `try_lock`), so it is safe to
    /// call from the synchronous command paths that poll it —
    /// `recording_state` (boot/reload) and `list_input_devices` (the UI's
    /// 5 s device poll), which together give the check a periodic tick
    /// without introducing a dedicated timer.
    pub fn evict_stt_if_idle(&self) -> bool {
        // A contended session lock means a start/stop is mid-flight:
        // treat it as active and let the next poll retry.
        let session_active = match self.session.try_lock() {
            Ok(session) => session.is_some(),
            Err(_) => true,
        };
        if !stt_evict_allowed(session_active, self.import_busy()) {
            return false;
        }
        self.stt_engine.evict_if_idle(IDLE_MODEL_TTL)
    }

    /// Test seams: the raw model slots, so tests can assert release
    /// actually dropped a loaded model via `weak()`/`arc_count()`.
    pub fn stt_slot(&self) -> &ModelSlot<SttEngine> {
        &self.stt_engine
    }

    pub fn summarizer_slot(&self) -> &ModelSlot<Summarizer> {
        &self.summarizer
    }

    pub fn diarizer_slot(&self) -> &ModelSlot<Diarizer> {
        &self.diarizer
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
