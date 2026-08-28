//! Process object enumeration, PID <-> `AudioObjectID` translation, and the
//! "is this process rendering output audio" query used for stall detection.
//!
//! Every property read in this crate — including the tap's stream-format
//! read in `tap.rs` — goes through [`get_property_raw`], the crate's sole
//! `AudioObjectGetPropertyData`/`AudioObjectGetPropertyDataSize` call site.

use std::ffi::c_void;
use std::ptr::NonNull;

use objc2_core_audio::{
    kAudioHardwarePropertyProcessObjectList, kAudioHardwarePropertyTranslatePIDToProcessObject,
    kAudioObjectPropertyElementMain, kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject,
    kAudioProcessPropertyBundleID, kAudioProcessPropertyIsRunningOutput, kAudioProcessPropertyPID,
    AudioObjectGetPropertyData, AudioObjectGetPropertyDataSize, AudioObjectID,
    AudioObjectPropertyAddress,
};
use objc2_core_foundation::{CFRetained, CFString};

/// Size, in bytes, of one raw `u32`-backed id (an [`AudioObjectID`] or a
/// pid) inside a property's raw byte buffer.
const ID_SIZE: usize = std::mem::size_of::<u32>();

/// One process Core Audio's HAL currently tracks: anything that has opened
/// an input or output audio stream. Unlike ScreenCaptureKit's
/// per-application enumeration, this includes headless helper processes —
/// e.g. an Electron renderer or a Teams helper — as long as they themselves
/// touch audio, which is exactly what makes per-process taps able to follow
/// them where ScreenCaptureKit's single per-app object could not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioProcess {
    /// The id [`crate::ProcessTapCapture::start`] takes to tap this process.
    pub object_id: AudioObjectID,
    pub pid: i32,
    /// `None` when the process has no bundle id (e.g. a bare CLI tool like
    /// `afplay`) — still capturable by `object_id`, just not groupable by
    /// bundle id the way a GUI application's helper processes are.
    pub bundle_id: Option<String>,
}

impl AudioProcess {
    /// Enumerates every process object the HAL currently knows about.
    /// Silently skips any object id that no longer resolves a pid by the
    /// time it's queried — processes can exit mid-enumeration — rather than
    /// failing the whole call.
    pub fn list() -> Vec<AudioProcess> {
        process_object_ids()
            .into_iter()
            .filter_map(describe_process)
            .collect()
    }
}

/// Translates a pid to the [`AudioObjectID`] Core Audio uses to refer to it,
/// or `None` if the HAL has no process object for that pid — it exited, or
/// never opened an audio stream.
pub fn translate_pid(pid: i32) -> Option<AudioObjectID> {
    let qualifier = pid.to_ne_bytes();
    let bytes = get_property_raw(
        kAudioObjectSystemObject as AudioObjectID,
        kAudioHardwarePropertyTranslatePIDToProcessObject,
        kAudioObjectPropertyScopeGlobal,
        Some(&qualifier),
    )?;
    let object_id = read_u32(&bytes)?;
    (object_id != 0).then_some(object_id)
}

/// Reports whether the process behind `object_id` is currently rendering
/// output audio (`kAudioProcessPropertyIsRunningOutput`).
///
/// This is what stall detection needs: a process tap's IOProc keeps firing
/// on schedule even when its source produces silence, so buffer content
/// alone can't distinguish a stalled tap from a genuinely quiet one — this
/// property can. Returns `false` (never panics) when the property is
/// unavailable, e.g. the process has since exited.
pub fn is_process_running_output(object_id: AudioObjectID) -> bool {
    get_property_raw(
        object_id,
        kAudioProcessPropertyIsRunningOutput,
        kAudioObjectPropertyScopeGlobal,
        None,
    )
    .and_then(|bytes| read_u32(&bytes))
    .map(|value| value != 0)
    .unwrap_or(false)
}

fn process_object_ids() -> Vec<AudioObjectID> {
    let Some(bytes) = get_property_raw(
        kAudioObjectSystemObject as AudioObjectID,
        kAudioHardwarePropertyProcessObjectList,
        kAudioObjectPropertyScopeGlobal,
        None,
    ) else {
        return Vec::new();
    };
    bytes
        .as_chunks::<ID_SIZE>()
        .0
        .iter()
        .copied()
        .map(u32::from_ne_bytes)
        .collect()
}

