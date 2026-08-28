//! Ring buffer, drift controller, and sample mixing for combining a
//! microphone stream with a system-audio stream.
//!
//! The microphone is the master clock: `session.rs`'s cpal callback already
//! drives the WAV writer, level meter, and VAD segmenter today. System audio
//! is pushed into a [`SampleRing`] as it arrives and pulled out mic-block by
//! mic-block; [`DriftController`] watches the ring's fill level and nudges
//! the system resampler's ratio (via [`crate::Resampler::set_ratio_relative`])
//! to keep the two streams from drifting apart or apart from each other over
//! time. Wall-clock timestamps between the two sources are deliberately not
//! aligned — fill-level control is the whole strategy.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Capacity of the system-audio ring buffer: 4 seconds of 16 kHz mono audio.
pub const SYSTEM_RING_CAPACITY: usize = 4 * 16_000;

/// Fill level the drift controller steers the ring toward: 250 ms of slack,
/// enough to absorb scheduling jitter between the two capture threads
/// without audibly lagging.
pub const TARGET_FILL_SAMPLES: usize = 4_000;

/// Minimum interval between drift-ratio recalculations.
pub const DRIFT_CHECK_INTERVAL: Duration = Duration::from_secs(1);

/// Proportional gain applied to the normalized fill-level error when
/// computing a drift adjustment.
pub const DRIFT_GAIN: f64 = 0.05;

/// Maximum relative resample-ratio adjustment the drift controller may
/// request in either direction (±0.5%).
pub const MAX_DRIFT_ADJUST: f64 = 0.005;

/// Per-source gain applied to each stream before summing, so a fully
/// in-phase mix of two full-scale sources still fits in `[-1.0, 1.0]`
/// headroom.
pub const MIX_GAIN: f32 = 0.7;

/// How long the system-audio source may go without new samples *at all*
/// before it is considered stalled outright — the cheap, fast trigger.
pub const SYSTEM_STALL_TIMEOUT: Duration = Duration::from_secs(2);

/// How long the tapped process(es) may report silence *while still
/// genuinely rendering output* before that is treated as a stall too.
///
/// Deliberately much longer than [`SYSTEM_STALL_TIMEOUT`]:
/// `kAudioProcessPropertyIsRunningOutput` means "this process holds an
/// active output session" — Teams/Zoom/Slack hold that for an entire call
/// including ordinary silence — not "audio is playing right now". Reusing
/// the 2s timeout for this branch would rebuild a perfectly healthy tap on
/// every few-second pause in conversation.
pub const SYSTEM_RENDERING_SILENCE_TIMEOUT: Duration = Duration::from_secs(30);

/// Minimum interval between `is_any_tapped_process_rendering_output` HAL
/// queries once silence has persisted long enough to consider one — that
/// call is a HAL property round-trip (potentially Mach IPC to
/// `coreaudiod`) and must not run on every mic realtime callback (roughly
/// every 10-20ms) for the duration of a long silence.
pub const RENDERING_QUERY_MIN_INTERVAL: Duration = Duration::from_secs(1);

/// A fixed-capacity ring buffer of f32 samples, safe to push from one thread
/// (the system-audio source) and pop from another (the mic-driven mixer).
pub struct SampleRing {
    capacity: usize,
    target_fill: usize,
    buffer: Mutex<VecDeque<f32>>,
    resyncs: Mutex<u64>,
}

impl SampleRing {
    /// Builds an empty ring holding at most `capacity` samples, resyncing
    /// down to `target_fill` samples on overflow.
    pub fn new(capacity: usize, target_fill: usize) -> Self {
        Self {
            capacity,
            target_fill,
            buffer: Mutex::new(VecDeque::with_capacity(capacity)),
            resyncs: Mutex::new(0),
        }
    }

    /// Appends `samples` to the back of the ring.
    ///
    /// If appending them would overflow `capacity` (`fill > capacity -
    /// samples.len()`), first drops the oldest buffered samples — from the
    /// front, discarding stale audio rather than fresh — down to
    /// `target_fill`, and counts a resync.
    pub fn push(&self, samples: &[f32]) {
        let mut buffer = self.lock_buffer();
        if buffer.len() + samples.len() > self.capacity {
            self.resync_locked(&mut buffer);
        }
        buffer.extend(samples.iter().copied());
    }

    /// Pops exactly `len` samples into a freshly allocated vector.
    ///
    /// Never blocks and never returns fewer than `len` samples: on
    /// underrun, the missing tail is zero-padded.
    pub fn pop_into(&self, len: usize) -> Vec<f32> {
        let mut buffer = self.lock_buffer();
        let available = buffer.len().min(len);
        let mut out: Vec<f32> = buffer.drain(..available).collect();
        out.resize(len, 0.0);
        out
    }

