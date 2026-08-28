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

use std::collections::BTreeMap;
use std::sync::Mutex;

use myna_coreaudio_tap::{
    executable_name, executable_path, is_macos_at_least, is_process_running_output, translate_pid,
    AudioObjectID, AudioProcess, ProcessTapCapture, TapError, TapScope,
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

/// Prefix for a group-scoped id spanning every live process whose executable
/// resolves under the same outermost `.app` bundle on disk (see
/// [`outermost_app_bundle_name`]) — the mechanism that lets one entry named
/// e.g. "Microsoft Teams" tap its module host, WebView renderer, and
/// notification center in a single capture, even though each ships under its
/// own distinct bundle id. Checked *before* [`APP_BUNDLE_ID_PREFIX`] when
/// resolving an id back to a scope, for the same reason [`APP_PID_PREFIX`]
/// is: it is itself prefixed by it (`"app:group:foo"` also starts with
/// `"app:"`).
const APP_GROUP_PREFIX: &str = "app:group:";

/// Minimum macOS version process taps require.
const MIN_MACOS_MAJOR: isize = 14;
const MIN_MACOS_MINOR: isize = 4;

/// Reason reported when [`macos_version_gate`] fails.
const UNSUPPORTED_OS_REASON: &str = "system audio capture requires macOS 14.4 or later";

/// Prefix shared by every Apple background-service bundle id
/// [`is_filtered_apple_service`] drops from the picker.
const APPLE_BUNDLE_ID_PREFIX: &str = "com.apple.";

/// `com.apple.`-prefixed bundle ids kept despite [`APPLE_BUNDLE_ID_PREFIX`]
/// filtering — everyday user-facing Apple apps that can plausibly be a
/// meeting-audio source, not background daemons.
const APPLE_USER_FACING_BUNDLE_IDS: &[&str] = &[
    "com.apple.Safari",
    "com.apple.Music",
    "com.apple.FaceTime",
    "com.apple.QuickTimePlayerX",
];

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
/// Excludes this process itself, Apple background services (see
/// [`is_filtered_apple_service`]), and names every entry with a human
/// display name (see [`derive_display_name`]) — never a raw bundle id or a
/// bare pid.
pub(crate) fn list_running_application_sources() -> Vec<SystemAudioSource> {
    if macos_version_gate().is_some() {
        return Vec::new();
    }

    let current_pid = std::process::id() as i32;
    let processes = AudioProcess::list()
        .into_iter()
        .map(|process| RawProcess {
            pid: process.pid,
            bundle_id: process.bundle_id,
            raw_name: executable_name(process.pid),
            raw_path: executable_path(process.pid),
        })
        .collect();
    build_running_application_sources(processes, current_pid)
}

/// Plain data mirroring [`AudioProcess`] plus a best-effort raw executable
/// name and path, decoupled from Core Audio and libproc so the naming,
/// grouping, and filtering logic below is unit-testable without either.
#[derive(Debug, Clone)]
struct RawProcess {
    pid: i32,
    bundle_id: Option<String>,
    raw_name: Option<String>,
    raw_path: Option<String>,
}

/// Groups `processes` into one [`SystemAudioSource`] per app, in precedence
/// order:
///
/// 1. By outermost `.app` bundle name (see [`outermost_app_bundle_name`]),
///    when the process's executable resolves under one at all — this is what
///    collapses an app's helper processes (module host, renderer,
///    notification center, …) into a single entry even when each ships
///    under its own distinct bundle id, which bundle-id grouping alone
///    cannot do.
/// 2. Otherwise by bundle id (one entry per distinct id, matching every pid
///    that shares it — see [`resolve_scope`]).
/// 3. Otherwise by pid.
///
/// Names each with [`derive_display_name`], drops `current_pid` and Apple
/// background services (see [`is_filtered_apple_service`] and
/// [`app_group_is_filtered_apple_service`]), and sorts the result
/// alphabetically by name, case-insensitively.
fn build_running_application_sources(
    processes: Vec<RawProcess>,
    current_pid: i32,
) -> Vec<SystemAudioSource> {
    let mut by_app: BTreeMap<String, Vec<RawProcess>> = BTreeMap::new();
    let mut by_bundle_id: BTreeMap<String, Vec<RawProcess>> = BTreeMap::new();
    let mut pid_only = Vec::new();

    for process in processes {
        if process.pid == current_pid {
            continue;
        }
        let app_name = process
            .raw_path
            .as_deref()
            .and_then(outermost_app_bundle_name);
        match (app_name, &process.bundle_id) {
            (Some(app_name), _) => by_app.entry(app_name).or_default().push(process),
            (None, Some(bundle_id)) => by_bundle_id
                .entry(bundle_id.clone())
                .or_default()
                .push(process),
            (None, None) => pid_only.push(process),
        }
    }

    let mut sources = Vec::new();
    for (app_name, group) in by_app {
        if app_group_is_filtered_apple_service(&group) {
            continue;
        }
        let name = derive_display_name(Some(&app_name), None, None, 0);
        sources.push(SystemAudioSource {
            id: format!("{APP_GROUP_PREFIX}{}", slugify_app_name(&app_name)),
            name,
        });
    }
    for (bundle_id, group) in by_bundle_id {
        if is_filtered_apple_service(&bundle_id) {
            continue;
        }
        let name = derive_display_name(
            None,
            Some(&bundle_id),
            preferred_raw_name(&group).as_deref(),
            0,
        );
        sources.push(SystemAudioSource {
            id: format!("{APP_BUNDLE_ID_PREFIX}{bundle_id}"),
            name,
        });
    }
    for process in pid_only {
        let name = derive_display_name(None, None, process.raw_name.as_deref(), process.pid);
        sources.push(SystemAudioSource {
            id: format!("{APP_PID_PREFIX}{}", process.pid),
            name,
        });
    }

    sources.sort_by_key(|source| source.name.to_lowercase());
    sources
}

/// Returns the outermost `.app` bundle name (extension stripped, e.g.
/// `Microsoft Teams.app` -> `Microsoft Teams`) found in an executable path,
/// or `None` if the path contains no `.app` component at all (e.g. a bare
/// CLI tool like `afplay`, which runs from outside any bundle).
///
/// Takes the *first* `.app` path component, not the last, so a nested helper
/// bundle — e.g. `.../Chromium.app/Contents/Frameworks/Chromium
/// Helper.app/Contents/MacOS/Chromium Helper` — folds into its parent app
/// (`Chromium`) rather than reporting the inner helper bundle
/// (`Chromium Helper`) as its own group.
fn outermost_app_bundle_name(path: &str) -> Option<String> {
    path.split('/')
        .find_map(|segment| segment.strip_suffix(".app"))
        .filter(|name| !name.is_empty())
        .map(str::to_string)
}

/// Turns an app display name into a stable, id-safe slug for
/// [`APP_GROUP_PREFIX`] ids — lowercased, with every run of non-alphanumeric
/// characters collapsed to a single `-` (e.g. `Microsoft Teams` ->
/// `microsoft-teams`). Deterministic and reproduced identically at listing
/// time ([`build_running_application_sources`]) and resolution time
/// ([`resolve_group_scope`]), so the two always agree on what an id refers
/// to.
fn slugify_app_name(name: &str) -> String {
    let mut slug = String::with_capacity(name.len());
    let mut previous_was_separator = true; // suppresses a leading '-'
    for character in name.chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character.to_ascii_lowercase());
            previous_was_separator = false;
        } else if !previous_was_separator {
            slug.push('-');
            previous_was_separator = true;
        }
    }
    slug.trim_end_matches('-').to_string()
}

