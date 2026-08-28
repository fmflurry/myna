//! The process tap itself: description -> tap -> aggregate device -> IOProc,
//! and the RAII teardown that reverses every step.

use std::ptr::NonNull;
use std::sync::Mutex;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::AnyThread;
use objc2_core_audio::{
    kAudioDevicePropertyStreamFormat, kAudioObjectPropertyScopeInput,
    AudioDeviceCreateIOProcIDWithBlock, AudioDeviceDestroyIOProcID, AudioDeviceIOBlock,
    AudioDeviceIOProcID, AudioDeviceStart, AudioDeviceStop, AudioHardwareCreateAggregateDevice,
    AudioHardwareCreateProcessTap, AudioHardwareDestroyAggregateDevice,
    AudioHardwareDestroyProcessTap, AudioObjectID, CATapDescription,
};
use objc2_core_audio_types::{AudioBufferList, AudioStreamBasicDescription, AudioTimeStamp};
use objc2_foundation::{NSArray, NSNumber, NSString};

use crate::aggregate::build_aggregate_description;
use crate::process::get_property_raw;

/// Human-readable name given to every tap this crate creates. Cosmetic only.
const TAP_NAME: &str = "Myna Process Tap";

/// Which processes a [`ProcessTapCapture`] taps.
#[derive(Debug, Clone, Copy)]
pub enum TapScope<'a> {
    /// Mono mixdown of exactly these processes' output.
    Processes(&'a [AudioObjectID]),
    /// Mono mixdown of every process's output *except* these — a global
    /// tap. An empty exclude list taps literally everything, including the
    /// calling process itself.
    GlobalExcluding(&'a [AudioObjectID]),
}

/// Sample format a [`ProcessTapCapture`] actually delivers, discovered from
/// the tap's aggregate device once it exists — never assumed ahead of time.
/// See this crate's module docs for why a tap's rate can't be predicted.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CapturedFormat {
    pub sample_rate_hz: f64,
    pub channels: u16,
}

/// Failures constructing or running a process tap. Every variant that wraps
/// a Core Audio call carries the raw `OSStatus` it returned, for diagnostics.
#[derive(Debug, thiserror::Error)]
pub enum TapError {
    #[error("AudioHardwareCreateProcessTap failed (OSStatus {0})")]
    TapCreationFailed(i32),
    #[error("AudioHardwareCreateAggregateDevice failed (OSStatus {0})")]
    AggregateCreationFailed(i32),
    #[error("the tap's aggregate device reported no usable stream format")]
    FormatUnavailable,
    #[error("AudioDeviceCreateIOProcIDWithBlock failed (OSStatus {0})")]
    IoProcCreationFailed(i32),
    #[error("AudioDeviceStart failed (OSStatus {0})")]
    DeviceStartFailed(i32),
}

/// A running Core Audio process tap, wrapped in a private aggregate device
/// with an IOProc delivering mono f32 PCM to the callback given to
/// [`ProcessTapCapture::start`].
///
/// [`Drop`] tears down every resource in the reverse order it was created —
/// stop IOProc, destroy IOProc, destroy aggregate, destroy tap — so an early
/// return (including a panic unwind partway through building one) never
/// leaks a tap or aggregate device: both are system-wide HAL resources that
/// outlive this process if leaked, not merely per-process memory.
pub struct ProcessTapCapture {
    aggregate_id: AudioObjectID,
    tap_id: AudioObjectID,
    io_proc_id: AudioDeviceIOProcID,
}

