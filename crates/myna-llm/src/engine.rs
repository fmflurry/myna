//! Inference engine over the safe `llama-cpp-2` wrapper: model loading,
//! chat-template formatting, prefill, streaming token generation, and
//! map-reduce summarization for transcripts too long to fit one prompt.
//!
//! Two llama.cpp limits matter here, and violating either used to abort
//! the whole process (`ggml_abort` -> `SIGABRT`) rather than return an
//! error:
//!
//! - `n_batch`: the max tokens a single `llama_decode` call may carry.
//!   [`prefill`] chunks the prompt across as many decode calls as needed
//!   instead of submitting it all at once (see [`prefill_chunks`]).
//! - `n_ctx`: the total context window. [`Summarizer::summarize_transcript`]
//!   checks a prompt's token count against `n_ctx` (minus room to
//!   generate) before it ever reaches llama.cpp, and falls back to
//!   map-reduce — summarize transcript chunks independently, then
//!   summarize the combined chunk summaries — when a single prompt
//!   wouldn't fit. A 30+ minute meeting transcript is this crate's normal
//!   case, not an edge case.
//!
//! [`ensure_decode_budget`] is a last-line defensive check before every
//! `llama_decode` call: if either limit would still be exceeded (a bug
//! upstream of it notwithstanding), it returns [`LlmError::PromptTooLong`]
//! instead of letting ggml abort the process.
//!
//! All llama.cpp state — backend, model, and the single reusable
//! `LlamaContext` — is owned by a dedicated inference thread created by
//! [`Summarizer::load`]. That indirection is forced, not stylistic:
//! `LlamaContext` is `!Send` (it wraps raw pointers) and borrows the
//! model it was built from, so it can be neither stored inside a
//! `Send + Sync` struct nor shared across threads; on the worker it is a
//! plain stack local borrowing a sibling local. The public [`Summarizer`]
//! methods are thin blocking client APIs over a message channel to that
//! thread — only owned `String`s and results cross the boundary. Reusing
//! one context across calls is also the fix for the ~1.2 GB KV-cache
//! allocation that was previously churned by every `summarize` call
//! (including every map-reduce chunk).

use std::num::NonZeroU32;
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::sync::Once;
use std::thread::JoinHandle;
use std::time::Duration;

use encoding_rs::Decoder;
use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::context::LlamaContext;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{AddBos, LlamaChatMessage, LlamaChatTemplate, LlamaModel};
use llama_cpp_2::sampling::LlamaSampler;
use llama_cpp_2::token::LlamaToken;

use crate::error::LlmError;
use crate::template::{RenderContext, Template};

/// Default context window, in tokens.
const DEFAULT_N_CTX: u32 = 32_768;
/// Default maximum number of tokens generated per summary.
const DEFAULT_MAX_TOKENS: u32 = 1024;
/// Default sampling temperature.
const DEFAULT_TEMPERATURE: f32 = 0.3;
/// Default nucleus-sampling probability mass.
const DEFAULT_TOP_P: f32 = 0.9;
/// Default sampling seed.
const DEFAULT_SEED: u32 = 1234;
/// Default thread count; `0` lets llama.cpp pick automatically.
const DEFAULT_N_THREADS: i32 = 0;
/// `min_keep` for the top-p filter: never trim below this many candidates.
const TOP_P_MIN_KEEP: usize = 1;
/// Batch sequence id used for the single-sequence prefill/decode loop.
const SEQUENCE_ID: i32 = 0;
/// Chat template name used when the GGUF has none baked in.
const FALLBACK_CHAT_TEMPLATE: &str = "chatml";

/// Maximum tokens submitted to a single `llama_decode` call, set
/// explicitly rather than left to whatever `llama-cpp-2`/llama.cpp
/// currently defaults to (confirmed as 2048 for the pinned version, but
/// previously never set here at all — the exact bug this file fixes: a
/// 33-minute meeting's prefill vastly exceeded it, submitted as one
/// decode, and `ggml_abort`ed the process). [`prefill_chunks`] splits any
/// longer prompt across multiple decode calls to respect this.
const DEFAULT_N_BATCH: u32 = 2048;

/// Tokens reserved, beyond a prompt's exact measured length, when checking
/// whether it fits `n_ctx` alongside `max_tokens` worth of generation.
/// Covers minor tokenization variance at chunk boundaries during
/// map-reduce chunk-budget estimation (see
/// [`Summarizer::chunk_token_budget`]); the hard backstop against actually
/// exceeding `n_ctx` is [`ensure_decode_budget`], not this margin.
const CONTEXT_MARGIN_TOKENS: u32 = 64;

/// Maximum recursive map-reduce rounds before giving up with
/// [`LlmError::PromptTooLong`] instead of recursing forever. Chunk
/// summaries are far shorter than the transcript chunks that produced
/// them, so real transcripts converge in one or two rounds; this is a
/// backstop against a pathological template or model output that doesn't
/// shrink.
const MAX_REDUCE_DEPTH: u32 = 4;

/// How often a blocked [`Summarizer::summarize`] caller re-checks its
/// `cancel` flag while waiting for the inference worker to stream a
/// result. Bounds cancellation latency to this interval plus one
/// generated token — small enough to feel immediate, and negligible
/// next to a decode step. The worker cannot poll the `AtomicBool`
/// itself: `&AtomicBool` borrows the caller's stack, so cancellation is
/// forwarded to it as a one-shot message (see [`Job::Generate`]).
const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(20);

/// Tunable generation parameters for [`Summarizer::summarize`].
#[derive(Debug, Clone)]
pub struct SummaryOptions {
    pub n_ctx: u32,
    pub max_tokens: u32,
    pub temperature: f32,
    pub top_p: f32,
    pub seed: u32,
    pub n_threads: i32,
}

