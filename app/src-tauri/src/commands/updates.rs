//! Update-check consent commands, and the gated `check_for_update` command
//! itself.
//!
//! `update_consent`/`set_update_consent` are pure IPC glue over
//! [`crate::update_prefs`]: no network call. `check_for_update` is the one
//! command in this crate that may reach the network — and only when
//! [`update_prefs::decide_check`] says `Run`. The gate ([`gate`]) and the
//! post-fetch bookkeeping ([`run_check`]) are pure and shared between the
//! async command (which awaits the real `tauri-plugin-updater` call in
//! [`fetch_remote`]) and [`decide_and_check`], which takes an injectable
//! [`UpdateFetcher`] so the consent/recording gate can be exercised in
//! tests without ever constructing a live [`tauri::AppHandle`] or touching
//! the network (see `tests/update_gate.rs`).

use std::time::Duration;

use tauri::{AppHandle, State};
use tauri_plugin_updater::UpdaterExt;
use time::OffsetDateTime;

use crate::dto::{UpdateCheckDto, UpdateCheckStatus, UpdateSkipReason};
use crate::error::AppError;
use crate::paths;
use crate::state::AppState;
use crate::update_prefs::{self, CheckDecision, UpdateConsent, UpdatePrefs};

use super::recording::lock_session;

/// Returns the user's current update-check consent: `"unset"`, `"granted"`,
/// or `"declined"`.
///
/// `_app` isn't used to resolve the data root today (`paths::data_root`
/// resolves `~/myna` without an `AppHandle`), but every other IPC command in
/// this crate takes one, and future app-scoped root resolution should not
/// have to change this signature.
#[tauri::command]
pub fn update_consent(_app: AppHandle) -> Result<String, AppError> {
    let root = paths::data_root().map_err(|err| AppError::Path(err.to_string()))?;
    Ok(consent_to_wire(update_prefs::load(&root).consent))
}

/// Sets the user's update-check consent. `consent` must be exactly one of
/// `"unset"`, `"granted"`, `"declined"`; anything else fails fast with a
/// typed [`AppError::Store`] rather than silently defaulting to `Unset`.
#[tauri::command]
pub fn set_update_consent(_app: AppHandle, consent: String) -> Result<(), AppError> {
    let parsed = consent_from_wire(&consent)?;
    let root = paths::data_root().map_err(|err| AppError::Path(err.to_string()))?;
    let mut prefs = update_prefs::load(&root);
    prefs.consent = parsed;
    update_prefs::save(&root, &prefs)
}

fn consent_to_wire(consent: UpdateConsent) -> String {
    match consent {
        UpdateConsent::Unset => "unset",
        UpdateConsent::Granted => "granted",
        UpdateConsent::Declined => "declined",
    }
    .to_string()
}

fn consent_from_wire(raw: &str) -> Result<UpdateConsent, AppError> {
    match raw {
        "unset" => Ok(UpdateConsent::Unset),
        "granted" => Ok(UpdateConsent::Granted),
        "declined" => Ok(UpdateConsent::Declined),
        other => Err(AppError::Store(format!(
            "invalid update consent value: {other:?}"
        ))),
    }
}

/// A remote release, decoupled from `tauri_plugin_updater::Update` so
/// [`UpdateFetcher`] is injectable and unit-testable without a live
/// `AppHandle` or network access.
#[derive(Debug, Clone, PartialEq)]
pub struct RemoteVersion {
    pub version: String,
    pub notes: Option<String>,
    pub download_url: String,
}

/// Abstraction over "ask the update server whether a newer version
/// exists", so [`decide_and_check`]'s consent/recording gate can be tested
/// without ever reaching the network. Production does not go through this
/// trait: the command awaits [`fetch_remote`] directly (the plugin's
/// `check()` is async, and a sync trait would force a `block_on`).
pub trait UpdateFetcher {
    fn fetch(&self) -> Result<Option<RemoteVersion>, AppError>;
}

/// Upper bound on one update-check round-trip. `tauri-plugin-updater`
/// defaults to *no* timeout, so without this a stalled connection at
/// launch would leave the check — and its `checking` spinner — hanging
/// indefinitely.
pub const UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(30);