impl ProcessTapCapture {
    /// Starts tapping `scope` (process object ids from
    /// [`crate::AudioProcess::list`] / [`crate::translate_pid`]), mixed down
    /// to mono.
    ///
    /// `on_pcm` is called with each captured block of mono f32 samples, from
    /// Core Audio's realtime IO thread — it must not block. A panic inside
    /// `on_pcm` is caught at the IOProc boundary (see [`create_io_proc`])
    /// and degrades to losing that IO cycle's buffer rather than unwinding
    /// into Core Audio, but callers still should not rely on that as normal
    /// control flow.
    ///
    /// Returns once the tap is live, together with the [`CapturedFormat`]
    /// actually reported by its aggregate device: that read happens after
    /// the tap and aggregate exist but *before* the IOProc is created or
    /// started, so the format is always known before any audio can have
    /// been delivered — there is no race between learning the rate and the
    /// first callback.
    pub fn start(
        scope: TapScope<'_>,
        on_pcm: impl FnMut(&[f32]) + Send + 'static,
    ) -> Result<(Self, CapturedFormat), TapError> {
        let tap_description = build_tap_description(scope);
        let tap_id = create_process_tap(&tap_description)?;

        let tap_uid = unsafe { tap_description.UUID() }.to_string();
        let aggregate_uid = format!("dev.myna.coreaudiotap.aggregate.{}", std::process::id());
        let aggregate_description = build_aggregate_description(&aggregate_uid, &tap_uid);
        let aggregate_id = create_aggregate_device(&aggregate_description).inspect_err(|_| {
            destroy_tap(tap_id);
        })?;

        let Some(format) = read_stream_format(aggregate_id) else {
            destroy_aggregate_and_tap(aggregate_id, tap_id);
            return Err(TapError::FormatUnavailable);
        };

        let io_proc_id = match create_io_proc(aggregate_id, on_pcm) {
            Ok(id) => id,
            Err(err) => {
                destroy_aggregate_and_tap(aggregate_id, tap_id);
                return Err(err);
            }
        };

        // Safety: `aggregate_id` and `io_proc_id` are the just-created,
        // still-live device and IOProc from this same call.
        let start_status = unsafe { AudioDeviceStart(aggregate_id, io_proc_id) };
        if start_status != 0 {
            // Safety: `io_proc_id` was created on `aggregate_id` above and
            // has not yet been started, matching `AudioDeviceDestroyIOProcID`'s
            // precondition.
            unsafe { AudioDeviceDestroyIOProcID(aggregate_id, io_proc_id) };
            destroy_aggregate_and_tap(aggregate_id, tap_id);
            return Err(TapError::DeviceStartFailed(start_status));
        }

        Ok((
            Self {
                aggregate_id,
                tap_id,
                io_proc_id,
            },
            format,
        ))
    }

    /// Stops and tears down the tap. Equivalent to dropping `self` — spelled
    /// out separately so a caller can make the teardown point explicit
    /// rather than relying on end-of-scope.
    pub fn stop(self) {
        drop(self);
    }
}

impl Drop for ProcessTapCapture {
    fn drop(&mut self) {
        // Safety: reverses construction order exactly. Each id was created
        // by a prior successful call in `start` and has not been destroyed
        // yet — `Drop` runs at most once per instance.
        unsafe {
            AudioDeviceStop(self.aggregate_id, self.io_proc_id);
            AudioDeviceDestroyIOProcID(self.aggregate_id, self.io_proc_id);
        }
        destroy_aggregate_and_tap(self.aggregate_id, self.tap_id);
    }
}

fn destroy_aggregate_and_tap(aggregate_id: AudioObjectID, tap_id: AudioObjectID) {
    // Safety: both ids were created earlier in the same `start` call and are
    // destroyed here at most once, in reverse creation order.
    unsafe {
        AudioHardwareDestroyAggregateDevice(aggregate_id);
    }
    destroy_tap(tap_id);
}

fn destroy_tap(tap_id: AudioObjectID) {
    // Safety: `tap_id` was created earlier in the same `start` call.
    unsafe {
        AudioHardwareDestroyProcessTap(tap_id);
    }
}

