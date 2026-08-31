//! Tests for the platform-neutral capture-source abstraction. No real audio
//! device or platform API is touched by the default (non-`--ignored`) suite
//! in this file: the `CaptureSource::Microphone` path (which does open a
//! device) is exercised by the existing `capture` integration coverage, not
//! here. The one exception is
//! `capture_sources_for_mixed_source_degrades_to_microphone_when_system_audio_is_unavailable`
//! below, which is gated behind `#[ignore]` + `MYNA_LIVE_AUDIO_TESTS` for
//! exactly that reason.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use myna_audio::{
    capture_sources, request_system_audio_permission, system_audio_status, AudioError,
    CaptureConfig, CaptureRequest, CaptureSource, SystemAudioStatus,
};

#[test]
fn capture_source_defaults_to_mixed() {
    // Arrange & Act
    let source = CaptureSource::default();

    // Assert
    assert_eq!(source, CaptureSource::Mixed);
}

#[test]
fn capture_source_serializes_to_lowercase_names() {
    // Arrange
    let sources = [
        (CaptureSource::Microphone, "\"microphone\""),
        (CaptureSource::System, "\"system\""),
        (CaptureSource::Mixed, "\"mixed\""),
    ];

    for (source, expected_json) in sources {
        // Act
        let json = serde_json::to_string(&source).expect("serializes");

        // Assert
        assert_eq!(json, expected_json);
    }
}

/// On platforms with no system-audio backend, `capture_sources(System)` must
/// reject with `SystemAudioUnavailable` — the only defined outcome there.
///
/// On macOS, a real backend exists, so the outcome instead depends on this
/// machine's actual [`SystemAudioStatus`] (permission granted? display
/// attached?) — see `capture_sources_for_system_source_matches_the_reported_status`
/// below for the platform-agnostic invariant that replaces this on macOS.
#[test]
#[cfg(not(target_os = "macos"))]
fn capture_sources_rejects_system_source_as_unavailable() {
    // Arrange
    let request = CaptureRequest {
        source: CaptureSource::System,
        device: None,
        system_source: None,
        config: CaptureConfig::default(),
    };
    let stop = Arc::new(AtomicBool::new(true));

    // Act
    let result = capture_sources(&request, stop, |_samples| {}, |_source| {}, |_rate: u32| {});

    // Assert
    assert!(matches!(result, Err(AudioError::SystemAudioUnavailable(_))));
}

/// macOS counterpart of the platform-neutral rejection test above: with a
/// real backend, `capture_sources(System)` must agree with
/// [`system_audio_status`] rather than always failing. `stop` starts
/// `true`, so an `Available` machine starts and immediately stops the
/// stream, succeeding trivially; any other status must still reject with
/// `SystemAudioUnavailable`.
#[test]
#[cfg(target_os = "macos")]
fn capture_sources_for_system_source_matches_the_reported_status() {
    // Arrange
    let request = CaptureRequest {
        source: CaptureSource::System,
        device: None,
        system_source: None,
        config: CaptureConfig::default(),
    };
    let stop = Arc::new(AtomicBool::new(true));

    // Act
    let result = capture_sources(&request, stop, |_samples| {}, |_source| {}, |_rate: u32| {});

    // Assert
    match system_audio_status() {
        SystemAudioStatus::Available => {
            assert!(result.is_ok(), "expected Ok, got {result:?}");
        }
        other => {
            assert!(
                matches!(result, Err(AudioError::SystemAudioUnavailable(_))),
                "expected SystemAudioUnavailable while status is {other:?}, got {result:?}"
            );
        }
    }
}

/// See the `System`-source pair of tests above for why this is
/// platform-gated the same way.
#[test]
#[cfg(not(target_os = "macos"))]
fn capture_sources_rejects_mixed_source_as_unavailable() {
    // Arrange
    let request = CaptureRequest {
        source: CaptureSource::Mixed,
        device: None,
        system_source: None,
        config: CaptureConfig::default(),
    };
    let stop = Arc::new(AtomicBool::new(true));

    // Act
    let result = capture_sources(&request, stop, |_samples| {}, |_source| {}, |_rate: u32| {});

    // Assert
    assert!(matches!(result, Err(AudioError::SystemAudioUnavailable(_))));
}