/// Reports whether every process in an app-bundle group carries a bundle id
/// that [`is_filtered_apple_service`] considers a background service —
/// mirroring that function's per-bundle-id check at the group level, so an
/// app group (e.g. Safari) is dropped only when *none* of its processes'
/// bundle ids are user-facing. A process with no bundle id never counts
/// towards filtering (conservative default: keep, don't drop).
fn app_group_is_filtered_apple_service(group: &[RawProcess]) -> bool {
    group.iter().all(|process| {
        process
            .bundle_id
            .as_deref()
            .is_some_and(is_filtered_apple_service)
    })
}

/// Picks the best raw name among processes sharing one bundle id: prefers
/// one that doesn't look like an auto-named helper process (e.g. "Foo Helper
/// (Renderer)") over the main app's own executable name, when both are
/// present in the group; otherwise falls back to the first name available.
fn preferred_raw_name(group: &[RawProcess]) -> Option<String> {
    group
        .iter()
        .filter_map(|process| process.raw_name.as_deref())
        .find(|name| !name.to_lowercase().contains("helper"))
        .map(str::to_string)
        .or_else(|| group.iter().find_map(|process| process.raw_name.clone()))
}

/// Reports whether `bundle_id` is an Apple background service that should
/// never appear as a meeting-audio source — a `com.apple.`-prefixed bundle
/// id not on the [`APPLE_USER_FACING_BUNDLE_IDS`] allowlist. Deliberately
/// conservative: it only ever drops Apple-owned ids, never a third-party
/// app, however obscure.
fn is_filtered_apple_service(bundle_id: &str) -> bool {
    bundle_id.starts_with(APPLE_BUNDLE_ID_PREFIX)
        && !APPLE_USER_FACING_BUNDLE_IDS.contains(&bundle_id)
}

