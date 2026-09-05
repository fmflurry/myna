//! Cancellable, deadline-bounded supervisor for the system-audio attachment.
//!
//! Mixed capture used to poll Core Audio rendering state from the microphone
//! realtime callback and spin (unboundedly) on a detached rebuild flag at
//! Stop time. Both are regressions waiting to happen: a HAL property
//! round-trip on the audio callback thread can blow the capture deadline,
//! and an unbounded wait on a thread that may never finish turns Stop into a
//! hang. This module moves every HAL-touching decision off the callback:
//!
//! - The callback (or any caller) only ever makes non-blocking requests
//!   ([`SystemAudioSupervisor::request_rebuild`] /
//!   [`SystemAudioSupervisor::notify_audio_callback`]).
//! - A dedicated worker thread owns the HAL query, spawns rebuild threads,
//!   enforces the attach deadline ([`SystemAudioSupervisorStatus::AttachTimedOut`]),
//!   and enforces the teardown deadline
//!   ([`SystemAudioSupervisorStatus::TeardownTimedOut`]).
//! - Cancellation is **cooperative**: a hung rebuild/stop closure is waited
//!   on for at most the configured deadline and then abandoned (never killed)
//!   with a status report, so shutdown is always bounded.
//! - Rebuild generations increase monotonically; an attach result that is
//!   late (its generation was superseded) or arrives after cancellation is
//!   rejected — stopped via [`SystemAudioAttachment::stop`] — and never
//!   published.
//!
//! Every platform operation enters through [`SystemAudioSupervisorHooks`] as
//! a plain, safe closure, which is also what lets the whole state machine be
//! tested hardware-free (see `tests/capture_resilience.rs`).

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::thread;
use std::time::{Duration, Instant};

/// How often the supervisor worker re-checks its own cancellation flag while
/// parked, so a lost wake-up can never strand shutdown for longer than this.
const WORKER_POLL: Duration = Duration::from_millis(25);

/// How often [`SystemAudioSupervisor::wait_for_idle`] re-reads the busy flag.
const IDLE_POLL: Duration = Duration::from_millis(5);

/// Outcome of a supervisor teardown that took longer than the configured
/// deadline allows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SystemAudioSupervisorStatus {
    /// A rebuild did not hand back its attachment within the configured
    /// deadline. The rebuild thread keeps running cooperatively; its result
    /// is still honoured (published or discarded) whenever it eventually
    /// arrives, but no later rebuild is started while it is outstanding.
    AttachTimedOut,
    /// Teardown (stopping the live attachment, or waiting for a cancelled
    /// rebuild thread to finish its own cooperative stop) exceeded the
    /// configured deadline. The straggling thread is abandoned, never
    /// killed, and the supervisor still reports itself as completed.
    TeardownTimedOut,
}

/// Tunables for [`SystemAudioSupervisor::start`].
#[derive(Debug, Clone)]
pub struct SystemAudioSupervisorConfig {
    /// Upper bound applied to both the attach wait and the teardown wait.
    pub deadline: Duration,
}

/// A live system-audio attachment: the rebuild hook's result, paired with
/// the closure that stops it. Cloning shares the same underlying attachment
/// (one logical resource), and each [`SystemAudioAttachment::stop`] call
/// invokes the stop closure — callers that need "at most once" semantics
/// (as `crate::capture` does, via a take-the-handle slot) must make the
/// closure itself idempotent.
pub struct SystemAudioAttachment {
    stop: Arc<Mutex<Box<dyn FnMut() + Send + 'static>>>,
}

impl SystemAudioAttachment {
    /// Wraps `stop`, the closure that tears the attachment down when the
    /// supervisor decides to (replacement, cancellation, or discarding a
    /// late/stale rebuild result). Any return value is discarded — stop is
    /// an effect, not a query.
    pub fn new<R>(mut stop: impl FnMut() -> R + Send + 'static) -> Self {
        Self {
            stop: Arc::new(Mutex::new(Box::new(move || {
                let _ = stop();
            }))),
        }
    }

