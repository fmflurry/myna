//! Real macOS Core Audio process-tap backend for system-audio capture.
//!
//! Only [`crate::system`] branches on target platform; this module backs
//! macOS exclusively, swapped in there. It captures via
//! [`myna_coreaudio_tap`] process taps rather than ScreenCaptureKit: a
//! process tap is gated by the distinct `kTCCServiceAudioCapture` TCC
//! service, so the app only ever needs an audio-capture permission prompt,
//! never Screen Recording.
//!
//! # Permission status is genuinely unknown until a capture runs
//!
//! Unlike ScreenCaptureKit's `CGPreflightScreenCaptureAccess`, there is no
//! public preflight API for `kTCCServiceAudioCapture`. A private symbol
//! (`TCCAccessPreflight`) exists and is used by some community tools, but
//! shipping calls to a private, unstable API is not acceptable here. So
//! [`system_audio_status`] reports [`SystemAudioStatus::Unknown`] until an
//! actual capture attempt has run in this process, at which point the
//! observed outcome (`Available` or `PermissionDenied`) is cached in
//! [`LAST_OBSERVED`] for subsequent calls.
//!
//! # Runtime macOS 14.4+ gate
//!
//! Process taps require macOS 14.4. The bundle's `Info.plist` can declare a
//! `minimumSystemVersion`, but that key is ignored by `tauri dev` (and by
//! plenty of other launch paths), so every entry point here re-checks the
//! live OS version via [`myna_coreaudio_tap::is_macos_at_least`] rather than
//! trusting bundle metadata.
//!
//! # Sample rate is discovered, never assumed
//!
//! A tap delivers audio at its aggregate device's native rate, which is
//! whatever the current output hardware runs at (48 kHz here, but 44.1 kHz
//! is common too) — there is no way to request a specific rate the way
//! ScreenCaptureKit allowed. [`SystemAudioCapture::start`] therefore returns
//! the actual rate it observed, and callers (`crate::capture`) must build
//! their resampler from that returned value.

use std::collections::BTreeSet;
use std::sync::Mutex;

use myna_coreaudio_tap::{
    is_macos_at_least, is_process_running_output, translate_pid, AudioObjectID, AudioProcess,
    ProcessTapCapture, TapError, TapScope,
};

use crate::error::AudioError;
use crate::system::{SystemAudioSource, SystemAudioStatus};

/// Prefix for an id derived from a running application's bundle identifier.
const APP_BUNDLE_ID_PREFIX: &str = "app:";

/// Prefix for an id derived from a bare pid, used when a process has no
/// bundle identifier to key off of. Checked *before* [`APP_BUNDLE_ID_PREFIX`]
/// when resolving an id back to a source, since it is itself prefixed by it
/// (`"app:pid:123"` also starts with `"app:"`).
const APP_PID_PREFIX: &str = "app:pid:";

/// Minimum macOS version process taps require.
const MIN_MACOS_MAJOR: isize = 14;
const MIN_MACOS_MINOR: isize = 4;

/// Reason reported when [`macos_version_gate`] fails.
const UNSUPPORTED_OS_REASON: &str = "system audio capture requires macOS 14.4 or later";

/// Most recently *observed* status from an actual capture (or
/// permission-probing) attempt in this process. `None` until the first one
/// runs — see this module's docs on why there is no preflight to consult
/// instead.
static LAST_OBSERVED: Mutex<Option<SystemAudioStatus>> = Mutex::new(None);

/// Returns `Some(Unavailable)` when the host is below [`MIN_MACOS_MAJOR`].[`MIN_MACOS_MINOR`],
/// `None` when process taps are supported here.
fn macos_version_gate() -> Option<SystemAudioStatus> {
    if is_macos_at_least(MIN_MACOS_MAJOR, MIN_MACOS_MINOR) {
        None
    } else {
        Some(SystemAudioStatus::Unavailable {
            reason: UNSUPPORTED_OS_REASON.to_string(),
        })
    }
}

fn record_status(status: SystemAudioStatus) {
    if let Ok(mut guard) = LAST_OBSERVED.lock() {
        *guard = Some(status);
    }
}