/// Derives a human display name for one process (or app-bundle group), in
/// precedence order:
///
/// 1. `app_name` — the outermost `.app` bundle's basename with its extension
///    stripped (see [`outermost_app_bundle_name`]), e.g. `Microsoft
///    Teams.app` -> `Microsoft Teams`. This is exactly what Finder and the
///    Dock show the user, and beats every source below it.
/// 2. `raw_name` (the process's own executable name), when non-empty and
///    not obviously a machine identifier (see [`looks_like_identifier`]).
/// 3. `bundle_id`, humanised (see [`humanize_bundle_id`]).
/// 4. The generic `Process <pid>` placeholder, as a last resort.
///
/// Never returns a raw `com.*` bundle id or a bare number.
fn derive_display_name(
    app_name: Option<&str>,
    bundle_id: Option<&str>,
    raw_name: Option<&str>,
    pid: i32,
) -> String {
    if let Some(name) = app_name {
        return name.to_string();
    }
    if let Some(name) = valid_raw_name(raw_name) {
        return name;
    }
    match bundle_id {
        Some(bundle_id) => humanize_bundle_id(bundle_id),
        None => format!("Process {pid}"),
    }
}

/// Returns `raw_name` trimmed and title-cased, when it's non-empty and
/// doesn't look like a machine identifier — never a bundle id or a bare
/// number. Title-casing covers executable names macOS reports all-lowercase
/// (e.g. `firefox`, `myna`) without disturbing names that already carry
/// their own casing (e.g. `Chromium Helper`).
fn valid_raw_name(raw_name: Option<&str>) -> Option<String> {
    let name = raw_name?.trim();
    (!name.is_empty() && !looks_like_identifier(name)).then(|| title_case_words(name))
}

/// Capitalises the first letter of each whitespace-separated word in `name`,
/// leaving the rest of each word untouched.
fn title_case_words(name: &str) -> String {
    name.split_whitespace()
        .map(capitalize)
        .collect::<Vec<_>>()
        .join(" ")
}

/// Reports whether `name` looks like a machine identifier rather than a name
/// a user would recognise: purely numeric, or shaped like a reverse-DNS
/// bundle id or a `pid:`-prefixed id.
fn looks_like_identifier(name: &str) -> bool {
    name.chars().all(|character| character.is_ascii_digit())
        || name.starts_with("com.")
        || name.starts_with("org.")
        || name.starts_with("net.")
        || name.starts_with("pid:")
}

/// Humanises a bundle id into a readable name by taking its last
/// dot-component and splitting it into capitalised words on separators and
/// camelCase boundaries — e.g. `com.microsoft.Outlook` -> `Outlook`.
fn humanize_bundle_id(bundle_id: &str) -> String {
    let last_component = bundle_id
        .rsplit('.')
        .find(|segment| !segment.is_empty())
        .unwrap_or(bundle_id);
    humanize_identifier_segment(last_component)
}