impl Default for SummaryOptions {
    fn default() -> Self {
        Self {
            n_ctx: DEFAULT_N_CTX,
            max_tokens: DEFAULT_MAX_TOKENS,
            temperature: DEFAULT_TEMPERATURE,
            top_p: DEFAULT_TOP_P,
            seed: DEFAULT_SEED,
            n_threads: DEFAULT_N_THREADS,
        }
    }
}

/// Guards [`init_ggml_env`] so it only ever sets the environment once per
/// process, however many entry points call it.
static INIT_GGML_ENV: Once = Once::new();

/// Disables ggml's Metal residency-set tracking, before any model is
/// loaded, to prevent a deterministic `abort()` at process exit.
///
/// ## The bug
///
/// ggml unconditionally asserts that every Metal buffer has been freed
/// before the Metal device itself is destroyed — this assert is **not**
/// compiled out in release builds:
///
/// ```objc
/// // llama.cpp/ggml/src/ggml-metal/ggml-metal-device.m:656
/// GGML_ASSERT([rsets->data count] == 0);
/// ```
///
/// Myna's [`Summarizer`] (which owns the `LlamaModel` and its Metal weight
/// buffers) is held in a `OnceLock` in `app/src-tauri/src/state.rs` that is
/// never dropped, so those buffers stay registered in the device's
/// residency set for the whole life of the process. On quit (⌘Q ->
/// `-[NSApplication terminate:]` -> `exit()`), `__cxa_finalize_ranges` runs
/// the static destructor for ggml's own
/// `static std::vector<ggml_metal_device_ptr> devs;`
/// (`ggml-metal-device.cpp:21`), which frees the device, hits the assert
/// above, and `abort()`s — deterministically, every quit, once
/// `Summarizer::load` has succeeded at least once in the process. Leaking
/// harder on the Rust side cannot fix this: `devs` is registered via
/// `__cxa_atexit` inside ggml's own translation unit, independent of Rust
/// ownership.
///
/// ## The fix
///
/// Setting `GGML_METAL_NO_RESIDENCY=1` makes `ggml_metal_device_init` skip
/// residency-set tracking entirely:
///
/// ```objc
/// // llama.cpp/ggml/src/ggml-metal/ggml-metal-device.m:863
/// dev->props.use_residency_sets = getenv("GGML_METAL_NO_RESIDENCY") == nil;
/// ```
///
/// With `use_residency_sets` false, `dev->rsets` stays `nil`, so
/// `ggml_metal_rsets_free(NULL)` early-returns (`ggml-metal-device.m:651-653`)
/// before it ever reaches the assert. The sibling call sites are
/// consistent with this: `rsets_add`/`rsets_rm` both null-check and
/// return early on `rset == nil` (`:988-990`, `:1002-1004`), and
/// `rsets_keep_alive` null-checks the same way (`:1016-1018`) — so this is
/// safe for the model's entire lifetime, not just at teardown.
///
/// ## Tradeoff
///
/// Without residency sets, Metal no longer keeps model weight buffers
/// wired into GPU-resident memory ahead of use, so the first token
/// generated after a long idle period may pay a one-time page-in cost.
///
/// ## Removal condition
///
/// Upstream llama.cpp still has this bug on `master`, with several stalled
/// fix attempts (closest: llama.cpp#26857). Remove this workaround once one
/// of those lands and ggml's teardown tolerates a live residency set.
///
/// ## Call sites
///
/// Called as the first statement of [`Summarizer::load`] so this crate is
/// self-protecting regardless of caller, and additionally from the Tauri
/// app's `main` (before any other thread starts) and the `myna-llm` CLI's
/// `main`, so the environment is set before `LlamaBackend::init()` in every
/// entry point. `std::env::set_var` is only guaranteed data-race-free
/// absent concurrent env reads/writes from other threads; the `Once` guard
/// makes every call after the first a no-op, so calling this from multiple
/// entry points (or from `Summarizer::load` on a later, non-`main` thread)
/// never re-triggers the mutation.
pub fn init_ggml_env() {
    INIT_GGML_ENV.call_once(|| {
        #[cfg(target_os = "macos")]
        std::env::set_var("GGML_METAL_NO_RESIDENCY", "1");
    });
}

/// One unit of work for the inference worker thread (see [`Summarizer`]'s
/// struct docs for why work is delegated at all).
enum Job {
    /// Tokenize `prompt` through the model's chat template and report the
    /// token count — the same measurement [`Summarizer::summarize`] makes
    /// internally, needed by the map-reduce fit checks.
    CountTokens {
        prompt: String,
        resp: Sender<Result<usize, LlmError>>,
    },
    /// Prefill `prompt` and stream generated pieces through `stream`,
    /// ending with exactly one [`StreamMsg::Done`].
    Generate {
        prompt: String,
        opts: SummaryOptions,
        /// Carries the caller's cancellation as a single `true` message;
        /// the caller's `&AtomicBool` cannot cross to this thread.
        cancel: Receiver<bool>,
        stream: Sender<StreamMsg>,
    },
    /// Free the context, model, and backend and end the worker thread.
    Shutdown,
}

/// One streamed update for [`Job::Generate`].
enum StreamMsg {
    /// A decoded piece of generated text.
    Piece(String),
    /// Terminal message: the accumulated summary, or the error that
    /// stopped generation. Always sent exactly once per job.
    Done(Result<String, LlmError>),
}

