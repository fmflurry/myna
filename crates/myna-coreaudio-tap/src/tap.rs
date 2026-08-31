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

/// One block of audio delivered per IOProc callback: the mono reduction
/// every caller has always received, alongside genuine native-rate
/// interleaved stereo.
///
/// `stereo` is parsed directly from the raw `AudioBufferList` by
/// [`fill_stereo_interleaved`] — the single layout-aware parser in this
/// crate. `mono` is derived from `stereo`'s already-parsed output by
/// [`downmix_stereo_to_mono`] rather than re-parsing the buffer list a
/// second, independent way: two divergent parsers is exactly how this crate
/// once shipped a bug where a single interleaved stereo buffer was misread
/// as raw mono samples (doubling the apparent sample count and destroying
/// the waveform, silently). Averaging L/R after the fact reproduces the
/// same mono samples a genuine mono source always produced, since Core
/// Audio duplicates mono sources to both stereo channels (see
/// [`build_tap_description`]): `(L + R) / 2 == L == R`.
pub struct TapBlock<'a> {
    pub mono: &'a [f32],
    pub stereo: &'a [f32],
}

/// A running Core Audio process tap, wrapped in a private aggregate device
/// with an IOProc delivering a [`TapBlock`] to the callback given to
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
    /// to stereo (mono sources are duplicated to both channels by Core
    /// Audio itself — see [`build_tap_description`]).
    ///
    /// `on_pcm` is called with each captured [`TapBlock`], from Core
    /// Audio's realtime IO thread — it must not block. A panic inside
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
        on_pcm: impl FnMut(&TapBlock<'_>) + Send + 'static,
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

/// Builds a **stereo** mixdown tap description for `scope`.
///
/// Was a mono mixdown before this crate needed to deliver genuine
/// native-rate stereo (see [`TapBlock`]): Core Audio rejects standing up a
/// second, concurrent tap in the same process
/// (`kAudioHardwareIllegalOperationError` — see this crate's design notes),
/// so a separate mono-only tap alongside a new stereo one isn't an option.
/// [`downmix_stereo_to_mono`] instead derives the mono reduction from this
/// stereo tap's already-parsed interleaved output — see [`TapBlock`]'s doc
/// comment for why.
///
/// `CATapDescription`'s own stereo-mixdown docs: "Mono sources will be
/// duplicated in both right and left channels" — so a tap on a mono-output
/// process still yields valid, if centered, stereo.
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
            CATapDescription::initStereoGlobalTapButExcludeProcesses(
                CATapDescription::alloc(),
                &process_list,
            )
        }
    } else {
        // Safety: same as above.
        unsafe {
            CATapDescription::initStereoMixdownOfProcesses(CATapDescription::alloc(), &process_list)
        }
    };

    // Safety: `description` is a live, uniquely-owned `CATapDescription`.
    unsafe {
        description.setName(&NSString::from_str(TAP_NAME));
        description.setMono(false);
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
type PcmSink = Box<dyn FnMut(&TapBlock<'_>) + Send>;

/// Mutable per-IOProc state: the caller's sink, and the two scratch buffers
/// reused across every callback so neither [`fill_stereo_interleaved`] nor
/// [`downmix_stereo_to_mono`] ever allocates on Core Audio's realtime IO
/// thread (see their doc comments).
///
/// Both scratch buffers and the sink are guarded by a single `Mutex` rather
/// than separate locks — they are always accessed together, and more locks
/// would only add overhead without adding safety. Core Audio invokes a
/// single aggregate device's IOProc *serially* (never concurrently from two
/// threads at once), so this lock is never contended in practice: it exists
/// purely to give the `Fn` block (see [`IoBlockFn`]) interior mutability,
/// not to arbitrate real concurrent access. A future change that shares a
/// `PcmSink`/scratch buffer across more than one IOProc would need to
/// revisit that assumption.
struct IoProcState {
    mono_scratch: Vec<f32>,
    stereo_scratch: Vec<f32>,
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

/// Initial capacity reserved for [`IoProcState::mono_scratch`] so the first
/// few real callbacks are less likely to trigger a growth reallocation
/// before the buffer settles at its steady-state size. Not a hard limit —
/// [`downmix_stereo_to_mono`] grows it like any `Vec` if a callback ever
/// delivers more samples than this.
const IO_PROC_SCRATCH_CAPACITY_HINT: usize = 4096;

/// Initial capacity reserved for [`IoProcState::stereo_scratch`] — double
/// [`IO_PROC_SCRATCH_CAPACITY_HINT`] since interleaved stereo carries two
/// samples per frame. Same not-a-hard-limit caveat as the mono hint.
const IO_PROC_STEREO_SCRATCH_CAPACITY_HINT: usize = IO_PROC_SCRATCH_CAPACITY_HINT * 2;

fn create_io_proc(
    aggregate_id: AudioObjectID,
    on_pcm: impl FnMut(&TapBlock<'_>) + Send + 'static,
) -> Result<AudioDeviceIOProcID, TapError> {
    let state: Mutex<IoProcState> = Mutex::new(IoProcState {
        mono_scratch: Vec::with_capacity(IO_PROC_SCRATCH_CAPACITY_HINT),
        stereo_scratch: Vec::with_capacity(IO_PROC_STEREO_SCRATCH_CAPACITY_HINT),
        sink: Box::new(on_pcm),
    });

    // Safety/RT-note: this block runs directly on Core Audio's hard-realtime
    // IO thread — `in_dispatch_queue: None` below means there is no dispatch
    // queue cushioning it from Core Audio's own callout. Two failure modes
    // are specifically guarded against here:
    //   1. Heap allocation: `fill_stereo_interleaved` and
    //      `downmix_stereo_to_mono` write into `state.stereo_scratch` /
    //      `state.mono_scratch`, buffers reused every call (`.clear()`,
    //      never a fresh `Vec`), so steady-state operation performs no
    //      allocation on this thread.
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
                    let IoProcState {
                        mono_scratch,
                        stereo_scratch,
                        sink,
                    } = &mut *state;
                    // `stereo_scratch` is parsed straight from `list`;
                    // `mono_scratch` is derived from that parsed output
                    // rather than re-parsing `list` a second, divergent way
                    // — see `TapBlock`'s doc comment.
                    fill_stereo_interleaved(list, stereo_scratch);
                    let mono_ok = downmix_stereo_to_mono(stereo_scratch, mono_scratch);
                    if mono_ok {
                        (sink)(&TapBlock {
                            mono: mono_scratch,
                            stereo: stereo_scratch,
                        });
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

/// Extracts genuine interleaved L/R stereo samples from an
/// `AudioBufferList`, written into `out`. This is the single layout-aware
/// parser in this crate — [`downmix_stereo_to_mono`] derives
/// [`TapBlock::mono`] from this function's output rather than re-parsing
/// `list` a second, independent way (see [`TapBlock`]'s doc comment for
/// why: two divergent parsers is how this crate once shipped a bug that
/// misread an interleaved stereo buffer as raw mono samples).
///
/// Handles every buffer layout Core Audio might hand a stereo mixdown tap:
/// - One buffer with exactly two channels: already interleaved L,R,L,R,...
///   — copied through unchanged.
/// - Two (or more) single-channel buffers: treated as planar L, R (Core
///   Audio's own buffer-ordering convention) and interleaved sample by
///   sample, truncated to the shorter of the two if they ever differ.
/// - One single-channel buffer (unexpectedly mono despite a stereo tap):
///   duplicated to both channels, matching how Core Audio itself documents
///   duplicating a mono source across a stereo mixdown.
/// - Anything else (e.g. a single buffer reporting more than two channels,
///   or multiple multi-channel buffers): there is no stride this crate can
///   safely assume, so `out` is left empty rather than guessing a stride-2
///   framing that would silently scramble the samples. Degrading honestly
///   beats corrupting silently.
/// - Zero buffers, or every buffer null/empty: `out` ends up empty.
///
/// # Realtime safety
///
/// Runs on Core Audio's hard-realtime IO thread (see [`create_io_proc`]'s
/// doc comment). `out` is [`IoProcState::stereo_scratch`] — cleared and
/// refilled in place every call, never a freshly allocated `Vec`, so
/// steady-state operation performs no allocation. Not a hard guarantee on
/// *every* call, though: `out.reserve` below can still trigger a growth
/// allocation on an early callback before the buffer reaches its
/// steady-state peak size — the same "not a hard limit" caveat documented
/// on [`IO_PROC_STEREO_SCRATCH_CAPACITY_HINT`].
fn fill_stereo_interleaved(list: &AudioBufferList, out: &mut Vec<f32>) {
    out.clear();

    let count = list.mNumberBuffers as usize;
    if count == 0 {
        return;
    }
    let buffers_ptr = list.mBuffers.as_ptr();

    // Safety: `0 < count == list.mNumberBuffers`, and Core Audio guarantees
    // `mBuffers` has that many valid entries.
    let first = unsafe { &*buffers_ptr };
    if first.mData.is_null() || first.mDataByteSize == 0 {
        return;
    }
    let first_samples = unsafe {
        std::slice::from_raw_parts(
            first.mData.cast::<f32>(),
            first.mDataByteSize as usize / std::mem::size_of::<f32>(),
        )
    };

    if count >= 2 && first.mNumberChannels <= 1 {
        // Planar: buffer 0 is L, buffer 1 is R.
        // Safety: `1 < count == list.mNumberBuffers`.
        let second = unsafe { &*buffers_ptr.add(1) };
        if second.mData.is_null() || second.mDataByteSize == 0 {
            return;
        }
        let second_samples = unsafe {
            std::slice::from_raw_parts(
                second.mData.cast::<f32>(),
                second.mDataByteSize as usize / std::mem::size_of::<f32>(),
            )
        };
        let frames = first_samples.len().min(second_samples.len());
        out.reserve(frames * 2);
        for i in 0..frames {
            out.push(first_samples[i]);
            out.push(second_samples[i]);
        }
    } else if first.mNumberChannels == 2 {
        // Already interleaved.
        out.extend_from_slice(first_samples);
    } else if first.mNumberChannels <= 1 {
        // Unexpectedly mono despite a stereo tap: duplicate to both
        // channels, matching Core Audio's own documented behavior for a
        // mono source fed into a stereo mixdown.
        out.reserve(first_samples.len() * 2);
        for &sample in first_samples {
            out.push(sample);
            out.push(sample);
        }
    }
    // else: a single buffer reporting more than two channels (or some other
    // layout this crate doesn't recognize). No defined stride — leave `out`
    // empty rather than guess. See this function's doc comment.
}

/// Derives [`TapBlock::mono`] from `stereo`'s interleaved L/R pairs, written
/// into `out`. Deliberately arithmetic-only, not a second `AudioBufferList`
/// parser — see [`fill_stereo_interleaved`]'s doc comment and [`TapBlock`]'s
/// doc comment for why two independent parsers is the bug class this
/// replaces.
///
/// For a genuine mono source, Core Audio duplicates it to both stereo
/// channels (see [`build_tap_description`]), so `(L + R) / 2 == L == R` —
/// this reproduces exactly the samples a mono-only tap would have
/// delivered.
///
/// Returns whether `out` ends up non-empty (`false` when `stereo` has fewer
/// than one full L/R pair).
///
/// # Realtime safety
///
/// Runs on Core Audio's hard-realtime IO thread (see [`create_io_proc`]'s
/// doc comment). `out` is [`IoProcState::mono_scratch`] — cleared and
/// refilled in place every call, never a freshly allocated `Vec` — with the
/// same early-callback "not a hard limit" caveat as
/// [`IO_PROC_SCRATCH_CAPACITY_HINT`]. Allocating here reintroduces the exact
/// bug class that once cost this project ~97% of captured microphone audio
/// (see `session.rs`'s module docs): a slow `malloc` under allocator
/// contention can stall or drop an entire IO cycle.
fn downmix_stereo_to_mono(stereo: &[f32], out: &mut Vec<f32>) -> bool {
    out.clear();
    let (pairs, _remainder) = stereo.as_chunks::<2>();
    out.reserve(pairs.len());
    for &[l, r] in pairs {
        out.push((l + r) * 0.5);
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

#[cfg(test)]
mod tests {
    use super::*;
    use objc2_core_audio_types::AudioBuffer;

    /// A fixed-`N`-buffer stand-in for `AudioBufferList`'s variable-length
    /// `mBuffers` array, so tests can synthesize buffer lists of any count
    /// without touching a live Core Audio object.
    ///
    /// `#[repr(C)]` with the same leading field types as `AudioBufferList`
    /// (`u32` then an array of `AudioBuffer`) gives this struct the same
    /// layout for `mNumberBuffers` and the start of `mBuffers` regardless of
    /// `N` — the compiler inserts the same alignment padding either way,
    /// since that padding only depends on the *types* involved, not the
    /// trailing array's length. This mirrors how Core Audio itself hands a
    /// variable-length `AudioBufferList` to callers through a fixed
    /// `&AudioBufferList` reference; production code (`fill_stereo_interleaved`)
    /// already walks past the nominal single-element array via raw pointer
    /// arithmetic rather than indexing it directly.
    #[repr(C)]
    #[allow(non_snake_case)]
    struct RawBufferList<const N: usize> {
        mNumberBuffers: u32,
        mBuffers: [AudioBuffer; N],
    }

    fn as_list<const N: usize>(raw: &RawBufferList<N>) -> &AudioBufferList {
        // Safety: `RawBufferList<N>` has an identical `#[repr(C)]` layout to
        // `AudioBufferList` for the fields the code under test reads
        // (`mNumberBuffers`, and `mBuffers` via pointer arithmetic bounded
        // by `mNumberBuffers`) — see this type's doc comment.
        unsafe { &*(raw as *const RawBufferList<N> as *const AudioBufferList) }
    }

    fn buffer(channels: u32, samples: &mut [f32]) -> AudioBuffer {
        AudioBuffer {
            mNumberChannels: channels,
            mDataByteSize: std::mem::size_of_val(samples) as u32,
            mData: samples.as_mut_ptr().cast(),
        }
    }

    fn null_buffer() -> AudioBuffer {
        AudioBuffer {
            mNumberChannels: 0,
            mDataByteSize: 0,
            mData: std::ptr::null_mut(),
        }
    }

    /// Scenario 1: single interleaved 2-channel buffer. Mono must be a
    /// correct per-frame L/R average at the correct (halved) length, not
    /// double-length garbage from a raw copy — this is the CRITICAL bug
    /// this module's history warns about.
    #[test]
    fn interleaved_stereo_buffer_downmixes_correctly() {
        let mut samples = vec![1.0_f32, 3.0, 2.0, 4.0]; // frames: (L=1,R=3), (L=2,R=4)
        let raw = RawBufferList {
            mNumberBuffers: 1,
            mBuffers: [buffer(2, &mut samples)],
        };
        let list = as_list(&raw);

        let mut stereo = Vec::new();
        fill_stereo_interleaved(list, &mut stereo);
        assert_eq!(
            stereo,
            vec![1.0, 3.0, 2.0, 4.0],
            "stereo must preserve distinct L/R"
        );

        let mut mono = Vec::new();
        assert!(downmix_stereo_to_mono(&stereo, &mut mono));
        assert_eq!(mono.len(), 2, "must not double the apparent sample count");
        assert_eq!(mono, vec![2.0, 3.0]);
    }

    /// Scenario 2: two planar mono buffers of equal length. Mono is the
    /// correct L/R average; stereo interleaves them preserving distinct
    /// channels.
    #[test]
    fn planar_equal_length_buffers_average_correctly() {
        let mut left = vec![1.0_f32, 2.0, 3.0];
        let mut right = vec![5.0_f32, 6.0, 7.0];
        let raw = RawBufferList {
            mNumberBuffers: 2,
            mBuffers: [buffer(1, &mut left), buffer(1, &mut right)],
        };
        let list = as_list(&raw);

        let mut stereo = Vec::new();
        fill_stereo_interleaved(list, &mut stereo);
        assert_eq!(stereo, vec![1.0, 5.0, 2.0, 6.0, 3.0, 7.0]);

        let mut mono = Vec::new();
        assert!(downmix_stereo_to_mono(&stereo, &mut mono));
        assert_eq!(mono, vec![3.0, 4.0, 5.0]);
    }

    /// Scenario 3: two planar mono buffers of UNEQUAL length. Both stereo
    /// and mono must consistently truncate to the shorter buffer — no `/2`
    /// gain error on a tail element that was never actually summed with an
    /// R sample (the HIGH finding).
    #[test]
    fn planar_unequal_length_buffers_truncate_without_gain_error() {
        let mut left = vec![1.0_f32, 2.0, 3.0, 4.0]; // longer
        let mut right = vec![10.0_f32, 20.0]; // shorter — truncation point
        let raw = RawBufferList {
            mNumberBuffers: 2,
            mBuffers: [buffer(1, &mut left), buffer(1, &mut right)],
        };
        let list = as_list(&raw);

        let mut stereo = Vec::new();
        fill_stereo_interleaved(list, &mut stereo);
        assert_eq!(
            stereo,
            vec![1.0, 10.0, 2.0, 20.0],
            "must truncate to the shorter buffer, not read past it"
        );

        let mut mono = Vec::new();
        assert!(downmix_stereo_to_mono(&stereo, &mut mono));
        assert_eq!(
            mono,
            vec![5.5, 11.0],
            "every mono sample must be a true (L+R)/2 average, never a lone L/2 tail"
        );
    }

    /// Scenario 4: single genuine mono buffer (`mNumberChannels == 1`).
    /// Mono must pass through numerically unchanged from the pre-fix
    /// implementation's behavior for this case; stereo duplicates it to
    /// both channels.
    #[test]
    fn genuine_mono_buffer_passes_through_unchanged_and_stereo_duplicates() {
        let mut samples = vec![1.0_f32, 2.0, 3.0];
        let raw = RawBufferList {
            mNumberBuffers: 1,
            mBuffers: [buffer(1, &mut samples)],
        };
        let list = as_list(&raw);

        let mut stereo = Vec::new();
        fill_stereo_interleaved(list, &mut stereo);
        assert_eq!(stereo, vec![1.0, 1.0, 2.0, 2.0, 3.0, 3.0]);

        let mut mono = Vec::new();
        assert!(downmix_stereo_to_mono(&stereo, &mut mono));
        assert_eq!(
            mono,
            vec![1.0, 2.0, 3.0],
            "(L+R)/2 must reproduce the original mono samples exactly, since \
             Core Audio duplicates a mono source to both stereo channels"
        );
    }

    /// Scenario 5a: zero buffers. No panic, empty output.
    #[test]
    fn zero_buffers_produce_no_panic_and_empty_output() {
        let raw = RawBufferList::<0> {
            mNumberBuffers: 0,
            mBuffers: [],
        };
        let list = as_list(&raw);

        let mut stereo = vec![9.0]; // pre-populated to prove `.clear()` runs
        fill_stereo_interleaved(list, &mut stereo);
        assert!(stereo.is_empty());

        let mut mono = vec![9.0];
        assert!(!downmix_stereo_to_mono(&stereo, &mut mono));
        assert!(mono.is_empty());
    }

    /// Scenario 5b: a buffer that is present but null/zero-length. Same
    /// no-panic, empty-output contract.
    #[test]
    fn null_buffer_produces_no_panic_and_empty_output() {
        let raw = RawBufferList {
            mNumberBuffers: 1,
            mBuffers: [null_buffer()],
        };
        let list = as_list(&raw);

        let mut stereo = Vec::new();
        fill_stereo_interleaved(list, &mut stereo);
        assert!(stereo.is_empty());

        let mut mono = Vec::new();
        assert!(!downmix_stereo_to_mono(&stereo, &mut mono));
        assert!(mono.is_empty());
    }

    /// Scenario 6: a single buffer reporting more than two channels (the
    /// MEDIUM finding). This crate has no defined stride for that layout,
    /// so it must degrade honestly (empty output) rather than scramble
    /// samples by assuming a stride-2 framing.
    #[test]
    fn more_than_two_channels_degrades_to_empty_output_instead_of_scrambling() {
        let mut samples = vec![1.0_f32, 2.0, 3.0, 4.0, 5.0, 6.0]; // 2 frames of 3 channels
        let raw = RawBufferList {
            mNumberBuffers: 1,
            mBuffers: [buffer(3, &mut samples)],
        };
        let list = as_list(&raw);

        let mut stereo = Vec::new();
        fill_stereo_interleaved(list, &mut stereo);
        assert!(
            stereo.is_empty(),
            "an unrecognized >2-channel layout must not be reinterpreted as stride-2 stereo"
        );

        let mut mono = Vec::new();
        assert!(!downmix_stereo_to_mono(&stereo, &mut mono));
        assert!(mono.is_empty());
    }
}