/// Treats a failure to create the tap itself as a best-effort signal that
/// permission was denied — the tap is the first HAL object a capture
/// creates, so if it fails, nothing downstream (aggregate device, IOProc)
/// could have run either. A failure at any *later* step means the tap
/// itself already succeeded, i.e. permission was already granted, so it is
/// deliberately not recorded as a permission outcome.
fn record_permission_outcome_from_tap_error(err: &TapError) {
    if matches!(err, TapError::TapCreationFailed(_)) {
        record_status(SystemAudioStatus::PermissionDenied {
            restart_required: false,
        });
    }
}

/// Reports whether system-audio capture is currently available, without
/// prompting the user. See this module's docs: with no real preflight API,
/// this can only report [`SystemAudioStatus::Unknown`] until some capture
/// attempt in this process has already observed a definite outcome.
pub(crate) fn system_audio_status() -> SystemAudioStatus {
    if let Some(unavailable) = macos_version_gate() {
        return unavailable;
    }
    LAST_OBSERVED
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
        .unwrap_or(SystemAudioStatus::Unknown)
}

/// Prompts the OS for system-audio (`kTCCServiceAudioCapture`) permission.
///
/// There is no separate "request permission" API for this TCC service: the
/// only way to trigger (or observe) it is to actually attempt a tap. This
/// builds the smallest possible tap — global, excluding nobody — purely to
/// force that evaluation, then tears it down immediately regardless of the
/// outcome.
pub(crate) fn request_system_audio_permission() -> SystemAudioStatus {
    if let Some(unavailable) = macos_version_gate() {
        return unavailable;
    }

    match ProcessTapCapture::start(TapScope::GlobalExcluding(&[]), |_samples| {}) {
        Ok((capture, _format)) => {
            capture.stop();
            record_status(SystemAudioStatus::Available);
        }
        Err(err) => record_permission_outcome_from_tap_error(&err),
    }
    system_audio_status()
}

/// Lists running processes as [`SystemAudioSource`]s, grouped by bundle id
/// where one exists (one entry per distinct bundle id, matching every pid
/// that shares it — see [`resolve_scope`]) and one entry per pid otherwise.
/// Excludes this process itself.
pub(crate) fn list_running_application_sources() -> Vec<SystemAudioSource> {
    if macos_version_gate().is_some() {
        return Vec::new();
    }

    let current_pid = std::process::id() as i32;
    let mut seen_bundle_ids: BTreeSet<String> = BTreeSet::new();
    let mut sources = Vec::new();

    for process in AudioProcess::list() {
        if process.pid == current_pid {
            continue;
        }
        match process.bundle_id {
            Some(bundle_id) if seen_bundle_ids.insert(bundle_id.clone()) => {
                sources.push(SystemAudioSource {
                    id: format!("{APP_BUNDLE_ID_PREFIX}{bundle_id}"),
                    name: bundle_id,
                });
            }
            Some(_) => {}
            None => sources.push(SystemAudioSource {
                id: format!("{APP_PID_PREFIX}{}", process.pid),
                name: format!("pid {}", process.pid),
            }),
        }
    }
    sources
}

/// Resolves `system_source` (a [`SystemAudioSource::id`]) against a **live**
/// [`AudioProcess::list`] snapshot taken right here, at capture start,
/// rather than trusting whatever produced it — a bundle id or pid listed
/// earlier can go stale by the time a recording actually starts.
///
/// Returns the process object ids to tap (`None` means "tap everything") and
/// the [`SystemAudioSource`] that selection actually captures. Falls back to
/// all-output whenever `system_source` is `None`, is unrecognized, or no
/// longer resolves to any live process — never fails.
///
/// For a bundle id, **every** matching pid is included (not just one) —
/// this is what lets a per-app capture follow an Electron or Teams helper
/// process that ScreenCaptureKit's single per-application object could
/// never reach.
fn resolve_scope(system_source: Option<&str>) -> (Option<Vec<AudioObjectID>>, SystemAudioSource) {
    let Some(id) = system_source else {
        return (None, SystemAudioSource::all_output());
    };

    if let Some(pid_str) = id.strip_prefix(APP_PID_PREFIX) {
        let object_id = pid_str.parse::<i32>().ok().and_then(translate_pid);
        eprintln!("pid {pid_str} -> AudioObjectID {object_id:?}");
        return match object_id {
            Some(object_id) => (
                Some(vec![object_id]),
                SystemAudioSource {
                    id: id.to_string(),
                    name: format!("pid {pid_str}"),
                },
            ),
            None => (None, SystemAudioSource::all_output()),
        };
    }

    if let Some(bundle_id) = id.strip_prefix(APP_BUNDLE_ID_PREFIX) {
        let object_ids: Vec<AudioObjectID> = AudioProcess::list()
            .into_iter()
            .filter(|process| process.bundle_id.as_deref() == Some(bundle_id))
            .map(|process| process.object_id)
            .collect();
        if object_ids.is_empty() {
            return (None, SystemAudioSource::all_output());
        }
        return (
            Some(object_ids),
            SystemAudioSource {
                id: id.to_string(),
                name: bundle_id.to_string(),
            },
        );
    }

    (None, SystemAudioSource::all_output())
}