/// Builds a mono mixdown tap description for `scope`.
fn build_tap_description(scope: TapScope<'_>) -> Retained<CATapDescription> {
    let (ids, is_global_exclude) = match scope {
        TapScope::Processes(ids) => (ids, false),
        TapScope::GlobalExcluding(ids) => (ids, true),
    };
    let numbers: Vec<Retained<NSNumber>> = ids.iter().map(|&id| NSNumber::new_u32(id)).collect();
    let refs: Vec<&NSNumber> = numbers.iter().map(AsRef::as_ref).collect();
    let process_list: Retained<NSArray<NSNumber>> = NSArray::from_slice(&refs);

    let description: Retained<CATapDescription> = if is_global_exclude {
        // Safety: `CATapDescription::alloc()` yields a fresh, uninitialized
        // instance consumed exactly once by this `init*` call, per objc2's
        // `init` contract.
        unsafe {
            CATapDescription::initMonoGlobalTapButExcludeProcesses(
                CATapDescription::alloc(),
                &process_list,
            )
        }
    } else {
        // Safety: same as above.
        unsafe {
            CATapDescription::initMonoMixdownOfProcesses(CATapDescription::alloc(), &process_list)
        }
    };

    // Safety: `description` is a live, uniquely-owned `CATapDescription`.
    unsafe {
        description.setName(&NSString::from_str(TAP_NAME));
        description.setMono(true);
        description.setMixdown(true);
        description.setPrivate(true);
    }
    description
}

fn create_process_tap(description: &CATapDescription) -> Result<AudioObjectID, TapError> {
    let mut tap_id: AudioObjectID = 0;
    // Safety: `tap_id` is a valid, uniquely-owned local out-param.
    let status = unsafe {
        AudioHardwareCreateProcessTap(Some(description), NonNull::from(&mut tap_id).as_ptr())
    };
    if status != 0 {
        return Err(TapError::TapCreationFailed(status));
    }
    Ok(tap_id)
}

/// Return type of [`build_aggregate_description`][crate::aggregate::build_aggregate_description],
/// named to keep [`create_aggregate_device`]'s signature readable.
type AggregateDescription = objc2_core_foundation::CFRetained<
    objc2_core_foundation::CFDictionary<
        objc2_core_foundation::CFString,
        objc2_core_foundation::CFType,
    >,
>;

fn create_aggregate_device(description: &AggregateDescription) -> Result<AudioObjectID, TapError> {
    let mut aggregate_id: AudioObjectID = 0;
    // Safety: `aggregate_id` is a valid, uniquely-owned local out-param.
    let status = unsafe {
        AudioHardwareCreateAggregateDevice(
            description.as_ref(),
            NonNull::new(&mut aggregate_id as *mut AudioObjectID)
                .expect("stack pointer is never null"),
        )
    };
    if status != 0 {
        return Err(TapError::AggregateCreationFailed(status));
    }
    Ok(aggregate_id)
}

/// Reads the aggregate device's actual stream format. Must use the `Input`
/// scope: the `Global` scope reports nothing for a tap's aggregate device
/// (verified against real hardware — see this crate's design notes).
fn read_stream_format(aggregate_id: AudioObjectID) -> Option<CapturedFormat> {
    let bytes = get_property_raw(
        aggregate_id,
        kAudioDevicePropertyStreamFormat,
        kAudioObjectPropertyScopeInput,
        None,
    )?;
    if bytes.len() < std::mem::size_of::<AudioStreamBasicDescription>() {
        return None;
    }
    // Safety: `bytes` was just checked to be at least as large as an
    // `AudioStreamBasicDescription`, and the HAL fills it with exactly that
    // struct's bytes for this property.
    let asbd: AudioStreamBasicDescription =
        unsafe { std::ptr::read_unaligned(bytes.as_ptr().cast::<AudioStreamBasicDescription>()) };
    Some(CapturedFormat {
        sample_rate_hz: asbd.mSampleRate,
        channels: asbd.mChannelsPerFrame as u16,
    })
}

/// Boxed PCM sink, named to keep [`create_io_proc`] from tripping
/// `clippy::type_complexity`.
type PcmSink = Box<dyn FnMut(&[f32]) + Send>;

