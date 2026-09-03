//! One-click update install: the curated, Rust-owned updater calls.
//!
//! ADR 0010 keeps the updater plugin out of the webview's reach — no
//! updater permission appears in `capabilities/default.json` (pinned by
//! `tests/updater_config.rs`), so the UI's "Update" button can only reach
//! the plugin through the two commands here. All of the plugin's powers
//! (check, download, minisign-verify, install, restart) stay behind this
//! Rust boundary.
//!
//! Deliberately a new module rather than more lines in [`super::updates`]:
//! that file is already ~290 lines against the workspace's
//! `too_many_lines` budget, and install carries a different risk profile
//! (it mutates the running app bundle) than a read-only check.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::error::AppError;
use crate::events::{self, UpdateDonePayload, UpdateProgressPayload};
use crate::paths;
use crate::state::AppState;
use crate::update_prefs::{self, InstallDecision};

use super::recording::lock_session;

/// Minimum spacing between [`events::UPDATE_PROGRESS`] emissions. The
/// plugin's chunk callback fires per network read — many times per second
/// on a fast link — while the UI only needs a smooth-enough bar.
pub const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(250);

/// The sentinel `message` Rust pairs with the up-to-date no-op terminal
/// `{success: true, version: null, message: "up-to-date"}`. The UI's
/// `UpdatesFacade` matches this exact string to return the install
/// machine to `'idle'` instead of lying with a "ready" banner — the
/// wire-shape test below pins the literal, so a reword fails Rust-side
/// rather than shipping a silent contract break.
const UP_TO_DATE_MESSAGE: &str = "up-to-date";

/// Single-flight gate: at most one `install_update` may be in flight per
/// process. Two overlapping installs would double-swap the app bundle.
static INSTALL_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// RAII token holding [`INSTALL_IN_FLIGHT`]. Released on EVERY exit path
/// of the command — normal return, early `?`, error arm, panic unwind, and
/// future cancellation (dropped mid-`.await`) all run [`Drop`] — so the
/// gate can never wedge after a failed install.
struct InstallInFlightGuard<'a>(&'a AtomicBool);

impl<'a> InstallInFlightGuard<'a> {
    /// Claims `flag` iff it was `false`; `None` means a run is already in
    /// flight. Acquire on success pairs with the Release store in `drop`.
    fn acquire(flag: &'a AtomicBool) -> Option<Self> {
        flag.compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_ok()
            .then_some(Self(flag))
    }
}

impl Drop for InstallInFlightGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// Pure throttle decision: emit when there is no previous stamp yet, or
/// at least [`PROGRESS_EMIT_INTERVAL`] has elapsed since it.
///
/// Callers must stamp only *after* the emit completes. Stamping before the
/// guarded work is exactly the bug that let a decode throttle elsewhere in
/// this codebase run 40x/sec — the timestamp already existed, so the cap
/// never bound (see the repo-root CLAUDE.md throttle lesson).
fn progress_should_emit(last_emit: Option<Instant>, now: Instant) -> bool {
    match last_emit {
        None => true,
        Some(last) => now.saturating_duration_since(last) >= PROGRESS_EMIT_INTERVAL,
    }
}

/// Download percentage in `0..=100`, or `None` when the server sent no
/// usable `Content-Length`. `None` means the UI shows an indeterminate
/// bar — we never fabricate progress we don't actually have.
fn percent_of(downloaded_bytes: u64, total_bytes: Option<u64>) -> Option<f32> {
    let total = total_bytes.filter(|t| *t > 0)?;
    let ratio = downloaded_bytes as f64 * 100.0 / total as f64;
    Some(ratio.min(100.0) as f32)
}

/// Maps an [`InstallDecision`] refusal to its stable typed [`AppError`] —
/// one home for the refusal vocabulary so the entry gate and the
/// pre-install re-gate can never drift apart. The UI keys its "finish your
/// recording first" banner off [`AppError::Busy`]'s `BUSY` code, so this
/// mapping is wire-visible contract, not prose.
fn refusal_error(decision: InstallDecision) -> Option<AppError> {
    match decision {
        InstallDecision::Run => None,
        InstallDecision::SkipRecording => Some(AppError::Busy(
            "cannot install an update while a recording is in progress",
        )),
        InstallDecision::SkipNoConsent => Some(AppError::Updater(
            "update consent has not been granted".to_string(),
        )),
    }
}