    /// Invokes the stop closure. A poisoned mutex (a previous stop panicked)
    /// turns this into a no-op rather than propagating across the
    /// supervisor's thread boundary.
    pub fn stop(&self) {
        if let Ok(mut stop) = self.stop.lock() {
            stop();
        }
    }
}

impl Clone for SystemAudioAttachment {
    fn clone(&self) -> Self {
        Self {
            stop: Arc::clone(&self.stop),
        }
    }
}

#[derive(Default)]
struct CancelFlags {
    cancelled: bool,
    /// Set by the worker once its OWN bounded stop of the published
    /// attachment is done (or found unnecessary), releasing the rebuild
    /// thread's guardian phase to perform its cooperative stop. Two-phase
    /// on purpose: the stopper's stop and the guardian's stop must never
    /// race each other into a caller-supplied synchronization point.
    released: bool,
    completed: bool,
}

/// Shared cancellation/completion/replacement state, driven by one condvar so
/// the worker, rebuild threads, and external `SupervisorCancellation`
/// waiters all wake on every transition.
struct CancelState {
    flags: Mutex<CancelFlags>,
    changed: Condvar,
}

impl CancelState {
    fn new() -> Self {
        Self {
            flags: Mutex::new(CancelFlags::default()),
            changed: Condvar::new(),
        }
    }

    fn lock(&self) -> Option<MutexGuard<'_, CancelFlags>> {
        self.flags.lock().ok()
    }

    fn is_cancelled(&self) -> bool {
        self.lock().is_none_or(|flags| flags.cancelled)
    }

    fn cancel(&self) {
        if let Some(mut flags) = self.lock() {
            flags.cancelled = true;
        }
        self.changed.notify_all();
    }

    fn release(&self) {
        if let Some(mut flags) = self.lock() {
            flags.released = true;
        }
        self.changed.notify_all();
    }

    fn complete(&self) {
        if let Some(mut flags) = self.lock() {
            flags.completed = true;
        }
        self.changed.notify_all();
    }

    fn wait_cancelled(&self) {
        let Some(mut flags) = self.lock() else { return };
        while !flags.cancelled {
            flags = match self.changed.wait(flags) {
                Ok(flags) => flags,
                Err(_) => return,
            };
        }
    }

    /// Guardian wait: returns once the rebuild thread should perform its own
    /// cooperative stop of the attachment it built — i.e. after the worker
    /// has finished (or skipped) its own bounded stop phase, or once the
    /// supervisor completed without one.
    fn wait_release(&self) {
        let Some(mut flags) = self.lock() else { return };
        while !(flags.released || flags.completed) {
            flags = match self.changed.wait(flags) {
                Ok(flags) => flags,
                Err(_) => return,
            };
        }
    }

    fn wait_completed(&self, timeout: Duration) -> bool {
        let Some(mut flags) = self.lock() else {
            return false;
        };
        let began = Instant::now();
        while !flags.completed {
            let Some(remaining) = timeout.checked_sub(began.elapsed()) else {
                return false;
            };
            if remaining.is_zero() {
                return flags.completed;
            }
            let (next_flags, wait) = match self.changed.wait_timeout(flags, remaining) {
                Ok(pair) => pair,
                Err(_) => return false,
            };
            flags = next_flags;
            if wait.timed_out() && !flags.completed {
                return false;
            }
        }
        true
    }
}

/// Cooperative cancellation token handed to the rebuild hook and returned by
/// [`SystemAudioSupervisor::cancel`]. Cancellation is a request, not a kill:
/// rebuild threads observe it via [`Self::wait_cancelled`] /
/// [`Self::is_cancelled`] and finish (and stop whatever they built) on their
/// own.
#[derive(Clone)]
pub struct SupervisorCancellation {
    state: Arc<CancelState>,
}