/// A loaded Qwen (or any GGUF chat) model ready to summarize prompts.
///
/// All llama.cpp state — backend, model, and the single reusable
/// `LlamaContext` — lives on a dedicated inference thread owned by this
/// value, for two reasons:
///
/// - `LlamaContext` is `!Send` (raw pointers) and borrows the model it
///   was built from, so it can be neither stored inside a `Send + Sync`
///   struct (which this must be: the Tauri app shares `Arc<Summarizer>`
///   across `spawn_blocking` threads) nor moved between threads. On the
///   worker it is a plain stack local borrowing a sibling local — no
///   self-reference needed.
/// - Building a context allocates the whole KV cache (~1.2 GB at the
///   32k-token default). Before this design every `summarize` call —
///   including every map-reduce chunk — paid that allocation and freed
///   it again; one context is now built per `Summarizer` and reused,
///   with its KV cache cleared between jobs.
///
/// Every public method is a blocking round-trip to the worker, so jobs
/// on one `Summarizer` serialize (the app additionally guards
/// summarization with a busy flag; a second caller simply queues).
/// Dropping the last reference shuts the worker down and joins it,
/// freeing weights and KV cache before `drop` returns.
pub struct Summarizer {
    jobs: Sender<Job>,
    /// `None` only transiently: [`Drop::drop`] takes the handle to join it.
    worker: Option<JoinHandle<()>>,
}