/// Reads the live gates (consent on disk + session lock) and decides.
///
/// The session guard is a temporary dropped at the end of this statement —
/// it must never be held across an `.await`, whose future has to stay
/// `Send` for the async command.
fn check_install_gates(state: &AppState) -> Result<(), AppError> {
    let root = paths::data_root().map_err(|err| AppError::Path(err.to_string()))?;
    let consent = update_prefs::load(&root).consent;
    let is_recording = lock_session(state)?.is_some();
    refusal_error(update_prefs::decide_install(consent, is_recording)).map_or(Ok(()), Err)
}

/// Downloads and installs the newest release the update endpoint
/// advertises, then leaves the actual restart to [`restart_app`].
///
/// Gate order, mirroring [`crate::update_prefs::decide_install`]'s
/// precedence: debug builds refuse before anything else runs; a live
/// recording refuses with [`AppError::Busy`] (ADR 0011 — never touch a
/// session in progress); missing consent refuses as
/// [`AppError::Updater`] (defense-in-depth — same consent vocabulary as
/// [`super::updates::check_for_update`], which skips with
/// `no-consent` instead of erroring because it runs unattended). A
/// single-flight gate refuses a second concurrent invoke with
/// [`AppError::Busy`] — one install may touch the bundle at a time.
///
/// Resolves with the SAME [`UpdateDonePayload`] it emits on
/// `update://done` — the UI reads the terminal outcome off the invoke
/// response; the event is the redundant channel. Gate refusals (which
/// start no download and emit nothing) stay `Err`: the command call itself
/// is the refusal channel there.
#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<UpdateDonePayload, AppError> {
    // Debug builds run from `target/debug/`: the plugin's install step
    // renames/replaces the running bundle in place, which would clobber
    // the dev build directory (and a subsequent `cargo run` would "succeed"
    // against whatever the updater left behind). Dev iteration uses
    // `cargo tauri dev`; refuse before any network or state touch.
    if cfg!(debug_assertions) {
        return Err(AppError::Updater(
            "in-app updates are disabled in debug builds".to_string(),
        ));
    }

    // Single-flight: claim the gate BEFORE any network or state touch. A
    // second concurrent invoke refuses with BUSY; the guard returns the
    // slot on every exit path (see InstallInFlightGuard).
    let _in_flight = InstallInFlightGuard::acquire(&INSTALL_IN_FLIGHT)
        .ok_or(AppError::Busy("an update install is already in progress"))?;

    check_install_gates(&state)?;

    let payload = match download_and_install(&app, &state).await {
        // check() found nothing newer: a successful no-op, not a failure.
        Ok(None) => UpdateDonePayload {
            success: true,
            version: None,
            message: Some(UP_TO_DATE_MESSAGE.to_string()),
        },
        Ok(Some(version)) => UpdateDonePayload {
            success: true,
            version: Some(version),
            message: None,
        },
        Err(err) => {
            emit_done(
                &app,
                UpdateDonePayload {
                    success: false,
                    version: None,
                    message: Some(err.to_string()),
                },
            );
            return Err(err);
        }
    };
    emit_done(&app, payload.clone());
    Ok(payload)
}

/// Restarts the app so a freshly installed update takes over.
///
/// Refuses with [`AppError::Busy`] while a recording session is live —
/// same ADR 0011 invariant as [`install_update`]. No consent gate: a
/// restart is harmless on its own and is also the right follow-up after a
/// manually installed update. Never returns on success: `restart` relaunch
/// kills this process.
#[tauri::command]
pub fn restart_app(app: AppHandle, state: State<'_, AppState>) -> Result<(), AppError> {
    if lock_session(&state)?.is_some() {
        return Err(AppError::Busy(
            "cannot restart while a recording is in progress",
        ));
    }
    // Diverges: `restart` relaunches and kills this process, so the
    // `!` coerces to the command's `Result` — no Ok path exists.
    app.restart()
}