impl SupervisorCancellation {
    /// Whether cancellation has been requested.
    pub fn is_cancelled(&self) -> bool {
        self.state.is_cancelled()
    }

    /// Blocks until cancellation is requested. Rebuild hooks are expected to
    /// poll this (directly or inside their own wait loops) so shutdown stays
    /// cooperative rather than forcible.
    pub fn wait_cancelled(&self) {
        self.state.wait_cancelled();
    }

    /// Waits up to `timeout` for the supervisor to finish its teardown (see
    /// [`SystemAudioSupervisor::cancel`]). Returns whether it completed.
    pub fn wait_for_completion(&self, timeout: Duration) -> bool {
        self.state.wait_completed(timeout)
    }
}

/// The HAL operations the supervisor drives, injected as safe closures so
/// the state machine is testable without Core Audio and so none of them ever
/// runs on the caller's realtime callback thread.
pub struct SystemAudioSupervisorHooks {
    query_hal: Box<dyn Fn() -> bool + Send + Sync>,
    rebuild: Box<dyn Fn(&SupervisorCancellation) -> SystemAudioAttachment + Send + Sync>,
    status: Box<dyn Fn(SystemAudioSupervisorStatus) + Send + Sync>,
}

impl SystemAudioSupervisorHooks {
    /// Bundles the three hooks:
    /// - `query_hal`: a (rate-limited) rendering-state probe, run by the
    ///   supervisor's worker thread whenever
    ///   [`SystemAudioSupervisor::notify_audio_callback`] fires.
    /// - `rebuild`: tears down and recreates the attachment; runs on a
    ///   dedicated rebuild thread and must honour the cancellation token.
    /// - `status`: receives [`SystemAudioSupervisorStatus`] deadline
    ///   reports; called on the worker thread.
    pub fn new<Query, Rebuild, Status>(query_hal: Query, rebuild: Rebuild, status: Status) -> Self
    where
        Query: Fn() -> bool + Send + Sync + 'static,
        Rebuild: Fn(&SupervisorCancellation) -> SystemAudioAttachment + Send + Sync + 'static,
        Status: Fn(SystemAudioSupervisorStatus) + Send + Sync + 'static,
    {
        Self {
            query_hal: Box::new(query_hal),
            rebuild: Box::new(rebuild),
            status: Box::new(status),
        }
    }
}

enum Message {
    Rebuild,
    NotifyCallback,
    Cancelled,
    Attached(usize, SystemAudioAttachment),
    RebuildThreadDone(usize),
}

struct Inner {
    config: SystemAudioSupervisorConfig,
    hooks: SystemAudioSupervisorHooks,
    state: Arc<CancelState>,
    tx: Mutex<Sender<Message>>,
    published: Mutex<Option<SystemAudioAttachment>>,
    busy: AtomicBool,
    generation: AtomicUsize,
}

impl Inner {
    fn send(&self, message: Message) {
        if let Ok(tx) = self.tx.lock() {
            let _ = tx.send(message);
        }
    }
}

#[derive(Default)]
struct WorkerState {
    /// Generation of the rebuild thread whose `RebuildThreadDone` is still
    /// outstanding (covers the running-rebuild phase *and* the guardian
    /// phase that holds the published attachment afterward). While this is
    /// `Some`, further rebuild requests coalesce into it — one rebuild per
    /// supervisor lifetime is the contract (`request_rebuild` is a
    /// stall-recovery request, and recovery is attempted once; a rebuild
    /// that fails is retried only after the supervisor is restarted with a
    /// new session).
    in_flight: Option<usize>,
    attach_deadline: Option<Instant>,
}

impl WorkerState {
    fn recv_timeout(&self) -> Duration {
        let now = Instant::now();
        let mut timeout = WORKER_POLL;
        if let Some(at) = self.attach_deadline {
            timeout = timeout.min(at.saturating_duration_since(now));
        }
        timeout
    }
}