/// A running macOS Core Audio process-tap system-audio capture.
pub(crate) struct SystemAudioCapture {
    inner: ProcessTapCapture,
    /// Process object ids this capture taps; empty for the all-output
    /// (global) source, in which case [`Self::is_any_tapped_process_rendering_output`]
    /// falls back to checking every process on the system instead of a
    /// fixed set — a global tap has no fixed set to check.
    tapped_processes: Vec<AudioObjectID>,
}

impl SystemAudioCapture {
    /// Starts capturing system audio.
    ///
    /// Delivers mono f32 PCM to `on_pcm`, called from Core Audio's realtime
    /// IO thread — never the calling thread — which must not block. Returns
    /// the actual sample rate the tap's aggregate device reported (see this
    /// module's docs on why that can't be assumed) alongside the capture
    /// handle and the [`SystemAudioSource`] actually captured.
    pub(crate) fn start(
        system_source: Option<&str>,
        on_pcm: impl FnMut(&[f32]) + Send + 'static,
    ) -> Result<(Self, SystemAudioSource, u32), AudioError> {
        if let Some(SystemAudioStatus::Unavailable { reason }) = macos_version_gate() {
            return Err(AudioError::SystemAudioUnavailable(reason));
        }

        let (scope_processes, effective_source) = resolve_scope(system_source);
        let current_pid = std::process::id() as i32;

        let start_result = match &scope_processes {
            Some(processes) => ProcessTapCapture::start(TapScope::Processes(processes), on_pcm),
            None => {
                let exclude_self: Vec<AudioObjectID> =
                    translate_pid(current_pid).into_iter().collect();
                ProcessTapCapture::start(TapScope::GlobalExcluding(&exclude_self), on_pcm)
            }
        };

        let (capture, format) = start_result.map_err(|err| {
            record_permission_outcome_from_tap_error(&err);
            AudioError::SystemAudioUnavailable(err.to_string())
        })?;
        record_status(SystemAudioStatus::Available);

        let actual_rate = format.sample_rate_hz.round().clamp(1.0, u32::MAX as f64) as u32;
        eprintln!(
            "myna-audio: system-audio tap started (source: {effective_source:?}, native \
             sample rate: {actual_rate} Hz, channels: {})",
            format.channels
        );
        Ok((
            Self {
                inner: capture,
                tapped_processes: scope_processes.unwrap_or_default(),
            },
            effective_source,
            actual_rate,
        ))
    }

    /// Stops the capture. Dropping a [`SystemAudioCapture`] without calling
    /// this also stops it, via [`ProcessTapCapture`]'s own `Drop`.
    pub(crate) fn stop(self) -> Result<(), AudioError> {
        self.inner.stop();
        Ok(())
    }

    /// Polls whether any process this capture taps is currently rendering
    /// output audio (`kAudioProcessPropertyIsRunningOutput`), for stall
    /// detection: a tap's IOProc keeps firing on schedule even when its
    /// source produces silence, so buffer content alone can't tell a
    /// stalled tap from a genuinely quiet one apart — this can.
    ///
    /// For the all-output source (empty [`Self::tapped_processes`]) there is
    /// no fixed set of processes to check individually, so this instead
    /// reports whether *any* process on the system is currently rendering
    /// output.
    pub(crate) fn is_any_tapped_process_rendering_output(&self) -> bool {
        if self.tapped_processes.is_empty() {
            return AudioProcess::list()
                .iter()
                .any(|process| is_process_running_output(process.object_id));
        }
        self.tapped_processes
            .iter()
            .any(|&object_id| is_process_running_output(object_id))
    }
}
