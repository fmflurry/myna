//! Guards the network gate in front of `check_for_update`: the update
//! checker must not reach the network unless the user has granted
//! consent, no meeting is recording, and (for automatic calls) the 24h
//! throttle has elapsed. Every scenario here drives
//! `commands::updates::decide_and_check` with a recording
//! [`UpdateFetcher`] test double so "did we call the network" is a plain
//! invocation count, never an actual HTTP request.

use std::sync::atomic::{AtomicUsize, Ordering};

use myna_app::commands::updates::{
    decide_and_check, map_check_result, RemoteVersion, UpdateFetcher,
};
use myna_app::error::AppError;
use myna_app::update_prefs::{UpdateConsent, UpdatePrefs};
use time::{Duration, OffsetDateTime};

/// Canned response returned by every [`RecordingFetcher::fetch`] call,
/// paired with a call counter so tests can assert exactly how many times
/// (if any) the network boundary was crossed.
enum CannedOutcome {
    UpToDate,
    Failed(String),
}

struct RecordingFetcher {
    calls: AtomicUsize,
    outcome: CannedOutcome,
}

impl RecordingFetcher {
    fn new(outcome: CannedOutcome) -> Self {
        Self {
            calls: AtomicUsize::new(0),
            outcome,
        }
    }

    fn call_count(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl UpdateFetcher for RecordingFetcher {
    fn fetch(&self) -> Result<Option<RemoteVersion>, AppError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        match &self.outcome {
            CannedOutcome::UpToDate => Ok(None),
            CannedOutcome::Failed(message) => Err(AppError::Updater(message.clone())),
        }
    }
}

fn prefs_with(consent: UpdateConsent, last_check_at: Option<OffsetDateTime>) -> UpdatePrefs {
    UpdatePrefs {
        consent,
        last_check_at,
    }
}

#[test]
fn does_not_fetch_when_consent_is_unset() {
    let fetcher = RecordingFetcher::new(CannedOutcome::UpToDate);
    let mut prefs = prefs_with(UpdateConsent::Unset, None);

    decide_and_check(
        &fetcher,
        &mut prefs,
        false,
        OffsetDateTime::now_utc(),
        false,
    );

    assert_eq!(
        fetcher.call_count(),
        0,
        "unset consent must never reach the network"
    );
}

#[test]
fn does_not_fetch_when_consent_is_declined() {
    let fetcher = RecordingFetcher::new(CannedOutcome::UpToDate);
    let mut prefs = prefs_with(UpdateConsent::Declined, None);

    decide_and_check(
        &fetcher,
        &mut prefs,
        false,
        OffsetDateTime::now_utc(),
        false,
    );

    assert_eq!(
        fetcher.call_count(),
        0,
        "declined consent must never reach the network"
    );
}

#[test]
fn does_not_fetch_while_recording() {
    let fetcher = RecordingFetcher::new(CannedOutcome::UpToDate);
    let mut prefs = prefs_with(UpdateConsent::Granted, None);

    decide_and_check(&fetcher, &mut prefs, true, OffsetDateTime::now_utc(), false);

    assert_eq!(
        fetcher.call_count(),
        0,
        "a live recording must never be interrupted by update-check network I/O"
    );
}

#[test]
fn fetches_exactly_once_when_granted_idle_and_unthrottled() {
    let fetcher = RecordingFetcher::new(CannedOutcome::UpToDate);
    let mut prefs = prefs_with(UpdateConsent::Granted, None);

    decide_and_check(
        &fetcher,
        &mut prefs,
        false,
        OffsetDateTime::now_utc(),
        false,
    );

    assert_eq!(fetcher.call_count(), 1);
}

#[test]
fn second_automatic_call_within_24h_is_throttled_with_zero_fetches() {
    let fetcher = RecordingFetcher::new(CannedOutcome::UpToDate);
    let now = OffsetDateTime::now_utc();
    let mut prefs = prefs_with(UpdateConsent::Granted, None);

    // First call runs and stamps last_check_at.
    decide_and_check(&fetcher, &mut prefs, false, now, false);
    assert_eq!(fetcher.call_count(), 1);

    // A second automatic call an hour later is throttled: no new fetch.
    let later = now + Duration::hours(1);
    let dto = decide_and_check(&fetcher, &mut prefs, false, later, false);

    assert_eq!(
        fetcher.call_count(),
        1,
        "throttled call must not reach the network"
    );
    assert_eq!(dto.status, myna_app::dto::UpdateCheckStatus::Skipped);
    assert_eq!(dto.reason, Some(myna_app::dto::UpdateSkipReason::Throttled));
}

#[test]
fn manual_bypasses_the_throttle_but_not_the_consent_gate() {
    let now = OffsetDateTime::now_utc();

    // Manual, but consent was never granted: still zero fetches.
    let fetcher = RecordingFetcher::new(CannedOutcome::UpToDate);
    let mut declined_prefs = prefs_with(UpdateConsent::Declined, None);
    decide_and_check(&fetcher, &mut declined_prefs, false, now, true);
    assert_eq!(
        fetcher.call_count(),
        0,
        "manual must not bypass the consent gate"
    );

    // Manual, granted, and recently checked: throttle is bypassed, one fetch.
    let fetcher = RecordingFetcher::new(CannedOutcome::UpToDate);
    let recent = now - Duration::hours(1);
    let mut granted_prefs = prefs_with(UpdateConsent::Granted, Some(recent));
    decide_and_check(&fetcher, &mut granted_prefs, false, now, true);
    assert_eq!(fetcher.call_count(), 1, "manual must bypass the throttle");
}

#[test]
fn last_check_at_is_stamped_even_when_the_fetch_fails() {
    let fetcher = RecordingFetcher::new(CannedOutcome::Failed("network unreachable".to_string()));
    let now = OffsetDateTime::now_utc();
    let mut prefs = prefs_with(UpdateConsent::Granted, None);

    let dto = decide_and_check(&fetcher, &mut prefs, false, now, false);

    assert_eq!(fetcher.call_count(), 1);
    assert_eq!(
        prefs.last_check_at,
        Some(now),
        "last_check_at must be stamped after a failed fetch, to avoid a retry storm"
    );
    assert_eq!(dto.status, myna_app::dto::UpdateCheckStatus::Failed);
}

#[test]
fn unmatched_platform_key_maps_to_up_to_date_not_failed() {
    // A manifest with no matching platform key (e.g. an Intel Mac when
    // only darwin-aarch64 is published) must never surface as an error —
    // a non-arm64 user must never see a scary error banner.
    let targets_not_found = Err(tauri_plugin_updater::Error::TargetsNotFound(vec![
        "darwin-x86_64".to_string(),
    ]));
    assert!(matches!(map_check_result(targets_not_found), Ok(None)));

    let target_not_found = Err(tauri_plugin_updater::Error::TargetNotFound(
        "darwin-x86_64".to_string(),
    ));
    assert!(matches!(map_check_result(target_not_found), Ok(None)));
}