/// Result of [`SystemAudioSupervisor::cancel_and_wait`].
#[derive(Debug, Clone, Copy)]
pub struct SupervisorShutdown {
    completed: bool,
    elapsed: Duration,
}

impl SupervisorShutdown {
    /// Whether the supervisor completed its teardown within `limit`.
    pub fn completed_within(&self, limit: Duration) -> bool {
        self.completed && self.elapsed <= limit
    }

    /// How long the wait actually took.
    pub fn elapsed(&self) -> Duration {
        self.elapsed
    }
}

/// Owns the system-audio attachment lifecycle: one rebuild at a time,
/// deadline-bounded attach and teardown, cooperative cancellation, and
/// monotonic rebuild generations so a stale result is disposed, never
/// installed.
pub struct SystemAudioSupervisor {
    inner: Arc<Inner>,
}

impl SystemAudioSupervisor {
    /// Starts the supervisor's worker thread. Returns immediately; the worker
    /// idles until the first [`Self::request_rebuild`] /
    /// [`Self::notify_audio_callback`].
    pub fn start(config: SystemAudioSupervisorConfig, hooks: SystemAudioSupervisorHooks) -> Self {
        let (tx, rx) = mpsc::channel();
        let inner = Arc::new(Inner {
            config,
            hooks,
            state: Arc::new(CancelState::new()),
            tx: Mutex::new(tx),
            published: Mutex::new(None),
            busy: AtomicBool::new(false),
            generation: AtomicUsize::new(0),
        });
        // Dropping the `JoinHandle` detaches the worker: it unwinds itself
        // out via the cancellation requested in `Drop`/`cancel`, and this
        // type's contract (`start` returns `Self`, not a `Result`) gives no
        // channel to report a spawn failure through — in that (OOM-only)
        // case the supervisor simply never acts on requests.
        let _ = thread::Builder::new()
            .name("myna-system-audio-supervisor".to_string())
            .spawn({
                let weak = Arc::downgrade(&inner);
                move || worker_loop(rx, weak)
            });
        Self { inner }
    }

    /// Non-blocking request for a system-audio rebuild. Concurrent requests
    /// coalesce: while one rebuild is in flight, further requests are
    /// dropped. The busy flag is flipped synchronously here (not when the
    /// worker later picks the message up) so [`Self::wait_for_idle`] can
    /// never report "idle" for a request that was just made but not yet
    /// started. Safe to call from the realtime callback.
    pub fn request_rebuild(&self) {
        if self.inner.busy.swap(true, Ordering::AcqRel) {
            return; // coalesce into the outstanding request
        }
        self.inner.send(Message::Rebuild);
    }

    /// Non-blocking hint that audio callbacks are flowing, prompting the
    /// worker to run the (rate-limited, by the hook's own policy) HAL query
    /// off the callback thread. Safe to call from the realtime callback.
    pub fn notify_audio_callback(&self) {
        self.inner.send(Message::NotifyCallback);
    }

    /// Requests cooperative cancellation and returns the token external
    /// waiters use ([`SupervisorCancellation::wait_for_completion`]). Does
    /// not block on the teardown itself.
    pub fn cancel(&self) -> SupervisorCancellation {
        self.inner.state.cancel();
        self.inner.send(Message::Cancelled);
        SupervisorCancellation {
            state: Arc::clone(&self.inner.state),
        }
    }

    /// Cancels and waits (bounded by the configured deadline plus slack) for
    /// the teardown to complete. Never blocks indefinitely: a straggling
    /// cooperative thread is abandoned with a
    /// [`SystemAudioSupervisorStatus::TeardownTimedOut`] report.
    pub fn cancel_and_wait(&self) -> SupervisorShutdown {
        let began = Instant::now();
        let cancellation = self.cancel();
        let slack = self.inner.config.deadline + WORKER_POLL * 4;
        let completed = cancellation.wait_for_completion(self.inner.config.deadline + slack);
        SupervisorShutdown {
            completed,
            elapsed: began.elapsed(),
        }
    }