/// The plugin-facing half of [`install_update`], split out so the command
/// body stays inside the line budget and the event mapping has one home.
/// `Ok(Some(version))` = installed, `Ok(None)` = nothing newer.
///
/// Closes the entry-gate TOCTOU race: the download can take tens of
/// seconds, during which the user can start a recording. The gates are
/// therefore re-checked IMMEDIATELY before `update.install(&bytes)` — the
/// only point where the bundle is actually mutated. A residual microsecond
/// window (re-gate → synchronous `install()`) remains and is accepted
/// deliberately: closing it fully would require holding the session lock
/// across the bundle swap, blocking `start_recording` for its duration. On
/// re-gate refusal the error propagates to the command's `Err` arm, which
/// emits `UPDATE_DONE{success:false}` and returns [`AppError::Busy`] — the
/// download is discarded, the bundle is never touched.
async fn download_and_install(
    app: &AppHandle,
    state: &State<'_, AppState>,
) -> Result<Option<String>, AppError> {
    let updater = app
        .updater()
        .map_err(|err| AppError::Updater(err.to_string()))?;
    let update = updater
        .check()
        .await
        .map_err(|err| AppError::Updater(err.to_string()))?;
    let Some(update) = update else {
        return Ok(None);
    };

    let bytes = download_with_progress(app, &update).await?;
    // Re-gate after the (slow) download, before the (mutating) install —
    // see the TOCTOU note above.
    check_install_gates(state)?;
    // minisign verification already happened inside `download` (see
    // `download_with_progress`); an unsigned or tampered artifact never
    // reaches this line.
    update
        .install(&bytes)
        .map_err(|err| AppError::Updater(err.to_string()))?;
    Ok(Some(update.version))
}

/// Downloads the update, re-emitting the plugin's per-chunk callback as
/// throttled [`events::UPDATE_PROGRESS`] events with cumulative byte
/// counts.
///
/// The plugin reports `chunk.len()` per network read, not a running total,
/// so the accumulation lives here. Signature verification happens inside
/// `download()` — after the last chunk, before `Ok` — so a tampered
/// payload can never be installed by the caller.
async fn download_with_progress(app: &AppHandle, update: &Update) -> Result<Vec<u8>, AppError> {
    let mut downloaded_bytes: u64 = 0;
    let mut last_emit: Option<Instant> = None;
    update
        .download(
            |chunk_len, total_bytes| {
                downloaded_bytes = downloaded_bytes.saturating_add(chunk_len as u64);
                if progress_should_emit(last_emit, Instant::now()) {
                    let _ = app.emit(
                        events::UPDATE_PROGRESS,
                        UpdateProgressPayload {
                            downloaded_bytes,
                            total_bytes,
                            percent: percent_of(downloaded_bytes, total_bytes),
                        },
                    );
                    // Stamp AFTER the emit — see progress_should_emit.
                    last_emit = Some(Instant::now());
                }
            },
            || {},
        )
        .await
        .map_err(|err| AppError::Updater(err.to_string()))
}