/// Mutable per-IOProc state: the caller's sink, and a scratch buffer reused
/// across every callback so [`fill_mono_samples`] never allocates on Core
/// Audio's realtime IO thread (see that function's doc comment).
///
/// Both fields are guarded by a single `Mutex` rather than two — they are
/// always accessed together, and a second lock would only add overhead
/// without adding safety. Core Audio invokes a single aggregate device's
/// IOProc *serially* (never concurrently from two threads at once), so this
/// lock is never contended in practice: it exists purely to give the `Fn`
/// block (see [`IoBlockFn`]) interior mutability, not to arbitrate real
/// concurrent access. A future change that shares a `PcmSink`/scratch
/// buffer across more than one IOProc would need to revisit that
/// assumption.
struct IoProcState {
    scratch: Vec<f32>,
    sink: PcmSink,
}

/// Signature of the block Core Audio invokes per IO cycle, named to keep
/// [`create_io_proc`] from tripping `clippy::type_complexity`.
type IoBlockFn = dyn Fn(
    NonNull<AudioTimeStamp>,
    NonNull<AudioBufferList>,
    NonNull<AudioTimeStamp>,
    NonNull<AudioBufferList>,
    NonNull<AudioTimeStamp>,
);

/// Initial capacity reserved for [`IoProcState::scratch`] so the first few
/// real callbacks are less likely to trigger a growth reallocation before
/// the buffer settles at its steady-state size. Not a hard limit —
/// [`fill_mono_samples`] grows it via `extend_from_slice` like any `Vec` if
/// a callback ever delivers more samples than this.
const IO_PROC_SCRATCH_CAPACITY_HINT: usize = 4096;

fn create_io_proc(
    aggregate_id: AudioObjectID,
    on_pcm: impl FnMut(&[f32]) + Send + 'static,
) -> Result<AudioDeviceIOProcID, TapError> {
    let state: Mutex<IoProcState> = Mutex::new(IoProcState {
        scratch: Vec::with_capacity(IO_PROC_SCRATCH_CAPACITY_HINT),
        sink: Box::new(on_pcm),
    });

    // Safety/RT-note: this block runs directly on Core Audio's hard-realtime
    // IO thread — `in_dispatch_queue: None` below means there is no dispatch
    // queue cushioning it from Core Audio's own callout. Two failure modes
    // are specifically guarded against here:
    //   1. Heap allocation: `fill_mono_samples` writes into `state.scratch`,
    //      a buffer reused every call (`.clear()`, never a fresh `Vec`), so
    //      steady-state operation performs no allocation on this thread.
    //   2. Unwinding into Core Audio: `state.sink` chains into caller code
    //      that may legitimately panic (e.g. `resample.rs`'s `.expect()`s).
    //      This block is called through an `extern "C-unwind"` boundary
    //      from Core Audio's own C/Objective-C frames, so an escaping panic
    //      would be undefined behavior there. `catch_unwind` below ensures
    //      a panic degrades to "this IO cycle's buffer is dropped", exactly
    //      like the existing silent-skip-on-lock-contention path, rather
    //      than ever unwinding across that boundary.
    let io_block: RcBlock<IoBlockFn> = RcBlock::new(
        move |_now: NonNull<AudioTimeStamp>,
              input_data: NonNull<AudioBufferList>,
              _input_time: NonNull<AudioTimeStamp>,
              _output_data: NonNull<AudioBufferList>,
              _output_time: NonNull<AudioTimeStamp>| {
            // Safety: Core Audio guarantees `input_data` is valid for the
            // duration of this callback.
            let list = unsafe { input_data.as_ref() };

            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                if let Ok(mut state) = state.lock() {
                    let IoProcState { scratch, sink } = &mut *state;
                    if fill_mono_samples(list, scratch) {
                        (sink)(scratch);
                    }
                }
            }));
            if let Err(panic) = result {
                log_io_proc_panic(&panic);
            }
        },
    );
    let io_block_ptr: AudioDeviceIOBlock = RcBlock::as_ptr(&io_block);

    let mut io_proc_id: AudioDeviceIOProcID = None;
    // Safety: `io_proc_id` is a valid, uniquely-owned local out-param;
    // `io_block_ptr` is a live block that Core Audio retains internally for
    // the IOProc's lifetime (per `AudioDeviceCreateIOProcIDWithBlock`'s own
    // documented contract), so it outliving this function is by design.
    let status = unsafe {
        AudioDeviceCreateIOProcIDWithBlock(
            NonNull::from(&mut io_proc_id),
            aggregate_id,
            None,
            io_block_ptr,
        )
    };
    if status != 0 {
        return Err(TapError::IoProcCreationFailed(status));
    }
    Ok(io_proc_id)
}