impl Summarizer {
    /// Load `model_path` into llama.cpp.
    ///
    /// Returns [`LlmError::ModelNotFound`] before touching llama.cpp at all
    /// if the path does not exist on disk.
    ///
    /// Calls [`init_ggml_env`] first (idempotent — see its docs) so this
    /// crate is self-protecting against the ⌘Q Metal-teardown abort even
    /// if a caller forgets to call it themselves.
    ///
    /// Spawns the inference worker (see [`Summarizer`]), which initializes
    /// the backend, loads the model, and builds the reusable context;
    /// this call blocks until that completes, so a failure at any step —
    /// including context (KV-cache) allocation — surfaces here rather
    /// than at the first [`Summarizer::summarize`].
    pub fn load(model_path: &Path) -> Result<Self, LlmError> {
        init_ggml_env();

        if !model_path.exists() {
            return Err(LlmError::ModelNotFound(model_path.to_path_buf()));
        }

        let (jobs_tx, jobs_rx) = channel();
        let (ready_tx, ready_rx) = channel();
        let worker_path = model_path.to_path_buf();
        let worker = std::thread::Builder::new()
            .name("myna-llm-inference".to_string())
            .spawn(move || inference_worker(worker_path, jobs_rx, ready_tx))
            .map_err(|err| LlmError::Load(format!("spawning inference worker: {err}")))?;

        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Self {
                jobs: jobs_tx,
                worker: Some(worker),
            }),
            Ok(Err(err)) => {
                let _ = worker.join();
                Err(err)
            }
            Err(_) => {
                // `ready_tx` dropped without a report: the worker panicked
                // while loading. `join` surfaces its panic to the log.
                let _ = worker.join();
                Err(LlmError::Load(
                    "inference worker panicked while loading the model".to_string(),
                ))
            }
        }
    }

    /// Renders `template` against `ctx` and summarizes the result, like
    /// [`Summarizer::summarize`] — except it never lets an over-long
    /// prompt reach llama.cpp. If the fully rendered prompt would not fit
    /// inside `opts.n_ctx` alongside `opts.max_tokens` worth of generation,
    /// this falls back to map-reduce: split `ctx.transcript` into chunks
    /// that do fit, summarize each chunk independently, then summarize the
    /// concatenated chunk summaries with the same `template` — recursing
    /// (up to [`MAX_REDUCE_DEPTH`] rounds) if even that combined pass
    /// doesn't fit.
    ///
    /// This is the entry point both the CLI and the Tauri command use, so
    /// a 30+ minute meeting — this app's normal case, not an edge case —
    /// never has to think about chunking.
    ///
    /// Streaming: only the pass that produces the returned text streams
    /// tokens through `on_token` — a single-shot summary when the prompt
    /// already fits, otherwise the final reduce pass. Intermediate
    /// per-chunk map passes run silently: their output feeds the next
    /// round rather than being the answer the caller is waiting on, so
    /// streaming it as "the" summary would be misleading.
    ///
    /// `cancel` is checked before each chunk and before recursing, in
    /// addition to the per-token check inside [`Summarizer::summarize`],
    /// so cancellation still takes effect promptly mid-map-reduce.
    pub fn summarize_transcript(
        &self,
        template: &Template,
        ctx: &RenderContext,
        opts: &SummaryOptions,
        cancel: &AtomicBool,
        mut on_token: impl FnMut(&str),
    ) -> Result<String, LlmError> {
        self.summarize_transcript_at_depth(template, ctx, opts, cancel, &mut on_token, 0)
    }

    /// Recursive worker behind [`Summarizer::summarize_transcript`]; see
    /// its docs for the overall algorithm. `depth` counts map-reduce
    /// rounds and is capped at [`MAX_REDUCE_DEPTH`].
    fn summarize_transcript_at_depth(
        &self,
        template: &Template,
        ctx: &RenderContext,
        opts: &SummaryOptions,
        cancel: &AtomicBool,
        on_token: &mut dyn FnMut(&str),
        depth: u32,
    ) -> Result<String, LlmError> {
        if cancel.load(Ordering::SeqCst) {
            return Err(LlmError::Cancelled);
        }

        let full_prompt = template.render(ctx);
        let prompt_tokens = self.formatted_token_count(&full_prompt)?;

        if fits_in_context(prompt_tokens, opts.max_tokens, opts.n_ctx) {
            return self.summarize(&full_prompt, opts, cancel, on_token);
        }

        if depth >= MAX_REDUCE_DEPTH {
            return Err(LlmError::PromptTooLong(format!(
                "transcript still needs {prompt_tokens} prompt tokens after {depth} rounds of \
                 map-reduce summarization, which does not fit n_ctx ({}); giving up",
                opts.n_ctx
            )));
        }

        let chunk_budget = self.chunk_token_budget(template, ctx, opts)?;
        let chunks = split_transcript(&ctx.transcript, chunk_budget, |text| {
            self.formatted_token_count(text).unwrap_or(usize::MAX)
        });

        let mut chunk_summaries = Vec::with_capacity(chunks.len());
        for chunk in &chunks {
            if cancel.load(Ordering::SeqCst) {
                return Err(LlmError::Cancelled);
            }

            let chunk_ctx = RenderContext {
                transcript: chunk.clone(),
                ..ctx.clone()
            };
            let chunk_prompt = template.render(&chunk_ctx);
            let summary = self.summarize(&chunk_prompt, opts, cancel, |_: &str| {})?;
            chunk_summaries.push(summary);
        }

        let reduced_ctx = RenderContext {
            transcript: chunk_summaries.join("\n\n"),
            ..ctx.clone()
        };

        self.summarize_transcript_at_depth(
            template,
            &reduced_ctx,
            opts,
            cancel,
            on_token,
            depth + 1,
        )
    }

    /// Format `prompt` via the model's chat template, run prefill, then
    /// stream generated tokens through `on_token` until end-of-generation,
    /// `opts.max_tokens`, or `cancel` is observed.
    ///
    /// Returns the accumulated generated text.
    ///
    /// Low-level, single-shot API: `prompt` is submitted exactly as given,
    /// with no fit check against `opts.n_ctx` beyond the defensive,
    /// per-decode-call check in [`ensure_decode_budget`]. Prefer
    /// [`Summarizer::summarize_transcript`] for transcript-driven prompts,
    /// which checks fit up front and transparently falls back to
    /// map-reduce for prompts that don't fit.
    ///
    /// Runs on the inference worker against its reused context (see
    /// [`Summarizer`]); this call blocks until the job finishes.
    /// Cancellation keeps its pre-worker semantics exactly: the flag is
    /// observed once per generated token, never mid-prefill.
    pub fn summarize(
        &self,
        prompt: &str,
        opts: &SummaryOptions,
        cancel: &AtomicBool,
        mut on_token: impl FnMut(&str),
    ) -> Result<String, LlmError> {
        let (cancel_tx, cancel_rx) = channel();
        let (stream_tx, stream_rx) = channel();
        self.post(Job::Generate {
            prompt: prompt.to_string(),
            opts: opts.clone(),
            cancel: cancel_rx,
            stream: stream_tx,
        })?;

        // The worker owns the `!Send` context and the `&AtomicBool` here
        // cannot cross to it, so poll the flag on this (caller's) thread
        // and forward a one-shot cancellation message on each timeout.
        loop {
            match stream_rx.recv_timeout(CANCEL_POLL_INTERVAL) {
                Ok(StreamMsg::Piece(piece)) => on_token(&piece),
                Ok(StreamMsg::Done(result)) => return result,
                Err(RecvTimeoutError::Timeout) => {
                    if cancel.load(Ordering::SeqCst) {
                        // Best effort: the worker may already be done.
                        let _ = cancel_tx.send(true);
                    }
                }
                Err(RecvTimeoutError::Disconnected) => return Err(worker_gone()),
            }
        }
    }

    /// Sends `job` to the inference worker, mapping a dead worker (panic,
    /// or use-after-shutdown) to an error rather than a silent hang.
    fn post(&self, job: Job) -> Result<(), LlmError> {
        self.jobs.send(job).map_err(|_| worker_gone())
    }

    /// Tokenizes `prompt` through the same chat-template formatting
    /// [`Summarizer::summarize`] uses, returning only the token count.
    /// Used to check whether a candidate prompt fits `opts.n_ctx` without
    /// otherwise duplicating [`Summarizer::summarize`]'s logic. A
    /// round-trip to the inference worker, which owns the model.
    fn formatted_token_count(&self, prompt: &str) -> Result<usize, LlmError> {
        let (resp_tx, resp_rx) = channel();
        self.post(Job::CountTokens {
            prompt: prompt.to_string(),
            resp: resp_tx,
        })?;
        resp_rx.recv().map_err(|_| worker_gone())?
    }

    /// Maximum token budget for a single map-reduce transcript chunk: the
    /// overall [`context_budget`] minus the token cost of `template`'s
    /// fixed wording around an empty transcript, so a rendered chunk plus
    /// that fixed wording still fits.
    fn chunk_token_budget(
        &self,
        template: &Template,
        ctx: &RenderContext,
        opts: &SummaryOptions,
    ) -> Result<usize, LlmError> {
        let overhead_ctx = RenderContext {
            transcript: String::new(),
            ..ctx.clone()
        };
        let overhead_tokens = self.formatted_token_count(&template.render(&overhead_ctx))?;
        let total_budget = context_budget(opts.max_tokens, opts.n_ctx);

        total_budget.checked_sub(overhead_tokens).ok_or_else(|| {
            LlmError::PromptTooLong(format!(
                "template overhead alone ({overhead_tokens} tokens) leaves no room for any \
                 transcript content within the {total_budget}-token budget"
            ))
        })
    }
}

/// Error for any operation that needs the inference worker after it has
/// exited (panic, or a job posted through a leaked-but-shutdown handle).
fn worker_gone() -> LlmError {
    LlmError::Context("the myna-llm inference worker thread is no longer running".to_string())
}