/// Production fetch: the one place in this crate that reaches the network.
/// Only ever awaited after [`gate`] returned [`Gate::Run`]. Builds the
/// updater from the plugin's `tauri.conf.json` config plus
/// [`UPDATE_CHECK_TIMEOUT`], then awaits `check()` — no `block_on`.
async fn fetch_remote(app: &AppHandle) -> Result<Option<RemoteVersion>, AppError> {
    let updater = app
        .updater_builder()
        .timeout(UPDATE_CHECK_TIMEOUT)
        .build()
        .map_err(|err| AppError::Updater(err.to_string()))?;
    map_check_result(updater.check().await)
}

/// Pure mapping from the plugin's `check()` outcome to [`UpdateFetcher`]'s
/// result shape.
///
/// An unmatched platform key (e.g. an Intel Mac when only
/// `darwin-aarch64` is published) surfaces from the plugin as
/// `Error::TargetNotFound`/`Error::TargetsNotFound`, not as a missing
/// release — but it must never read as a failure to the user. Collapsing
/// it to `Ok(None)` here means it flows through exactly like a genuine
/// "nothing newer" response: `up-to-date`, never `failed`.
pub fn map_check_result(
    result: tauri_plugin_updater::Result<Option<tauri_plugin_updater::Update>>,
) -> Result<Option<RemoteVersion>, AppError> {
    match result {
        Ok(Some(update)) => Ok(Some(RemoteVersion {
            version: update.version,
            notes: update.body,
            download_url: update.download_url.to_string(),
        })),
        Ok(None) => Ok(None),
        Err(tauri_plugin_updater::Error::TargetNotFound(_))
        | Err(tauri_plugin_updater::Error::TargetsNotFound(_)) => Ok(None),
        Err(err) => Err(AppError::Updater(err.to_string())),
    }
}

fn skipped_dto(reason: UpdateSkipReason) -> UpdateCheckDto {
    UpdateCheckDto {
        status: UpdateCheckStatus::Skipped,
        version: None,
        notes: None,
        download_url: None,
        reason: Some(reason),
        message: None,
    }
}

fn available_dto(remote: RemoteVersion) -> UpdateCheckDto {
    UpdateCheckDto {
        status: UpdateCheckStatus::Available,
        version: Some(remote.version),
        notes: remote.notes,
        download_url: Some(remote.download_url),
        reason: None,
        message: None,
    }
}

fn up_to_date_dto() -> UpdateCheckDto {
    UpdateCheckDto {
        status: UpdateCheckStatus::UpToDate,
        version: None,
        notes: None,
        download_url: None,
        reason: None,
        message: None,
    }
}

fn failed_dto(message: String) -> UpdateCheckDto {
    UpdateCheckDto {
        status: UpdateCheckStatus::Failed,
        version: None,
        notes: None,
        download_url: None,
        reason: None,
        message: Some(message),
    }
}

/// What one check pass produced: the wire DTO the webview receives, plus —
/// when the fetch failed — the typed error behind the `failed` DTO so the
/// `#[tauri::command]` wrapper can log it. The wire contract is unchanged
/// (the UI still only sees the DTO); the error rides alongside because a
/// `failed` DTO is banner-silent by design, which used to make a broken
/// updater completely invisible.
#[derive(Debug)]
pub struct CheckOutcome {
    pub dto: UpdateCheckDto,
    pub error: Option<AppError>,
}

fn skipped_outcome(reason: UpdateSkipReason) -> CheckOutcome {
    CheckOutcome {
        dto: skipped_dto(reason),
        error: None,
    }
}

/// Verdict of the consent/recording gate: either a ready-made `skipped`
/// outcome (the network must not be touched) or permission to fetch.
enum Gate {
    Skip(CheckOutcome),
    Run,
}

/// The consent/recording gate shared by the async command and
/// [`decide_and_check`] — see [`update_prefs::decide_check`] for the exact
/// precedence. `manual` is still accepted (part of the IPC shape) but no
/// longer gates anything: every consented, idle call checks.
fn gate(prefs: &UpdatePrefs, is_recording: bool, now: OffsetDateTime, manual: bool) -> Gate {
    match update_prefs::decide_check(
        prefs.consent,
        prefs.last_check_at,
        is_recording,
        now,
        manual,
    ) {
        CheckDecision::SkipNoConsent => Gate::Skip(skipped_outcome(UpdateSkipReason::NoConsent)),
        CheckDecision::SkipRecording => Gate::Skip(skipped_outcome(UpdateSkipReason::Recording)),
        CheckDecision::Run => Gate::Run,
    }
}

