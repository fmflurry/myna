//! Update-check consent commands, and the gated `check_for_update` command
//! itself.
//!
//! `update_consent`/`set_update_consent` are pure IPC glue over
//! [`crate::update_prefs`]: no network call. `check_for_update` is the one
//! command in this crate that may reach the network — and only when
//! [`update_prefs::decide_check`] says `Run`. The actual
//! `tauri-plugin-updater` call is hidden behind [`UpdateFetcher`] so the
//! consent/recording/throttle gate can be exercised in tests without ever
//! constructing a live [`tauri::AppHandle`] or touching the network (see
//! `tests/update_gate.rs`).

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
/// exists", so [`decide_and_check`]'s consent/recording/throttle gate can
/// be tested without ever reaching the network. The production
/// implementation ([`TauriUpdateFetcher`]) wraps the real
/// `tauri-plugin-updater` call.
pub trait UpdateFetcher {
    fn fetch(&self) -> Result<Option<RemoteVersion>, AppError>;
}

/// Production [`UpdateFetcher`]: wraps `app.updater()?.check()`.
struct TauriUpdateFetcher<'a> {
    app: &'a AppHandle,
}

impl UpdateFetcher for TauriUpdateFetcher<'_> {
    fn fetch(&self) -> Result<Option<RemoteVersion>, AppError> {
        let updater = self
            .app
            .updater()
            .map_err(|err| AppError::Updater(err.to_string()))?;
        map_check_result(tauri::async_runtime::block_on(updater.check()))
    }
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

/// Calls `fetcher.fetch()` and unconditionally stamps
/// `prefs.last_check_at = Some(now)` immediately after it returns —
/// success or failure — before mapping the result to a DTO. Stamping
/// after (never before) the call is deliberate: stamping first is exactly
/// the bug that let a decode throttle elsewhere in this codebase run
/// 40x/sec, because the cap never bound.
fn run_check(
    fetcher: &dyn UpdateFetcher,
    prefs: &mut UpdatePrefs,
    now: OffsetDateTime,
) -> UpdateCheckDto {
    let result = fetcher.fetch();
    prefs.last_check_at = Some(now);
    match result {
        Ok(Some(remote)) => available_dto(remote),
        Ok(None) => up_to_date_dto(),
        Err(err) => failed_dto(err.to_string()),
    }
}

/// Full decision-and-maybe-fetch orchestration behind [`check_for_update`],
/// minus the `AppHandle`/filesystem plumbing — split out so tests can drive
/// the consent/recording/throttle gate with an in-memory [`UpdatePrefs`]
/// and a recording [`UpdateFetcher`] test double, and assert exactly how
/// many times `fetch()` ran. `fetcher.fetch()` is reached only when
/// [`update_prefs::decide_check`] returns [`CheckDecision::Run`]; every
/// `Skip*` decision returns straight from the match without touching
/// `fetcher`.
pub fn decide_and_check(
    fetcher: &dyn UpdateFetcher,
    prefs: &mut UpdatePrefs,
    is_recording: bool,
    now: OffsetDateTime,
    manual: bool,
) -> UpdateCheckDto {
    match update_prefs::decide_check(
        prefs.consent,
        prefs.last_check_at,
        is_recording,
        now,
        manual,
    ) {
        CheckDecision::SkipNoConsent => skipped_dto(UpdateSkipReason::NoConsent),
        CheckDecision::SkipThrottled => skipped_dto(UpdateSkipReason::Throttled),
        CheckDecision::SkipRecording => skipped_dto(UpdateSkipReason::Recording),
        CheckDecision::Run => run_check(fetcher, prefs, now),
    }
}

/// Checks for an update, gated by the user's consent, current recording
/// state, and (for non-manual calls) the 24h throttle — see
/// [`update_prefs::decide_check`] for the exact precedence. Never reaches
/// the network unless consent is `Granted`: every `Skip*` branch of
/// [`decide_and_check`] returns before `fetcher.fetch()` is ever called.
#[tauri::command]
pub fn check_for_update(
    app: AppHandle,
    state: State<'_, AppState>,
    manual: bool,
) -> Result<UpdateCheckDto, AppError> {
    let root = paths::data_root().map_err(|err| AppError::Path(err.to_string()))?;
    let mut prefs = update_prefs::load(&root);
    let is_recording = lock_session(&state)?.is_some();
    let now = OffsetDateTime::now_utc();

    let fetcher = TauriUpdateFetcher { app: &app };
    let dto = decide_and_check(&fetcher, &mut prefs, is_recording, now, manual);

    update_prefs::save(&root, &prefs)?;
    Ok(dto)
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