impl Drop for Summarizer {
    /// Frees the llama.cpp state: the worker finishes (or abandons) any
    /// in-flight job, then drops context, model, and backend — in that
    /// order — on its way out, and `join` guarantees that completed
    /// before this returns. A later app phase that evicts the cached
    /// `Summarizer` relies on this to return the ~1.2 GB KV cache (and
    /// the weights) to the OS.
    fn drop(&mut self) {
        let _ = self.jobs.send(Job::Shutdown);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

/// The inference worker's whole life: load, report readiness, then serve
/// jobs until shutdown. Backend, model, and context are stack locals of
/// this function — the context may only borrow the model while they
/// share a scope (and llama.cpp requires model and backend to outlive
/// it), which is exactly what "owned by this thread" buys; Rust drops
/// locals in reverse declaration order, so the context is freed before
/// the model and the backend before both.
fn inference_worker(model_path: PathBuf, jobs: Receiver<Job>, ready: Sender<Result<(), LlmError>>) {
    let (backend, model) = match load_backend_and_model(&model_path) {
        Ok(pair) => pair,
        Err(err) => {
            let _ = ready.send(Err(err));
            return;
        }
    };
    let mut context = match build_context(&model, &backend, DEFAULT_N_CTX, DEFAULT_N_THREADS) {
        Ok(context) => context,
        Err(err) => {
            let _ = ready.send(Err(err));
            return;
        }
    };
    // (effective n_ctx, requested n_threads) the current context was
    // built with — see [`serve_generation`] for when it is rebuilt.
    let mut context_key = (context.n_ctx(), DEFAULT_N_THREADS);

    if ready.send(Ok(())).is_err() {
        return; // the caller gave up before load finished
    }

    for job in jobs {
        match job {
            Job::Shutdown => break,
            Job::CountTokens { prompt, resp } => {
                let _ = resp.send(count_formatted_tokens(&model, &prompt));
            }
            Job::Generate {
                prompt,
                opts,
                cancel,
                stream,
            } => {
                let result = serve_generation(
                    &model,
                    &backend,
                    &mut context,
                    &mut context_key,
                    &opts,
                    &prompt,
                    &cancel,
                    &stream,
                );
                let _ = stream.send(StreamMsg::Done(result));
            }
        }
    }
}

/// Initializes the llama.cpp backend and loads the model. Runs only on
/// the inference worker thread ([`inference_worker`]).
fn load_backend_and_model(model_path: &Path) -> Result<(LlamaBackend, LlamaModel), LlmError> {
    let backend = LlamaBackend::init().map_err(|err| LlmError::Load(err.to_string()))?;
    let model = LlamaModel::load_from_file(&backend, model_path, &LlamaModelParams::default())
        .map_err(|err| LlmError::Load(err.to_string()))?;
    Ok((backend, model))
}

/// Builds an inference context sized for `n_ctx`/`n_threads`, with the
/// fixed [`DEFAULT_N_BATCH`] decode cap. The returned context borrows
/// `model` (llama.cpp requires the model to outlive its contexts; the
/// backend argument is a proof-of-init token that does not constrain the
/// context's lifetime in `llama-cpp-2` 0.1.154).
fn build_context<'a>(
    model: &'a LlamaModel,
    backend: &LlamaBackend,
    n_ctx: u32,
    n_threads: i32,
) -> Result<LlamaContext<'a>, LlmError> {
    let ctx_params = LlamaContextParams::default()
        .with_n_ctx(NonZeroU32::new(n_ctx))
        .with_n_batch(DEFAULT_N_BATCH)
        .with_n_threads(n_threads);
    model
        .new_context(backend, ctx_params)
        .map_err(|err| LlmError::Context(err.to_string()))
}

/// Serves one [`Job::Generate`]: rebuild the shared context only when
/// this call asks for different allocation parameters than the current
/// context was built with (the map-reduce tests, for instance, run at
/// `n_ctx: 4096` while production uses the default), clear its KV cache,
/// then prefill and generate, streaming pieces through `stream`.
#[allow(clippy::too_many_arguments)]
fn serve_generation<'a>(
    model: &'a LlamaModel,
    backend: &LlamaBackend,
    context: &mut LlamaContext<'a>,
    context_key: &mut (u32, i32),
    opts: &SummaryOptions,
    prompt: &str,
    cancel: &Receiver<bool>,
    stream: &Sender<StreamMsg>,
) -> Result<String, LlmError> {
    if (opts.n_ctx, opts.n_threads) != *context_key {
        // The key stores the context's *effective* n_ctx, so a request
        // llama.cpp would cap below the ask rebuilds per call — correct,
        // just no cheaper than the pre-fix behavior for that shape.
        *context = build_context(model, backend, opts.n_ctx, opts.n_threads)?;
        *context_key = (context.n_ctx(), opts.n_threads);
    }
    context.clear_kv_cache();

    let formatted = format_prompt(model, prompt)?;
    let tokens = model
        .str_to_token(&formatted, AddBos::Always)
        .map_err(|err| LlmError::Tokenize(err.to_string()))?;

    let batch_capacity = context.n_batch().max(1) as usize;
    let mut batch = LlamaBatch::new(batch_capacity, 1);
    let mut n_cur = prefill(context, &mut batch, &tokens)?;

    let sampler = LlamaSampler::chain_simple([
        LlamaSampler::temp(opts.temperature),
        LlamaSampler::top_p(opts.top_p, TOP_P_MIN_KEEP),
        LlamaSampler::dist(opts.seed),
    ]);

    generate(
        model,
        context,
        &mut batch,
        sampler,
        &mut n_cur,
        opts.max_tokens,
        cancel,
        &mut |piece| stream.send(StreamMsg::Piece(piece.to_string())).is_ok(),
    )
}