    /// Current number of buffered samples.
    pub fn len(&self) -> usize {
        self.lock_buffer().len()
    }

    /// Whether the ring currently holds no samples.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Drops buffered samples, from the front, down to at most
    /// `target_len` samples, and counts a resync if any were dropped.
    pub fn clear_to(&self, target_len: usize) {
        let mut buffer = self.lock_buffer();
        if buffer.len() > target_len {
            let drop_count = buffer.len() - target_len;
            buffer.drain(..drop_count);
            *self.lock_resyncs() += 1;
        }
    }

    /// Number of overflow/clear resyncs observed so far.
    pub fn resync_count(&self) -> u64 {
        *self.lock_resyncs()
    }

    /// Drops buffered samples down to `self.target_fill` and counts a
    /// resync. Caller already holds `buffer`'s lock.
    fn resync_locked(&self, buffer: &mut VecDeque<f32>) {
        let keep = self.target_fill.min(buffer.len());
        let drop_count = buffer.len() - keep;
        buffer.drain(..drop_count);
        *self.lock_resyncs() += 1;
    }

    fn lock_buffer(&self) -> std::sync::MutexGuard<'_, VecDeque<f32>> {
        self.buffer
            .lock()
            .expect("sample ring mutex is not poisoned")
    }

    fn lock_resyncs(&self) -> std::sync::MutexGuard<'_, u64> {
        self.resyncs
            .lock()
            .expect("sample ring mutex is not poisoned")
    }
}

/// Watches a ring buffer's fill level over time and computes a small
/// resample-ratio adjustment that steers the fill level back toward a
/// target.
///
/// Time is injected via `Instant` parameters rather than read from the
/// system clock, so tests can simulate drift deterministically without
/// sleeping.
pub struct DriftController {
    target_fill: usize,
    last_check: Option<Instant>,
    adjustment: f64,
    frozen: bool,
}

impl DriftController {
    /// Builds a controller that steers toward `target_fill` samples.
    pub fn new(target_fill: usize) -> Self {
        Self {
            target_fill,
            last_check: None,
            adjustment: 0.0,
            frozen: false,
        }
    }

    /// Records a fill-level observation taken at `now`.
    ///
    /// Recomputes [`DriftController::adjustment`] only if this is the first
    /// observation, at least [`DRIFT_CHECK_INTERVAL`] has elapsed since the
    /// last recompute, and the controller is not frozen.
    pub fn observe(&mut self, fill: usize, now: Instant) {
        if self.frozen {
            return;
        }
        let due = match self.last_check {
            None => true,
            Some(last) => now.duration_since(last) >= DRIFT_CHECK_INTERVAL,
        };
        if !due {
            return;
        }

        let error = fill as f64 - self.target_fill as f64;
        let raw_adjustment = -DRIFT_GAIN * error / self.target_fill as f64;
        self.adjustment = raw_adjustment.clamp(-MAX_DRIFT_ADJUST, MAX_DRIFT_ADJUST);
        self.last_check = Some(now);
    }

    /// The most recently computed relative resample-ratio adjustment (e.g.
    /// `0.001` means "resample 0.1% faster"). `0.0` until the first
    /// [`DriftController::observe`] call.
    pub fn adjustment(&self) -> f64 {
        self.adjustment
    }

    /// Freezes the controller: [`DriftController::observe`] becomes a
    /// no-op until [`DriftController::unfreeze`] is called.
    ///
    /// Call this while the system source has stalled
    /// ([`SYSTEM_STALL_TIMEOUT`] elapsed with no new samples) — continuing
    /// to feed a draining fill level in that state would drive the
    /// adjustment to its rail for no useful reason.
    pub fn freeze(&mut self) {
        self.frozen = true;
    }

    /// Resumes normal operation after [`DriftController::freeze`].
    pub fn unfreeze(&mut self) {
        self.frozen = false;
    }

    /// Whether the controller is currently frozen.
    pub fn is_frozen(&self) -> bool {
        self.frozen
    }
}

/// Mixes `mic` and `sys` sample-for-sample into `out`, applying [`MIX_GAIN`]
/// to each source and clamping the sum to the valid audio range
/// `[-1.0, 1.0]`. No compressor or limiter beyond that clamp.
///
/// Processes `min(mic.len(), sys.len(), out.len())` samples.
pub fn mix_into(mic: &[f32], sys: &[f32], out: &mut [f32]) {
    for ((&mic_sample, &sys_sample), out_sample) in mic.iter().zip(sys.iter()).zip(out.iter_mut()) {
        *out_sample = (mic_sample * MIX_GAIN + sys_sample * MIX_GAIN).clamp(-1.0, 1.0);
    }
}