    /// Whether no rebuild result is outstanding, waiting up to `timeout`.
    pub fn wait_for_idle(&self, timeout: Duration) -> bool {
        let stop_at = Instant::now() + timeout;
        while self.inner.busy.load(Ordering::Acquire) {
            if Instant::now() >= stop_at {
                return false;
            }
            thread::sleep(IDLE_POLL);
        }
        true
    }

    /// A clone of the currently published attachment, if any. A rebuild
    /// result that arrives after cancellation is stopped and never appears
    /// here.
    pub fn current_attachment(&self) -> Option<SystemAudioAttachment> {
        self.inner
            .published
            .lock()
            .ok()
            .and_then(|published| published.clone())
    }
}

impl Drop for SystemAudioSupervisor {
    fn drop(&mut self) {
        // Best effort: request cancellation so the worker (and any guardian
        // rebuild thread it owns) unwinds cooperatively. Never blocks —
        // callers wanting a bounded join use `cancel_and_wait`.
        self.inner.state.cancel();
        self.inner.send(Message::Cancelled);
    }
}

fn worker_loop(rx: Receiver<Message>, weak: Weak<Inner>) {
    let mut state = WorkerState::default();
    loop {
        let Some(inner) = weak.upgrade() else { return };
        let timeout = state.recv_timeout();
        match rx.recv_timeout(timeout) {
            Ok(message) => match message {
                Message::Rebuild => accept_rebuild(&inner, &mut state),
                Message::NotifyCallback => {
                    if !inner.state.is_cancelled() {
                        (inner.hooks.query_hal)();
                    }
                }
                Message::Attached(gen, attachment) => {
                    accept_attachment(&inner, &mut state, gen, attachment)
                }
                Message::RebuildThreadDone(gen) => {
                    accept_thread_done(&mut state, gen);
                }
                Message::Cancelled => {
                    teardown(&rx, &inner, &mut state);
                    return;
                }
            },
            Err(RecvTimeoutError::Timeout) => {
                expire_deadlines(&inner, &mut state);
                if inner.state.is_cancelled() {
                    teardown(&rx, &inner, &mut state);
                    return;
                }
            }
            Err(RecvTimeoutError::Disconnected) => return,
        }
        if inner.state.is_cancelled() {
            teardown(&rx, &inner, &mut state);
            return;
        }
    }
}

fn accept_rebuild(inner: &Arc<Inner>, state: &mut WorkerState) {
    if inner.state.is_cancelled() {
        inner.busy.store(false, Ordering::Release);
        return;
    }
    if state.in_flight.is_some() {
        // The requesting thread flipped `busy` synchronously; this message
        // raced a previous rebuild's completion, so drop it and hand the
        // idle signal back.
        inner.busy.store(false, Ordering::Release);
        return;
    }
    spawn_rebuild(inner, state);
}

fn spawn_rebuild(inner: &Arc<Inner>, state: &mut WorkerState) {
    let gen = inner.generation.fetch_add(1, Ordering::AcqRel) + 1;
    state.in_flight = Some(gen);
    state.attach_deadline = Some(Instant::now() + inner.config.deadline);
    // `busy` was already flipped by `request_rebuild` itself.
    let inner_for_thread = Arc::clone(inner);
    let spawned = thread::Builder::new()
        .name("myna-system-audio-rebuild".to_string())
        .spawn(move || {
            let cancellation = SupervisorCancellation {
                state: Arc::clone(&inner_for_thread.state),
            };
            let attachment = (inner_for_thread.hooks.rebuild)(&cancellation);
            inner_for_thread.send(Message::Attached(gen, attachment.clone()));
            // Guardian phase: hold the attachment until the worker's
            // teardown has finished (or skipped) its own bounded stop, then
            // perform this thread's cooperative stop. The two stops are
            // deliberately sequenced (never concurrent) so a stop closure
            // synchronized against an external party cannot have its two
            // invocations race each other.
            inner_for_thread.state.wait_release();
            attachment.stop();
            inner_for_thread.send(Message::RebuildThreadDone(gen));
        });
    if spawned.is_err() {
        state.in_flight = None;
        state.attach_deadline = None;
        inner.busy.store(false, Ordering::Release);
    }
}