/// Maps an already-performed fetch to its [`CheckOutcome`], stamping
/// `prefs.last_check_at = Some(now)` only on success. Stamping after
/// (never before) the call is deliberate: stamping first is exactly the
/// bug that let a decode throttle elsewhere in this codebase run 40x/sec,
/// because the cap never bound. A failed fetch leaves the timestamp
/// untouched and surfaces the typed error next to the `failed` DTO.
fn run_check(
    fetched: Result<Option<RemoteVersion>, AppError>,
    prefs: &mut UpdatePrefs,
    now: OffsetDateTime,
) -> CheckOutcome {
    match fetched {
        Ok(Some(remote)) => {
            prefs.last_check_at = Some(now);
            CheckOutcome {
                dto: available_dto(remote),
                error: None,
            }
        }
        Ok(None) => {
            prefs.last_check_at = Some(now);
            CheckOutcome {
                dto: up_to_date_dto(),
                error: None,
            }
        }
        Err(err) => CheckOutcome {
            dto: failed_dto(err.to_string()),
            error: Some(err),
        },
    }
}

/// Full decision-and-maybe-fetch orchestration behind [`check_for_update`],
/// minus the `AppHandle`/filesystem plumbing — split out so tests can drive
/// the consent/recording gate with an in-memory [`UpdatePrefs`]
/// and a recording [`UpdateFetcher`] test double, and assert exactly how
/// many times `fetch()` ran. `fetcher.fetch()` is reached only when
/// [`gate`] returns [`Gate::Run`]; every skip returns straight from the
/// match without touching `fetcher`.
pub fn decide_and_check(
    fetcher: &dyn UpdateFetcher,
    prefs: &mut UpdatePrefs,
    is_recording: bool,
    now: OffsetDateTime,
    manual: bool,
) -> CheckOutcome {
    match gate(prefs, is_recording, now, manual) {
        Gate::Skip(outcome) => outcome,
        Gate::Run => run_check(fetcher.fetch(), prefs, now),
    }
}

/// Checks for an update, gated by the user's consent and current recording
/// state — see [`update_prefs::decide_check`] for the exact precedence.
/// Every consented, idle call checks (no once-a-day throttle). Never
/// reaches the network unless consent is `Granted`: [`fetch_remote`] is
/// awaited only after [`gate`] returned [`Gate::Run`].
///
/// Genuinely async: the network round-trip is awaited on the runtime
/// (bounded by [`UPDATE_CHECK_TIMEOUT`]) instead of blocking the command
/// thread. The session lock is taken and released before the first
/// `.await` — the guard must never be held across it.
#[tauri::command]
pub async fn check_for_update(
    app: AppHandle,
    state: State<'_, AppState>,
    manual: bool,
) -> Result<UpdateCheckDto, AppError> {
    let root = paths::data_root().map_err(|err| AppError::Path(err.to_string()))?;
    let mut prefs = update_prefs::load(&root);
    let is_recording = lock_session(&state)?.is_some();
    let now = OffsetDateTime::now_utc();

    let outcome = match gate(&prefs, is_recording, now, manual) {
        Gate::Skip(outcome) => outcome,
        Gate::Run => run_check(fetch_remote(&app).await, &mut prefs, now),
    };
    if let Some(err) = &outcome.error {
        eprintln!("myna-app: update check failed: {err}");
    }

    update_prefs::save(&root, &prefs)?;
    Ok(outcome.dto)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn consent_from_wire_accepts_exactly_the_three_documented_values() {
        assert_eq!(
            consent_from_wire("unset").expect("unset should parse"),
            UpdateConsent::Unset
        );
        assert_eq!(
            consent_from_wire("granted").expect("granted should parse"),
            UpdateConsent::Granted
        );
        assert_eq!(
            consent_from_wire("declined").expect("declined should parse"),
            UpdateConsent::Declined
        );
    }

    #[test]
    fn consent_from_wire_rejects_anything_else() {
        let result = consent_from_wire("Granted");
        assert!(
            matches!(result, Err(AppError::Store(_))),
            "expected a typed Store error for an out-of-vocabulary value, got {result:?}"
        );
    }

    #[test]
    fn consent_to_wire_round_trips_through_consent_from_wire() {
        for consent in [
            UpdateConsent::Unset,
            UpdateConsent::Granted,
            UpdateConsent::Declined,
        ] {
            let wire = consent_to_wire(consent);
            assert_eq!(
                consent_from_wire(&wire).expect("round trip parses"),
                consent
            );
        }
    }
}