fn describe_process(object_id: AudioObjectID) -> Option<AudioProcess> {
    let pid_bytes = get_property_raw(
        object_id,
        kAudioProcessPropertyPID,
        kAudioObjectPropertyScopeGlobal,
        None,
    )?;
    let pid = read_i32(&pid_bytes)?;
    let bundle_id = get_property_cf_string(object_id, kAudioProcessPropertyBundleID)
        .filter(|id| !id.is_empty());
    Some(AudioProcess {
        object_id,
        pid,
        bundle_id,
    })
}

fn read_u32(bytes: &[u8]) -> Option<u32> {
    bytes
        .get(0..ID_SIZE)?
        .try_into()
        .ok()
        .map(u32::from_ne_bytes)
}

fn read_i32(bytes: &[u8]) -> Option<i32> {
    bytes
        .get(0..ID_SIZE)?
        .try_into()
        .ok()
        .map(i32::from_ne_bytes)
}

/// Reads a `CFString`-typed property. `AudioObjectGetPropertyData` follows
/// Core Foundation's "Get Rule" for CF-typed properties: the returned object
/// is already retained on the caller's behalf. This takes ownership of that
/// reference via [`CFRetained::from_raw`] and lets it drop (releasing) once
/// the owned `String` copy has been made, so no reference is ever leaked.
fn get_property_cf_string(object_id: AudioObjectID, selector: u32) -> Option<String> {
    let bytes = get_property_raw(object_id, selector, kAudioObjectPropertyScopeGlobal, None)?;
    let pointer_size = std::mem::size_of::<usize>();
    let raw = usize::from_ne_bytes(bytes.get(0..pointer_size)?.try_into().ok()?) as *mut CFString;
    let ptr = NonNull::new(raw)?;
    // Safety: `raw` came from a CF-typed property read, which the Core Audio
    // HAL contract guarantees is a `+1`-retained `CFStringRef` the caller now
    // owns — exactly the precondition `CFRetained::from_raw` requires.
    let owned: CFRetained<CFString> = unsafe { CFRetained::from_raw(ptr) };
    Some(owned.to_string())
}

/// Reads a Core Audio object property into a raw byte buffer. Returns `None`
/// if the property is unavailable (mirrors `OSStatus != noErr`) rather than
/// panicking — every property this crate reads is optional in the sense
/// that its subject (a process, a device) may have gone away.
///
/// This is the crate's sole property-read primitive: every query above, and
/// the tap's stream-format read in `tap.rs`, goes through it.
pub(crate) fn get_property_raw(
    object_id: AudioObjectID,
    selector: u32,
    scope: u32,
    qualifier: Option<&[u8]>,
) -> Option<Vec<u8>> {
    let mut address = AudioObjectPropertyAddress {
        mSelector: selector,
        mScope: scope,
        mElement: kAudioObjectPropertyElementMain,
    };
    let (qualifier_size, qualifier_ptr): (u32, *const c_void) = match qualifier {
        Some(bytes) => (bytes.len() as u32, bytes.as_ptr() as *const c_void),
        None => (0, std::ptr::null()),
    };

    let mut size: u32 = 0;
    // Safety: `address` and `size` are valid, uniquely-owned local
    // out-params for the duration of this call; `qualifier_ptr` is either
    // null or points at `qualifier`, which outlives this call.
    let status = unsafe {
        AudioObjectGetPropertyDataSize(
            object_id,
            NonNull::from(&mut address),
            qualifier_size,
            qualifier_ptr,
            NonNull::from(&mut size),
        )
    };
    if status != 0 || size == 0 {
        return None;
    }

    let mut buf = vec![0u8; size as usize];
    let mut io_size = size;
    let data_ptr = NonNull::new(buf.as_mut_ptr() as *mut c_void)?;
    // Safety: `buf` is sized exactly to `size`, the size `AudioObjectGetPropertyDataSize`
    // just reported for this same property, so the HAL writes at most that
    // many bytes into it.
    let status = unsafe {
        AudioObjectGetPropertyData(
            object_id,
            NonNull::from(&mut address),
            qualifier_size,
            qualifier_ptr,
            NonNull::from(&mut io_size),
            data_ptr,
        )
    };
    if status != 0 {
        return None;
    }
    buf.truncate(io_size as usize);
    Some(buf)
}