fn accept_attachment(
    inner: &Arc<Inner>,
    state: &mut WorkerState,
    gen: usize,
    attachment: SystemAudioAttachment,
) {
    state.attach_deadline = None;
    inner.busy.store(false, Ordering::Release);
    let stale = state.in_flight != Some(gen);
    if stale || inner.state.is_cancelled() {
        // Late (superseded) or post-cancellation result: dispose it, never
        // publish it.
        attachment.stop();
        return;
    }
    let previous = match inner.published.lock() {
        Ok(mut published) => {
            let previous = published.take();
            *published = Some(attachment);
            previous
        }
        Err(_) => {
            attachment.stop();
            return;
        }
    };
    if let Some(previous) = previous {
        previous.stop();
    }
}

fn accept_thread_done(state: &mut WorkerState, gen: usize) {
    if state.in_flight != Some(gen) {
        // Stray done from an already-abandoned guardian.
        return;
    }
    state.in_flight = None;
}

fn expire_deadlines(inner: &Arc<Inner>, state: &mut WorkerState) {
    let now = Instant::now();
    if state.attach_deadline.is_some_and(|at| now >= at) {
        state.attach_deadline = None;
        (inner.hooks.status)(SystemAudioSupervisorStatus::AttachTimedOut);
    }
}

fn teardown(rx: &Receiver<Message>, inner: &Arc<Inner>, state: &mut WorkerState) {
    inner.state.cancel();
    let stop_at = Instant::now() + inner.config.deadline;
    let mut timed_out = false;

    // Phase 1: the worker's own bounded stop of the published attachment,
    // performed on a helper thread so a wedged stop closure cannot strand
    // the worker past the deadline.
    let published = inner
        .published
        .lock()
        .ok()
        .and_then(|mut published| published.take());
    if let Some(attachment) = published {
        let (done_tx, done_rx) = mpsc::channel();
        let attachment_for_thread = attachment.clone();
        let spawned = thread::Builder::new()
            .name("myna-system-audio-teardown".to_string())
            .spawn(move || {
                attachment_for_thread.stop();
                let _ = done_tx.send(());
            });
        match spawned {
            Ok(_) => {
                let remaining = stop_at.saturating_duration_since(Instant::now());
                if done_rx.recv_timeout(remaining).is_err() {
                    timed_out = true;
                }
            }
            Err(_) => attachment.stop(),
        }
    }

    // Phase 2: release the guardian rebuild thread (if any) to perform its
    // own cooperative stop, and wait — bounded by the same overall deadline
    // — for it to report done, discarding any late attach result meanwhile.
    inner.state.release();
    if state.in_flight.is_some() && !timed_out {
        loop {
            let remaining = stop_at.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                timed_out = true;
                break;
            }
            match rx.recv_timeout(remaining) {
                Ok(Message::RebuildThreadDone(_)) => break,
                Ok(Message::Attached(_, attachment)) => attachment.stop(),
                Ok(_) => continue,
                Err(RecvTimeoutError::Timeout) => {
                    timed_out = true;
                    break;
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
    }
    state.in_flight = None;
    state.attach_deadline = None;

    if timed_out {
        (inner.hooks.status)(SystemAudioSupervisorStatus::TeardownTimedOut);
    }
    // Completion is reported regardless: cooperative cancellation abandons
    // (never kills) a straggler, and no caller may block on it.
    inner.state.complete();
}