/// macOS counterpart of the platform-neutral mixed-source rejection test —
/// except `Mixed` no longer rejects. `capture_mixed` degrades to
/// microphone-only whenever system-audio attach fails (a meeting recorder
/// that records half the room beats one that refuses to record at all), so
/// the invariant that actually holds unconditionally today is: whenever
/// [`system_audio_status`] is not `Available`, `capture_sources` still
/// *succeeds*, by falling back to the microphone, rather than erroring or
/// hanging.
///
/// Requires real hardware: the fallback path this exercises opens a genuine
/// microphone input stream (`capture_microphone`), which can block on a
/// macOS microphone-permission prompt in a non-interactive run — exactly
/// the trap that made the old, always-rejects version of this test hang the
/// default suite once `capture_mixed` started falling back to the mic
/// instead of propagating the attach error. So this is gated the same way
/// as the live tests in `system_macos_live.rs` (`#[ignore]` *and*
/// `MYNA_LIVE_AUDIO_TESTS`; see that module's docs for how to run it).
/// `stop` is already `true` before capture starts, so once the fallback
/// runs this returns immediately — no fixed sleep, no polling.
///
/// The deterministic, hardware-free proof that the degrade-on-attach-
/// failure behavior itself is correct — and the one that runs in the
/// default suite — is
/// `capture::tests::capture_mixed_falls_back_to_microphone_only_when_system_audio_attach_fails`
/// in `src/capture.rs`, which fakes both the attach and mic-only steps.
#[test]
#[ignore = "requires real hardware: opens a real microphone input stream via the mic-only fallback"]
#[cfg(target_os = "macos")]
fn capture_sources_for_mixed_source_degrades_to_microphone_when_system_audio_is_unavailable() {
    if std::env::var("MYNA_LIVE_AUDIO_TESTS").is_err() {
        return;
    }

    // Arrange
    let request = CaptureRequest {
        source: CaptureSource::Mixed,
        device: None,
        system_source: None,
        config: CaptureConfig::default(),
    };
    let stop = Arc::new(AtomicBool::new(true));

    // Act
    let result = capture_sources(&request, stop, |_samples| {}, |_source| {}, |_rate: u32| {});

    // Assert
    if system_audio_status() != SystemAudioStatus::Available {
        assert!(
            result.is_ok(),
            "expected Mixed to degrade to microphone-only rather than erroring \
             when system audio is unavailable, got {result:?}"
        );
    }
}

/// On platforms with no system-audio backend, status is always
/// `Unavailable`. On macOS, see `system_audio_status_is_deterministic_on_macos`
/// below — a real backend's status depends on this machine's actual
/// permission/display state, not just "no backend".
#[test]
#[cfg(not(target_os = "macos"))]
fn system_audio_status_reports_unavailable_without_a_platform_backend() {
    // Act
    let status = system_audio_status();

    // Assert
    assert!(matches!(status, SystemAudioStatus::Unavailable { .. }));
}

/// A real backend's status must still be a well-defined, stable value: two
/// consecutive calls with no state change in between report the same
/// status, and the call itself never panics.
#[test]
#[cfg(target_os = "macos")]
fn system_audio_status_is_deterministic_on_macos() {
    // Act
    let first = system_audio_status();
    let second = system_audio_status();

    // Assert
    assert_eq!(first, second);
}

/// See `system_audio_status_reports_unavailable_without_a_platform_backend`
/// for why this is platform-gated the same way.
#[test]
#[cfg(not(target_os = "macos"))]
fn requesting_system_audio_permission_reports_the_same_unavailable_status() {
    // Act
    let status = request_system_audio_permission();

    // Assert
    assert!(matches!(status, SystemAudioStatus::Unavailable { .. }));
}

/// On macOS this prompts a real OS permission dialog when permission is not
/// yet granted, so this test only asserts what the module docs promise:
/// the call completes (never hangs) and returns a well-defined status,
/// whatever it is — never that it equals a specific variant, since that
/// depends on this machine's permission state.
#[test]
#[cfg(target_os = "macos")]
fn requesting_system_audio_permission_completes_with_a_defined_status_on_macos() {
    // Act
    let status = request_system_audio_permission();

    // Assert
    match status {
        SystemAudioStatus::Available
        | SystemAudioStatus::PermissionDenied { .. }
        | SystemAudioStatus::Unavailable { .. }
        | SystemAudioStatus::Unknown => {}
    }
}

#[test]
fn system_audio_status_serializes_with_a_kind_tag() {
    // Arrange
    let status = SystemAudioStatus::Unavailable {
        reason: "no backend".to_string(),
    };

    // Act
    let json = serde_json::to_string(&status).expect("serializes");

    // Assert
    assert_eq!(json, "{\"kind\":\"unavailable\",\"reason\":\"no backend\"}");
}
