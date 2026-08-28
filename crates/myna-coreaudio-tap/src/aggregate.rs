//! Builds the `CFDictionary` describing a private aggregate device that
//! wraps exactly one process tap, per Apple's `AudioHardwareTapping.h`.

use objc2_core_audio::{
    kAudioAggregateDeviceIsPrivateKey, kAudioAggregateDeviceNameKey,
    kAudioAggregateDeviceTapAutoStartKey, kAudioAggregateDeviceTapListKey,
    kAudioAggregateDeviceUIDKey, kAudioSubTapUIDKey,
};
use objc2_core_foundation::{CFArray, CFBoolean, CFDictionary, CFRetained, CFString, CFType};

/// Human-readable name given to every aggregate device this crate creates.
/// Only shown in system audio device pickers, which never surface a private
/// aggregate — cosmetic only.
const AGGREGATE_DEVICE_NAME: &str = "Myna Process Tap Aggregate";

fn cstr_to_str(c: &std::ffi::CStr) -> &str {
    c.to_str().expect("Core Audio key constants are ASCII")
}

/// Describes a private, auto-starting aggregate device containing exactly
/// the sub-tap named by `tap_uid`, uniquely identified by `aggregate_uid`.
pub(crate) fn build_aggregate_description(
    aggregate_uid: &str,
    tap_uid: &str,
) -> CFRetained<CFDictionary<CFString, CFType>> {
    let name = CFString::from_str(AGGREGATE_DEVICE_NAME);
    let uid = CFString::from_str(aggregate_uid);
    let is_private = CFBoolean::new(true);
    let auto_start = CFBoolean::new(true);

    let sub_tap_uid_key = CFString::from_str(cstr_to_str(kAudioSubTapUIDKey));
    let tap_uid_value = CFString::from_str(tap_uid);
    let tap_entry: CFRetained<CFDictionary<CFString, CFType>> =
        CFDictionary::from_slices(&[&*sub_tap_uid_key], &[tap_uid_value.as_ref()]);
    let tap_list: CFRetained<CFArray<CFDictionary<CFString, CFType>>> =
        CFArray::from_retained_objects(&[tap_entry]);

    let name_key = CFString::from_str(cstr_to_str(kAudioAggregateDeviceNameKey));
    let uid_key = CFString::from_str(cstr_to_str(kAudioAggregateDeviceUIDKey));
    let private_key = CFString::from_str(cstr_to_str(kAudioAggregateDeviceIsPrivateKey));
    let auto_start_key = CFString::from_str(cstr_to_str(kAudioAggregateDeviceTapAutoStartKey));
    let tap_list_key = CFString::from_str(cstr_to_str(kAudioAggregateDeviceTapListKey));

    CFDictionary::from_slices(
        &[
            &*name_key,
            &*uid_key,
            &*private_key,
            &*auto_start_key,
            &*tap_list_key,
        ],
        &[
            name.as_ref(),
            uid.as_ref(),
            is_private.as_ref(),
            auto_start.as_ref(),
            tap_list.as_ref(),
        ],
    )
}