/// Format `prompt` as a single user turn via the model's baked-in chat
/// template, falling back to ChatML when the GGUF has none.
fn format_prompt(model: &LlamaModel, prompt: &str) -> Result<String, LlmError> {
    let template = match model.chat_template(None) {
        Ok(tmpl) => tmpl,
        Err(_) => {
            LlamaChatTemplate::new(FALLBACK_CHAT_TEMPLATE).map_err(|_| LlmError::NoChatTemplate)?
        }
    };

    let messages = vec![
        LlamaChatMessage::new("user".to_string(), prompt.to_string())
            .map_err(|err| LlmError::Tokenize(err.to_string()))?,
    ];

    model
        .apply_chat_template(&template, &messages, true)
        .map_err(|err| LlmError::Tokenize(err.to_string()))
}

/// Tokenize `prompt` through [`format_prompt`], returning only the token
/// count (behind the [`Summarizer::formatted_token_count`] round-trip).
fn count_formatted_tokens(model: &LlamaModel, prompt: &str) -> Result<usize, LlmError> {
    let formatted = format_prompt(model, prompt)?;
    let tokens = model
        .str_to_token(&formatted, AddBos::Always)
        .map_err(|err| LlmError::Tokenize(err.to_string()))?;
    Ok(tokens.len())
}

/// True when the caller has cancelled the in-flight job: either it
/// forwarded its `AtomicBool` state (`Ok(true)`), or it dropped the
/// sender entirely (`Disconnected` — the caller panicked or abandoned
/// the job, so there is no one left to serve).
fn is_cancelled(cancel: &Receiver<bool>) -> bool {
    !matches!(cancel.try_recv(), Err(TryRecvError::Empty))
}

/// One `llama_decode` call's worth of a chunked prefill: the absolute
/// token-index range to submit, and — if any position in this chunk
/// should have `logits` enabled — which absolute index that is. Only the
/// very last token of the very last chunk ever gets `logits: true`: it's
/// the only one [`generate`] samples from.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PrefillChunk {
    range: Range<usize>,
    logits_at: Option<usize>,
}

/// Splits `total_tokens` into [`PrefillChunk`]s of at most `chunk_size`
/// tokens each, in order, so a chunked prefill never submits more than
/// `chunk_size` tokens (`n_batch`) to a single `llama_decode` call —
/// exceeding it aborts the whole process rather than returning an error.
/// `chunk_size` is clamped to at least 1 so this can't loop forever or
/// panic on `chunk_size == 0`.
fn prefill_chunks(total_tokens: usize, chunk_size: usize) -> Vec<PrefillChunk> {
    let step = chunk_size.max(1);
    let mut chunks = Vec::new();
    let mut start = 0;

    while start < total_tokens {
        let end = (start + step).min(total_tokens);
        let is_last_chunk = end == total_tokens;
        let logits_at = if is_last_chunk { Some(end - 1) } else { None };
        chunks.push(PrefillChunk {
            range: start..end,
            logits_at,
        });
        start = end;
    }

    chunks
}

/// Feed `tokens` into `batch` across as many `llama_decode` calls as
/// needed to respect `ctx`'s configured `n_batch` (see [`prefill_chunks`]
/// and the module docs for why this can no longer submit everything in
/// one call). Returns the position (`n_cur`) immediately after the
/// prefilled tokens.
fn prefill(
    ctx: &mut LlamaContext,
    batch: &mut LlamaBatch,
    tokens: &[LlamaToken],
) -> Result<i32, LlmError> {
    let n_batch = ctx.n_batch().max(1) as usize;
    let n_ctx = ctx.n_ctx();

    for chunk in prefill_chunks(tokens.len(), n_batch) {
        batch.clear();

        for index in chunk.range.clone() {
            let pos = i32::try_from(index).map_err(|_| {
                LlmError::PromptTooLong(format!(
                    "prompt position {index} does not fit an i32 token position"
                ))
            })?;
            let logits = chunk.logits_at == Some(index);
            batch
                .add(tokens[index], pos, &[SEQUENCE_ID], logits)
                .map_err(|err| LlmError::Context(err.to_string()))?;
        }

        ensure_decode_budget(batch.n_tokens(), n_batch, chunk.range.end, n_ctx)?;
        ctx.decode(batch)
            .map_err(|err| LlmError::Context(err.to_string()))?;
    }

    i32::try_from(tokens.len()).map_err(|_| {
        LlmError::PromptTooLong(format!(
            "prompt has {} tokens, which does not fit an i32 position",
            tokens.len()
        ))
    })
}

/// Last-line defensive check before every `llama_decode` call: `batch_tokens`
/// (the number of tokens about to be submitted) must not exceed `n_batch`,
/// and `end_pos` (the context position immediately after this decode) must
/// not exceed `n_ctx`. Returns [`LlmError::PromptTooLong`] instead of
/// letting either violation reach llama.cpp, where it would `ggml_abort`
/// the whole process rather than fail gracefully.
fn ensure_decode_budget(
    batch_tokens: i32,
    n_batch: usize,
    end_pos: usize,
    n_ctx: u32,
) -> Result<(), LlmError> {
    let batch_tokens = usize::try_from(batch_tokens).unwrap_or(usize::MAX);
    if batch_tokens > n_batch {
        return Err(LlmError::PromptTooLong(format!(
            "decode batch of {batch_tokens} tokens exceeds n_batch ({n_batch})"
        )));
    }
    if end_pos as u64 > u64::from(n_ctx) {
        return Err(LlmError::PromptTooLong(format!(
            "decode position {end_pos} exceeds n_ctx ({n_ctx})"
        )));
    }
    Ok(())
}

/// Tokens reserved beyond a prompt's exact length; see
/// [`CONTEXT_MARGIN_TOKENS`].
fn context_budget(max_tokens: u32, n_ctx: u32) -> usize {
    let reserved = max_tokens.saturating_add(CONTEXT_MARGIN_TOKENS);
    n_ctx.saturating_sub(reserved) as usize
}