/// Splits `segment` into words on `-`, `_`, whitespace, and camelCase
/// boundaries, capitalising each; falls back to the segment unchanged if it
/// contains no recognisable word boundary at all.
fn humanize_identifier_segment(segment: &str) -> String {
    let mut words: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut previous_was_lowercase = false;

    for character in segment.chars() {
        if character == '-' || character == '_' || character.is_whitespace() {
            if !current.is_empty() {
                words.push(std::mem::take(&mut current));
            }
            previous_was_lowercase = false;
            continue;
        }
        if character.is_uppercase() && previous_was_lowercase {
            words.push(std::mem::take(&mut current));
        }
        current.push(character);
        previous_was_lowercase = character.is_lowercase();
    }
    if !current.is_empty() {
        words.push(current);
    }

    if words.is_empty() {
        return segment.to_string();
    }
    words
        .iter()
        .map(|word| capitalize(word))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Uppercases the first character of `word`, leaving the rest untouched.
fn capitalize(word: &str) -> String {
    let mut characters = word.chars();
    match characters.next() {
        Some(first) => first.to_uppercase().chain(characters).collect(),
        None => String::new(),
    }
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

    if let Some(slug) = id.strip_prefix(APP_GROUP_PREFIX) {
        return resolve_group_scope(id, slug);
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

/// Plain description of one live process's identity, used only to resolve an
/// `app:group:<slug>` id against a snapshot — decoupled from Core Audio and
/// libproc (mirrors [`RawProcess`]'s role for listing) so
/// [`resolve_group_scope_from_candidates`] is unit-testable without either.
#[derive(Debug, Clone)]
struct ScopeCandidate {
    object_id: AudioObjectID,
    raw_path: Option<String>,
}

/// Resolves an `app:group:<slug>` id (`id`, with `slug` already the stripped
/// suffix) against a **live** [`AudioProcess::list`] snapshot taken right
/// here, at capture start — see [`resolve_scope`]'s docs on why a snapshot
/// taken earlier can't be trusted.
fn resolve_group_scope(id: &str, slug: &str) -> (Option<Vec<AudioObjectID>>, SystemAudioSource) {
    let candidates: Vec<ScopeCandidate> = AudioProcess::list()
        .into_iter()
        .map(|process| ScopeCandidate {
            object_id: process.object_id,
            raw_path: executable_path(process.pid),
        })
        .collect();
    resolve_group_scope_from_candidates(id, slug, &candidates)
}

/// Matches `candidates` against `slug` (see [`slugify_app_name`]) and builds
/// the scope [`resolve_group_scope`] returns: **every** matching pid's
/// object id, not just one — this is what lets selecting e.g.
/// "Microsoft Teams" tap its module host, WebView renderer, and notification
/// center in one capture, even though each ships under its own distinct
/// bundle id. Degrades to all-output (never errors) when nothing matches,
/// e.g. `slug` refers to an app that has since quit.
fn resolve_group_scope_from_candidates(
    id: &str,
    slug: &str,
    candidates: &[ScopeCandidate],
) -> (Option<Vec<AudioObjectID>>, SystemAudioSource) {
    let mut object_ids = Vec::new();
    let mut app_name: Option<String> = None;

    for candidate in candidates {
        let Some(name) = candidate
            .raw_path
            .as_deref()
            .and_then(outermost_app_bundle_name)
        else {
            continue;
        };
        if slugify_app_name(&name) != slug {
            continue;
        }
        app_name.get_or_insert_with(|| name.clone());
        object_ids.push(candidate.object_id);
    }

    if object_ids.is_empty() {
        return (None, SystemAudioSource::all_output());
    }

    (
        Some(object_ids),
        SystemAudioSource {
            id: id.to_string(),
            name: app_name.unwrap_or_else(|| slug.to_string()),
        },
    )
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

#[cfg(test)]
mod tests {
    use super::*;

    fn raw_process(pid: i32, bundle_id: Option<&str>, raw_name: Option<&str>) -> RawProcess {
        raw_process_with_path(pid, bundle_id, raw_name, None)
    }

    fn raw_process_with_path(
        pid: i32,
        bundle_id: Option<&str>,
        raw_name: Option<&str>,
        raw_path: Option<&str>,
    ) -> RawProcess {
        RawProcess {
            pid,
            bundle_id: bundle_id.map(str::to_string),
            raw_name: raw_name.map(str::to_string),
            raw_path: raw_path.map(str::to_string),
        }
    }

    #[test]
    fn derive_display_name_humanises_a_bundle_id_when_no_usable_raw_name_exists() {
        let name = derive_display_name(None, Some("com.microsoft.Outlook"), None, 0);

        assert_eq!(name, "Outlook");
        assert_ne!(name, "com.microsoft.Outlook");
    }

    #[test]
    fn derive_display_name_never_surfaces_a_raw_bundle_id_even_as_the_raw_name() {
        let name = derive_display_name(
            None,
            Some("com.apple.audiomxd"),
            Some("com.apple.audiomxd"),
            0,
        );

        assert_eq!(name, "Audiomxd");
    }

    #[test]
    fn derive_display_name_prefers_a_valid_raw_name_over_the_bundle_id() {
        let name = derive_display_name(
            None,
            Some("com.microsoft.Outlook"),
            Some("Microsoft Outlook"),
            0,
        );

        assert_eq!(name, "Microsoft Outlook");
    }

    #[test]
    fn derive_display_name_falls_back_to_process_pid_with_neither_name_nor_bundle_id() {
        let name = derive_display_name(None, None, None, 42);

        assert_eq!(name, "Process 42");
    }

    #[test]
    fn derive_display_name_prefers_the_app_bundle_name_over_everything_else() {
        let name = derive_display_name(
            Some("Microsoft Teams"),
            Some("com.microsoft.teams2.helper"),
            Some("Teams Helper (Renderer)"),
            0,
        );

        assert_eq!(name, "Microsoft Teams");
    }

    #[test]
    fn build_running_application_sources_collapses_shared_bundle_id_pids_into_one_entry() {
        let processes = vec![
            raw_process(100, Some("com.microsoft.teams"), Some("Teams")),
            raw_process(
                101,
                Some("com.microsoft.teams"),
                Some("Teams Helper (Renderer)"),
            ),
            raw_process(102, Some("com.microsoft.teams"), Some("Teams Helper (GPU)")),
        ];

        let sources = build_running_application_sources(processes, /* current_pid */ 1);

        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].id, "app:com.microsoft.teams");
        assert_eq!(sources[0].name, "Teams");
    }

    #[test]
    fn build_running_application_sources_keeps_a_bare_pid_process_with_a_placeholder_name() {
        let processes = vec![raw_process(42, None, None)];

        let sources = build_running_application_sources(processes, /* current_pid */ 1);

        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].id, "app:pid:42");
        assert_eq!(sources[0].name, "Process 42");
    }

    #[test]
    fn build_running_application_sources_names_a_bare_pid_process_from_its_executable_name() {
        let processes = vec![raw_process(42, None, Some("afplay"))];

        let sources = build_running_application_sources(processes, /* current_pid */ 1);

        assert_eq!(sources[0].name, "Afplay");
    }

    #[test]
    fn derive_display_name_title_cases_an_all_lowercase_executable_name() {
        let name = derive_display_name(None, None, Some("firefox"), 0);

        assert_eq!(name, "Firefox");
    }

    #[test]
    fn build_running_application_sources_excludes_the_current_process() {
        let processes = vec![raw_process(1, Some("com.example.self"), Some("Self"))];

        let sources = build_running_application_sources(processes, /* current_pid */ 1);

        assert!(sources.is_empty());
    }

    #[test]
    fn build_running_application_sources_drops_apple_background_services() {
        let processes = vec![
            raw_process(10, Some("com.apple.audiomxd"), None),
            raw_process(11, Some("com.apple.Safari"), Some("Safari")),
        ];

        let sources = build_running_application_sources(processes, /* current_pid */ 1);

        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].name, "Safari");
    }

    #[test]
    fn build_running_application_sources_sorts_alphabetically_case_insensitively() {
        let processes = vec![
            raw_process(10, Some("com.example.zebra"), Some("zebra")),
            raw_process(11, Some("com.example.apple"), Some("Apple")),
            raw_process(12, Some("com.example.mango"), Some("mango")),
        ];

        let sources = build_running_application_sources(processes, /* current_pid */ 1);

        let names: Vec<&str> = sources.iter().map(|source| source.name.as_str()).collect();
        assert_eq!(names, vec!["Apple", "Mango", "Zebra"]);
    }

    #[test]
    fn build_running_application_sources_collapses_distinct_bundle_ids_under_one_app_group() {
        let processes = vec![
            raw_process_with_path(
                200,
                Some("com.microsoft.teams2.modulehost"),
                Some("MSTeams"),
                Some("/Applications/Microsoft Teams.app/Contents/MacOS/MSTeams"),
            ),
            raw_process_with_path(
                201,
                Some("com.microsoft.teams2.helper"),
                Some("Microsoft Teams WebView"),
                Some("/Applications/Microsoft Teams.app/Contents/Frameworks/Microsoft Teams Helper.app/Contents/MacOS/Microsoft Teams Helper"),
            ),
            raw_process_with_path(
                202,
                Some("com.microsoft.teams2.notificationcenter"),
                Some("Notificationcenter"),
                Some("/Applications/Microsoft Teams.app/Contents/Frameworks/Notificationcenter.app/Contents/MacOS/Notificationcenter"),
            ),
        ];

        let sources = build_running_application_sources(processes, /* current_pid */ 1);

        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].id, "app:group:microsoft-teams");
        assert_eq!(sources[0].name, "Microsoft Teams");
    }

    #[test]
    fn build_running_application_sources_groups_a_nested_helper_bundle_under_its_parent_app() {
        let processes = vec![
            raw_process_with_path(
                300,
                Some("org.chromium.Chromium"),
                Some("Chromium"),
                Some("/Applications/Chromium.app/Contents/MacOS/Chromium"),
            ),
            raw_process_with_path(
                301,
                Some("org.chromium.Chromium.helper"),
                Some("Chromium Helper"),
                Some("/Applications/Chromium.app/Contents/Frameworks/Chromium Framework.framework/Versions/Current/Helpers/Chromium Helper.app/Contents/MacOS/Chromium Helper"),
            ),
        ];

        let sources = build_running_application_sources(processes, /* current_pid */ 1);

        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].id, "app:group:chromium");
        assert_eq!(sources[0].name, "Chromium");
        assert_ne!(sources[0].name, "Chromium Helper");
    }

    #[test]
    fn build_running_application_sources_falls_back_to_pid_when_path_has_no_app_bundle() {
        let processes = vec![raw_process_with_path(
            42,
            None,
            Some("afplay"),
            Some("/usr/bin/afplay"),
        )];

        let sources = build_running_application_sources(processes, /* current_pid */ 1);

        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].id, "app:pid:42");
        assert_eq!(sources[0].name, "Afplay");
    }

    #[test]
    fn outermost_app_bundle_name_takes_the_first_app_component_not_the_last() {
        let name = outermost_app_bundle_name(
            "/Applications/Chromium.app/Contents/Frameworks/Chromium Helper.app/Contents/MacOS/Chromium Helper",
        );

        assert_eq!(name.as_deref(), Some("Chromium"));
    }

    #[test]
    fn outermost_app_bundle_name_is_none_without_any_app_component() {
        let name = outermost_app_bundle_name("/usr/bin/afplay");

        assert_eq!(name, None);
    }

    #[test]
    fn slugify_app_name_lowercases_and_dashes_whitespace() {
        assert_eq!(slugify_app_name("Microsoft Teams"), "microsoft-teams");
    }

    #[test]
    fn resolve_group_scope_from_candidates_matches_every_pid_in_the_group() {
        let candidates = vec![
            ScopeCandidate {
                object_id: 10,
                raw_path: Some(
                    "/Applications/Microsoft Teams.app/Contents/MacOS/MSTeams".to_string(),
                ),
            },
            ScopeCandidate {
                object_id: 11,
                raw_path: Some(
                    "/Applications/Microsoft Teams.app/Contents/Frameworks/Microsoft Teams Helper.app/Contents/MacOS/Microsoft Teams Helper".to_string(),
                ),
            },
            ScopeCandidate {
                object_id: 12,
                raw_path: Some("/Applications/Chromium.app/Contents/MacOS/Chromium".to_string()),
            },
        ];

        let (object_ids, source) = resolve_group_scope_from_candidates(
            "app:group:microsoft-teams",
            "microsoft-teams",
            &candidates,
        );

        assert_eq!(object_ids, Some(vec![10, 11]));
        assert_eq!(source.id, "app:group:microsoft-teams");
        assert_eq!(source.name, "Microsoft Teams");
    }

    #[test]
    fn resolve_group_scope_from_candidates_falls_back_to_all_output_for_a_stale_id() {
        let candidates = vec![ScopeCandidate {
            object_id: 10,
            raw_path: Some("/Applications/Chromium.app/Contents/MacOS/Chromium".to_string()),
        }];

        let (object_ids, source) = resolve_group_scope_from_candidates(
            "app:group:microsoft-teams",
            "microsoft-teams",
            &candidates,
        );

        assert_eq!(object_ids, None);
        assert_eq!(source.id, crate::system::ALL_OUTPUT_SOURCE_ID);
    }
}
