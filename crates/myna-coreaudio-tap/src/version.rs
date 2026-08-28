//! Runtime macOS version check.
//!
//! Process taps require macOS 14.4+. The app's `Info.plist` also declares a
//! `minimumSystemVersion`, but that key is ignored by `tauri dev` and by
//! plenty of launch paths in general, so callers that need a hard runtime
//! gate use this instead of trusting the bundle metadata.

use objc2_foundation::{NSOperatingSystemVersion, NSProcessInfo};

/// Reports whether the host is running macOS `major.minor` or later.
/// `patch` is always compared as `0`, matching how Apple documents this
/// feature's minimum ("macOS 14.4").
pub fn is_macos_at_least(major: isize, minor: isize) -> bool {
    let required = NSOperatingSystemVersion {
        majorVersion: major,
        minorVersion: minor,
        patchVersion: 0,
    };
    NSProcessInfo::processInfo().isOperatingSystemAtLeastVersion(required)
}