/// True if a `prompt_tokens`-token prompt leaves room for `max_tokens` of
/// generation inside `n_ctx`, per [`context_budget`].
fn fits_in_context(prompt_tokens: usize, max_tokens: u32, n_ctx: u32) -> bool {
    prompt_tokens <= context_budget(max_tokens, n_ctx)
}

/// Push `current`'s contents onto `chunks` and reset it, if non-empty.
fn flush_chunk(chunks: &mut Vec<String>, current: &mut String) {
    if !current.is_empty() {
        chunks.push(std::mem::take(current));
    }
}

/// Splits `transcript` into chunks of at most `max_tokens_per_chunk`, as
/// measured by `count_tokens`, breaking on line boundaries wherever a
/// single line fits the budget on its own. Concatenating the returned
/// chunks, in order, reconstructs `transcript` exactly — no content is
/// ever dropped, merged across a gap, or reordered.
///
/// A single line that alone exceeds `max_tokens_per_chunk` is further
/// split on word boundaries so the map phase still gets something that
/// fits; a single *word* that alone exceeds the budget is emitted as its
/// own (necessarily over-budget) chunk rather than corrupted or dropped —
/// there is nothing smaller to split it into without touching its
/// content.
fn split_transcript(
    transcript: &str,
    max_tokens_per_chunk: usize,
    count_tokens: impl Fn(&str) -> usize,
) -> Vec<String> {
    let budget = max_tokens_per_chunk.max(1);
    let mut chunks = Vec::new();
    let mut current = String::new();

    for line in transcript.split_inclusive('\n') {
        if count_tokens(line) > budget {
            flush_chunk(&mut chunks, &mut current);
            chunks.extend(split_oversized_unit(line, budget, &count_tokens));
            continue;
        }

        let candidate = format!("{current}{line}");
        if !current.is_empty() && count_tokens(&candidate) > budget {
            flush_chunk(&mut chunks, &mut current);
        }
        current.push_str(line);
    }

    flush_chunk(&mut chunks, &mut current);
    chunks
}

/// Splits a single oversized `unit` (a line too long to fit the budget on
/// its own) on word boundaries, packing as many words per chunk as fit —
/// same packing rule as [`split_transcript`], one level down.
fn split_oversized_unit(
    unit: &str,
    budget: usize,
    count_tokens: &impl Fn(&str) -> usize,
) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();

    for word in unit.split_inclusive(' ') {
        let candidate = format!("{current}{word}");
        if !current.is_empty() && count_tokens(&candidate) > budget {
            flush_chunk(&mut chunks, &mut current);
        }
        current.push_str(word);
    }

    flush_chunk(&mut chunks, &mut current);
    chunks
}

/// Sample-decode loop: generate up to `max_tokens`, streaming each decoded
/// piece through `emit`, stopping early on end-of-generation, on
/// cancellation observed via `cancel` (see [`is_cancelled`]), or when
/// `emit` returns false (the receiving caller has gone away).
#[allow(clippy::too_many_arguments)]
fn generate(
    model: &LlamaModel,
    ctx: &mut LlamaContext,
    batch: &mut LlamaBatch,
    mut sampler: LlamaSampler,
    n_cur: &mut i32,
    max_tokens: u32,
    cancel: &Receiver<bool>,
    emit: &mut impl FnMut(&str) -> bool,
) -> Result<String, LlmError> {
    let n_batch = ctx.n_batch().max(1) as usize;
    let n_ctx = ctx.n_ctx();
    let mut generated = String::new();
    let mut decoder = encoding_rs::UTF_8.new_decoder();

    for _ in 0..max_tokens {
        let token = sampler.sample(ctx, batch.n_tokens() - 1);
        sampler.accept(token);

        if model.is_eog_token(token) {
            break;
        }

        let piece = decode_token(model, token, &mut decoder)?;
        if !emit(&piece) {
            // The caller dropped the receiving half mid-job (panicked or
            // abandoned it); nothing downstream still wants this text.
            return Err(LlmError::Cancelled);
        }
        generated.push_str(&piece);

        if is_cancelled(cancel) {
            return Err(LlmError::Cancelled);
        }

        batch.clear();
        batch
            .add(token, *n_cur, &[SEQUENCE_ID], true)
            .map_err(|err| LlmError::Context(err.to_string()))?;
        let next_pos = usize::try_from(*n_cur + 1).unwrap_or(usize::MAX);
        ensure_decode_budget(batch.n_tokens(), n_batch, next_pos, n_ctx)?;
        ctx.decode(batch)
            .map_err(|err| LlmError::Context(err.to_string()))?;
        *n_cur += 1;
    }

    Ok(generated)
}