/// Sums an `AudioBufferList`'s buffers down to mono f32 samples, written
/// into `out`.
///
/// The tap is always configured as a mono mixdown, so this normally sees
/// exactly one buffer; summing (and averaging when there is more than one)
/// keeps this correct even if Core Audio ever delivers more.
///
/// # Realtime safety
///
/// This runs on Core Audio's hard-realtime IO thread (see
/// [`create_io_proc`]'s doc comment) and **must never allocate**. `out` is
/// [`IoProcState::scratch`] — cleared and refilled in place every call —
/// never a freshly allocated `Vec`. Allocating here reintroduces the exact
/// bug class that once cost this project ~97% of captured microphone audio
/// (see `session.rs`'s module docs): a slow `malloc` under allocator
/// contention can stall or drop an entire IO cycle. Do not change `out`
/// back to an owned return value.
///
/// Returns whether `out` ends up non-empty (`false` when every buffer was
/// null or zero-length).
fn fill_mono_samples(list: &AudioBufferList, out: &mut Vec<f32>) -> bool {
    out.clear();

    let count = list.mNumberBuffers as usize;
    if count == 0 {
        return false;
    }

    let buffers_ptr = list.mBuffers.as_ptr();
    for i in 0..count {
        // Safety: `i < count == list.mNumberBuffers`, and Core Audio
        // guarantees `mBuffers` has that many valid entries.
        let buffer = unsafe { &*buffers_ptr.add(i) };
        if buffer.mData.is_null() || buffer.mDataByteSize == 0 {
            continue;
        }
        let sample_count = buffer.mDataByteSize as usize / std::mem::size_of::<f32>();
        // Safety: `buffer.mData` is non-null with `mDataByteSize` valid
        // bytes, per Core Audio's contract for a delivered `AudioBufferList`.
        let samples =
            unsafe { std::slice::from_raw_parts(buffer.mData.cast::<f32>(), sample_count) };
        if out.is_empty() {
            out.extend_from_slice(samples);
        } else {
            for (sum, &sample) in out.iter_mut().zip(samples.iter()) {
                *sum += sample;
            }
        }
    }

    if count > 1 {
        let count_f = count as f32;
        for sample in out.iter_mut() {
            *sample /= count_f;
        }
    }
    !out.is_empty()
}

/// Logs an IOProc panic caught by [`create_io_proc`]'s `catch_unwind`,
/// naming this as the deliberate recovery path rather than a silent drop:
/// the panic is contained (never unwinds into Core Audio's own frames) and
/// this IO cycle's buffer is simply lost, mirroring the existing
/// silent-skip-on-lock-contention behavior elsewhere in this module.
fn log_io_proc_panic(panic: &(dyn std::any::Any + Send)) {
    let message = panic
        .downcast_ref::<&str>()
        .map(|message| (*message).to_string())
        .or_else(|| panic.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "non-string panic payload".to_string());
    eprintln!(
        "myna-coreaudio-tap: IOProc callback panicked ({message}); dropping this IO \
         cycle's buffer instead of unwinding into Core Audio"
    );
}