fn emit_done(app: &AppHandle, payload: UpdateDonePayload) {
    let _ = app.emit(events::UPDATE_DONE, payload);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_emits_immediately_with_no_previous_stamp() {
        assert!(progress_should_emit(None, Instant::now()));
    }

    #[test]
    fn progress_is_silent_within_the_interval() {
        let last = Instant::now();
        assert!(!progress_should_emit(
            Some(last),
            last + Duration::from_millis(249)
        ));
    }

    #[test]
    fn progress_emits_once_the_interval_has_elapsed() {
        let last = Instant::now();
        assert!(progress_should_emit(
            Some(last),
            last + PROGRESS_EMIT_INTERVAL
        ));
    }

    #[test]
    fn percent_is_none_without_a_usable_total() {
        assert_eq!(percent_of(500, None), None);
        assert_eq!(percent_of(500, Some(0)), None);
    }

    #[test]
    fn percent_is_the_cumulative_share_capped_at_100() {
        assert_eq!(percent_of(500, Some(1000)), Some(50.0));
        assert_eq!(percent_of(1000, Some(1000)), Some(100.0));
        // A server lying about Content-Length must never read as >100%.
        assert_eq!(percent_of(1500, Some(1000)), Some(100.0));
    }

    /// Compile-time pin of the `install_update` wire contract: the command
    /// resolves with the SAME [`UpdateDonePayload`] it emits on
    /// `update://done` — never `()`/`null`. This is the regression that
    /// shipped green once: the UI adapter reads `dto.success` off the
    /// resolve value, so a `Result<(), _>` signature is a guaranteed
    /// TypeError on every successful install. The `UpdateDonePayload`
    /// annotation below stops the build if the signature ever drifts back.
    /// (The future is never awaited — no `AppHandle` exists in a unit
    /// test; type-checking the call expression is the whole point.)
    #[test]
    fn install_update_resolves_with_the_done_payload() {
        async fn check_contract(app: AppHandle, state: State<'_, AppState>) {
            let payload: UpdateDonePayload = install_update(app, state).await.expect("ok");
            // The command result must also be serializable — it is what
            // `invoke` delivers to the webview.
            let _json = serde_json::to_value(payload).expect("serializes");
        }
        let _ = check_contract;
    }

    #[test]
    fn refusal_error_maps_each_gate_to_its_stable_app_error() {
        // The re-gate (TOCTOU) refusal must surface the SAME typed errors
        // as the entry gate: UI Busy detection keys off AppError::Busy's
        // "BUSY" code, never the prose.
        assert!(refusal_error(InstallDecision::Run).is_none());
        assert!(matches!(
            refusal_error(InstallDecision::SkipRecording),
            Some(AppError::Busy(_))
        ));
        assert!(matches!(
            refusal_error(InstallDecision::SkipNoConsent),
            Some(AppError::Updater(_))
        ));
    }

    #[test]
    fn install_in_flight_gate_admits_one_caller_and_releases_on_drop() {
        // Single-flight, asserted against a local flag (the process-wide
        // INSTALL_IN_FLIGHT shares the same code path): first claim wins,
        // a concurrent claim is refused, and Drop gives the slot back —
        // including on the error/unwind/cancellation paths the command
        // takes via `?`.
        let flag = AtomicBool::new(false);
        let first = InstallInFlightGuard::acquire(&flag);
        assert!(first.is_some(), "idle gate must admit the first caller");
        assert!(
            InstallInFlightGuard::acquire(&flag).is_none(),
            "a second concurrent install must be refused"
        );
        drop(first);
        let third = InstallInFlightGuard::acquire(&flag);
        assert!(
            third.is_some(),
            "the gate must be re-acquirable after the holder drops"
        );
    }

    /// Pins the wire shape the parallel UI work is built against: exact
    /// camelCase keys, all present (nulls included — no
    /// `skip_serializing_if`), so the Angular adapter can read
    /// `downloadedBytes`/`totalBytes`/`percent` and
    /// `success`/`version`/`message` without a translation layer.
    #[test]
    fn update_event_payloads_use_the_documented_camel_case_wire_shape() {
        let progress = serde_json::to_value(UpdateProgressPayload {
            downloaded_bytes: 1234,
            total_bytes: None,
            percent: None,
        })
        .expect("serializes");
        assert_eq!(
            progress,
            serde_json::json!({"downloadedBytes": 1234, "totalBytes": null, "percent": null})
        );

        let done = serde_json::to_value(UpdateDonePayload {
            success: true,
            version: Some("0.3.0".to_string()),
            message: None,
        })
        .expect("serializes");
        assert_eq!(
            done,
            serde_json::json!({"success": true, "version": "0.3.0", "message": null})
        );

        // The up-to-date sentinel the UI facade matches on to land
        // 'idle' — pinned as a raw literal, so renaming
        // UP_TO_DATE_MESSAGE fails HERE, not in a user-facing
        // "Installed, version unknown" banner.
        assert_eq!(UP_TO_DATE_MESSAGE, "up-to-date");
        let no_op = serde_json::to_value(UpdateDonePayload {
            success: true,
            version: None,
            message: Some(UP_TO_DATE_MESSAGE.to_string()),
        })
        .expect("serializes");
        assert_eq!(
            no_op,
            serde_json::json!({"success": true, "version": null, "message": "up-to-date"})
        );
    }
}