/// Decode a single generated token to a UTF-8 string piece.
fn decode_token(
    model: &LlamaModel,
    token: LlamaToken,
    decoder: &mut Decoder,
) -> Result<String, LlmError> {
    model
        .token_to_piece(token, decoder, true, None)
        .map_err(|err| LlmError::Decode(err.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- prefill_chunks: pure chunking/positions/logits, no model needed --

    #[test]
    fn prefill_chunks_of_a_token_count_spanning_several_batches_has_correct_boundaries() {
        // Arrange
        let total_tokens = 5000;
        let chunk_size = 2048;

        // Act
        let chunks = prefill_chunks(total_tokens, chunk_size);

        // Assert
        assert_eq!(
            chunks,
            vec![
                PrefillChunk {
                    range: 0..2048,
                    logits_at: None
                },
                PrefillChunk {
                    range: 2048..4096,
                    logits_at: None
                },
                PrefillChunk {
                    range: 4096..5000,
                    logits_at: Some(4999)
                },
            ]
        );
    }

    #[test]
    fn prefill_chunks_only_the_final_token_of_the_final_chunk_has_logits_enabled() {
        // Arrange
        let total_tokens = 5000;
        let chunk_size = 2048;

        // Act
        let chunks = prefill_chunks(total_tokens, chunk_size);
        let logits_positions: Vec<usize> =
            chunks.iter().filter_map(|chunk| chunk.logits_at).collect();

        // Assert
        assert_eq!(logits_positions, vec![total_tokens - 1]);
    }

    #[test]
    fn prefill_chunks_of_an_exact_multiple_of_chunk_size_has_no_trailing_empty_chunk() {
        // Arrange & Act
        let chunks = prefill_chunks(4096, 2048);

        // Assert
        assert_eq!(
            chunks,
            vec![
                PrefillChunk {
                    range: 0..2048,
                    logits_at: None
                },
                PrefillChunk {
                    range: 2048..4096,
                    logits_at: Some(4095)
                },
            ]
        );
    }

    #[test]
    fn prefill_chunks_of_a_token_count_within_a_single_batch_is_one_chunk() {
        // Arrange & Act
        let chunks = prefill_chunks(10, 2048);

        // Assert
        assert_eq!(
            chunks,
            vec![PrefillChunk {
                range: 0..10,
                logits_at: Some(9)
            }]
        );
    }

    #[test]
    fn prefill_chunks_of_zero_tokens_is_empty() {
        // Arrange & Act
        let chunks = prefill_chunks(0, 2048);

        // Assert
        assert!(chunks.is_empty());
    }

    #[test]
    fn prefill_chunks_clamps_a_zero_chunk_size_to_one_rather_than_looping_forever() {
        // Arrange & Act
        let chunks = prefill_chunks(3, 0);

        // Assert
        assert_eq!(
            chunks,
            vec![
                PrefillChunk {
                    range: 0..1,
                    logits_at: None
                },
                PrefillChunk {
                    range: 1..2,
                    logits_at: None
                },
                PrefillChunk {
                    range: 2..3,
                    logits_at: Some(2)
                },
            ]
        );
    }

    // -- context_budget / fits_in_context: pure fit calculation --

    #[test]
    fn fits_in_context_is_true_exactly_at_the_boundary() {
        // Arrange: prompt_tokens + max_tokens + margin == n_ctx exactly.
        let n_ctx = 1000;
        let max_tokens = 200;
        let prompt_tokens = (n_ctx - max_tokens - CONTEXT_MARGIN_TOKENS) as usize;

        // Act & Assert
        assert!(fits_in_context(prompt_tokens, max_tokens, n_ctx));
    }

    #[test]
    fn fits_in_context_is_false_one_token_past_the_boundary() {
        // Arrange
        let n_ctx = 1000;
        let max_tokens = 200;
        let prompt_tokens = (n_ctx - max_tokens - CONTEXT_MARGIN_TOKENS) as usize + 1;

        // Act & Assert
        assert!(!fits_in_context(prompt_tokens, max_tokens, n_ctx));
    }

    #[test]
    fn context_budget_saturates_to_zero_rather_than_underflowing() {
        // Arrange: max_tokens + margin alone already exceeds n_ctx.
        let n_ctx = 100;
        let max_tokens = 200;

        // Act & Assert
        assert_eq!(context_budget(max_tokens, n_ctx), 0);
    }

    // -- split_transcript: pure transcript-splitting logic --

    fn word_count(text: &str) -> usize {
        text.split_whitespace().count()
    }

    #[test]
    fn split_transcript_never_loses_content() {
        // Arrange
        let transcript = "line one here\nline two here\nline three here\nline four here\n";

        // Act
        let chunks = split_transcript(transcript, 3, word_count);

        // Assert
        assert_eq!(chunks.concat(), transcript);
    }

    #[test]
    fn split_transcript_keeps_every_chunk_within_budget_for_normal_lines() {
        // Arrange
        let transcript = "one two three\nfour five six\nseven eight nine\nten eleven twelve\n";
        let budget = 6;

        // Act
        let chunks = split_transcript(transcript, budget, word_count);

        // Assert
        assert!(chunks.iter().all(|chunk| word_count(chunk) <= budget));
        assert!(chunks.len() > 1, "expected more than one chunk");
    }

    #[test]
    fn split_transcript_splits_on_line_boundaries_when_a_line_fits_the_budget() {
        // Arrange
        let transcript = "alice: hello there\nbob: hi alice\n";

        // Act
        let chunks = split_transcript(transcript, 3, word_count);

        // Assert
        assert_eq!(chunks, vec!["alice: hello there\n", "bob: hi alice\n"]);
    }

    #[test]
    fn split_transcript_of_content_within_budget_is_a_single_chunk() {
        // Arrange
        let transcript = "alice: hello\nbob: hi\n";

        // Act
        let chunks = split_transcript(transcript, 100, word_count);

        // Assert
        assert_eq!(chunks, vec![transcript.to_string()]);
    }

    #[test]
    fn split_transcript_splits_a_single_oversized_line_on_word_boundaries() {
        // Arrange: one line alone exceeds the budget.
        let transcript = "alice: one two three four five six\n";
        let budget = 2;

        // Act
        let chunks = split_transcript(transcript, budget, word_count);

        // Assert
        assert_eq!(chunks.concat(), transcript);
        assert!(chunks.len() > 1, "expected the oversized line to be split");
    }

    #[test]
    fn split_transcript_of_empty_input_is_empty() {
        // Arrange & Act
        let chunks = split_transcript("", 10, word_count);

        // Assert
        assert!(chunks.is_empty());
    }
}
