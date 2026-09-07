//! Update-check consent preferences, persisted to
//! `<data_root>/preferences.json` under the `"updates"` key this module
//! owns.
//!
//! This module has no network code and knows nothing about the updater
//! plugin (`tauri-plugin-updater` lands in a later phase, once a signing
//! key exists) — it only answers "has the user consented to a check?" and
//! "may we run one right now?".

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::OffsetDateTime;

use crate::error::AppError;
use crate::paths;

const PREFERENCES_FILE: &str = "preferences.json";
const UPDATES_KEY: &str = "updates";

/// User consent to Myna checking for updates over the network.
///
/// `Unset` is the safe default — no network egress happens (see
/// [`decide_check`]) until the user explicitly grants consent via a
/// first-run prompt. Any failure to parse a persisted value also collapses
/// to `Unset`, never to `Granted`; consent must be given, it is never
/// inferred from ambiguous on-disk state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdateConsent {
    #[default]
    Unset,
    Granted,
    Declined,
}

/// Persisted update-checking preferences.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct UpdatePrefs {
    pub consent: UpdateConsent,
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub last_check_at: Option<OffsetDateTime>,
}

/// Loads update preferences from `<root>/preferences.json`.
///
/// Never errors and never panics: a missing file, a file that isn't valid
/// JSON (corrupt or truncated), a file that is unreadable, or a file whose
/// `"updates"` value doesn't match [`UpdatePrefs`]'s shape all yield
/// [`UpdatePrefs::default`] — `Unset` consent, no last-check timestamp. A
/// launch must never fail, and must never accidentally start with implicit
/// consent, because a preferences file failed to parse.
pub fn load(root: &Path) -> UpdatePrefs {
    let path = root.join(PREFERENCES_FILE);
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(_) => return UpdatePrefs::default(),
    };
    let Ok(root_value) = serde_json::from_str::<Value>(&raw) else {
        return UpdatePrefs::default();
    };
    root_value
        .get(UPDATES_KEY)
        .cloned()
        .and_then(|updates| serde_json::from_value(updates).ok())
        .unwrap_or_default()
}

/// Persists `prefs` under the `"updates"` key of `<root>/preferences.json`,
/// preserving any unrelated top-level keys already present in the file (a
/// missing or corrupt file is treated as an empty object rather than
/// failing the save). Writes via the existing owner-only (`0600`) helper, so
/// the file never has a world- or group-readable window.
pub fn save(root: &Path, prefs: &UpdatePrefs) -> Result<(), AppError> {
    let path = root.join(PREFERENCES_FILE);

    let mut root_map = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| match value {
            Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default();

    let updates_value =
        serde_json::to_value(prefs).map_err(|err| AppError::Store(err.to_string()))?;
    root_map.insert(UPDATES_KEY.to_string(), updates_value);

    paths::create_dir_all_0700(root)?;
    let json = serde_json::to_string_pretty(&Value::Object(root_map))
        .map_err(|err| AppError::Store(err.to_string()))?;
    paths::write_0600(&path, json.as_bytes())?;
    Ok(())
}

/// Outcome of asking "may we check for updates right now?".
///
/// There is deliberately no throttle arm: every app start with granted
/// consent and no live recording checks exactly once (the 24h
/// once-a-day throttle was removed — it forced users back onto the
/// manual "check updates" button). Only the two hard invariants remain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckDecision {
    /// Go ahead and check.
    Run,
    /// The user has not granted consent (or declined it).
    SkipNoConsent,
    /// A meeting is currently recording; do not perform network I/O now.
    SkipRecording,
}

/// Pure decision of whether an update check may run right now.
///
/// Precedence, first match wins:
/// 1. `consent != Granted` -> [`CheckDecision::SkipNoConsent`]
/// 2. `is_recording` -> [`CheckDecision::SkipRecording`]
/// 3. otherwise -> [`CheckDecision::Run`]
///
/// `last_check_at`, `now`, and `manual` are retained (prefixed) so the
/// `check_for_update` IPC shape and existing call sites keep compiling —
/// they no longer gate anything. Every consented, idle launch checks.
///
/// Pure and side-effect free — it reads no clock and touches no disk. The
/// caller owns stamping `last_check_at`, and must only do so *after* the
/// check actually completes, and only on success — never before, and never
/// on failure: stamping first is exactly the bug that let a decode
/// throttle elsewhere in this codebase run 40x/sec because the cap never
/// bound (the timestamp existed before the guarded work ran, so every
/// concurrent caller saw "not throttled yet").
pub fn decide_check(
    consent: UpdateConsent,
    _last_check_at: Option<OffsetDateTime>,
    is_recording: bool,
    _now: OffsetDateTime,
    _manual: bool,
) -> CheckDecision {
    if consent != UpdateConsent::Granted {
        return CheckDecision::SkipNoConsent;
    }
    if is_recording {
        return CheckDecision::SkipRecording;
    }
    CheckDecision::Run
}

/// Outcome of asking "may we install a downloaded update right now?".
///
/// Mirrors [`CheckDecision`]'s shape: an install is always user-initiated
/// (the UI only offers it after a check), so only the two hard invariants
/// remain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallDecision {
    /// Go ahead and run the updater install.
    Run,
    /// The user has not granted consent (or revoked it since the check).
    SkipNoConsent,
    /// A meeting is currently recording; never touch a live session
    /// (ADR 0011).
    SkipRecording,
}

/// Pure decision of whether an update install may run right now.
///
/// Precedence, first match wins:
/// 1. `is_recording` -> [`InstallDecision::SkipRecording`] — ADR 0011's
///    "never touch a live session" invariant is a safety property, so it
///    is checked first and can never be shadowed by the consent policy.
/// 2. `consent != Granted` -> [`InstallDecision::SkipNoConsent`] —
///    defense-in-depth: the UI only surfaces the install affordance after
///    a consented check, but consent may have been revoked in between.
/// 3. otherwise -> [`InstallDecision::Run`]
///
/// Pure and side-effect free, like [`decide_check`] — the caller owns
/// mapping each `Skip*` to its user-visible refusal.
pub fn decide_install(consent: UpdateConsent, is_recording: bool) -> InstallDecision {
    if is_recording {
        return InstallDecision::SkipRecording;
    }
    if consent != UpdateConsent::Granted {
        return InstallDecision::SkipNoConsent;
    }
    InstallDecision::Run
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- load: never errors, never panics -------------------------------

    #[test]
    fn load_returns_default_when_preferences_file_is_missing() {
        // Arrange
        let temp = tempfile::tempdir().expect("tempdir");

        // Act
        let prefs = load(temp.path());

        // Assert
        assert_eq!(prefs, UpdatePrefs::default());
        assert_eq!(prefs.consent, UpdateConsent::Unset);
        assert_eq!(prefs.last_check_at, None);
    }

    #[test]
    fn load_returns_default_when_preferences_file_is_corrupt_json() {
        // Arrange
        let temp = tempfile::tempdir().expect("tempdir");
        fs::write(temp.path().join(PREFERENCES_FILE), b"{not valid json").expect("write");

        // Act
        let prefs = load(temp.path());

        // Assert
        assert_eq!(prefs, UpdatePrefs::default());
    }

    #[test]
    fn load_returns_default_when_preferences_file_is_truncated() {
        // Arrange: a file that is valid UTF-8 but cuts off mid-object, as
        // if the process were killed mid-write.
        let temp = tempfile::tempdir().expect("tempdir");
        fs::write(
            temp.path().join(PREFERENCES_FILE),
            br#"{"updates":{"consent":"gran"#,
        )
        .expect("write");

        // Act
        let prefs = load(temp.path());

        // Assert
        assert_eq!(prefs, UpdatePrefs::default());
    }

    #[test]
    fn load_returns_default_when_updates_key_has_the_wrong_shape() {
        // Arrange: valid JSON, but "updates" is not an UpdatePrefs.
        let temp = tempfile::tempdir().expect("tempdir");
        fs::write(temp.path().join(PREFERENCES_FILE), br#"{"updates":"nope"}"#).expect("write");

        // Act
        let prefs = load(temp.path());

        // Assert
        assert_eq!(prefs, UpdatePrefs::default());
    }

    #[test]
    fn load_returns_default_when_root_is_unreadable_as_a_directory() {
        // Arrange: "preferences.json" is itself a directory, not a file —
        // read_to_string must fail, and load() must still not panic.
        let temp = tempfile::tempdir().expect("tempdir");
        fs::create_dir(temp.path().join(PREFERENCES_FILE)).expect("create dir");

        // Act
        let prefs = load(temp.path());

        // Assert
        assert_eq!(prefs, UpdatePrefs::default());
    }

    // --- save: at-rest permissions and key preservation ------------------

    #[test]
    #[cfg(unix)]
    fn save_writes_preferences_json_at_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;

        // Arrange
        let temp = tempfile::tempdir().expect("tempdir");
        let prefs = UpdatePrefs {
            consent: UpdateConsent::Granted,
            last_check_at: None,
        };

        // Act
        save(temp.path(), &prefs).expect("save should succeed");

        // Assert: exactly 0600 (owner read/write only), mirroring the
        // at-rest permission assertions in `paths.rs`.
        let mode = fs::metadata(temp.path().join(PREFERENCES_FILE))
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(
            mode, 0o600,
            "expected preferences.json to be written 0600, got {mode:o}"
        );
    }

    #[test]
    fn save_preserves_unrelated_top_level_keys_already_in_the_file() {
        // Arrange: a preferences.json with an unrelated top-level key, as
        // if some other future preference already lived there.
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join(PREFERENCES_FILE);
        fs::write(&path, br#"{"other-feature":{"flag":true}}"#).expect("seed file");
        let prefs = UpdatePrefs {
            consent: UpdateConsent::Declined,
            last_check_at: None,
        };

        // Act
        save(temp.path(), &prefs).expect("save should succeed");

        // Assert: the unrelated key survives, and "updates" reflects the
        // new preference.
        let raw = fs::read_to_string(&path).expect("read back");
        let value: Value = serde_json::from_str(&raw).expect("valid json");
        assert_eq!(value["other-feature"]["flag"], Value::Bool(true));
        assert_eq!(
            value["updates"]["consent"],
            Value::String("declined".into())
        );
    }

    // --- round trip: preference survives a restart -----------------------

    #[test]
    fn saved_consent_survives_a_reload_from_disk() {
        // Arrange
        let temp = tempfile::tempdir().expect("tempdir");
        let prefs = UpdatePrefs {
            consent: UpdateConsent::Granted,
            last_check_at: Some(OffsetDateTime::now_utc()),
        };

        // Act
        save(temp.path(), &prefs).expect("save should succeed");
        let reloaded = load(temp.path());

        // Assert
        assert_eq!(reloaded.consent, UpdateConsent::Granted);
        assert!(reloaded.last_check_at.is_some());
    }

    // --- decide_check: full precedence matrix ----------------------------

    #[test]
    fn decide_check_matrix_covers_every_precedence_branch() {
        let now = OffsetDateTime::now_utc();
        let recent_last_check = now - time::Duration::hours(1);
        let stale_last_check = now - time::Duration::hours(25);

        for consent in [
            UpdateConsent::Unset,
            UpdateConsent::Granted,
            UpdateConsent::Declined,
        ] {
            for is_recording in [false, true] {
                for manual in [false, true] {
                    for last_check_at in [None, Some(recent_last_check), Some(stale_last_check)] {
                        let decision =
                            decide_check(consent, last_check_at, is_recording, now, manual);
                        let expected = expected_decision(consent, is_recording);
                        assert_eq!(
                            decision, expected,
                            "consent={consent:?} is_recording={is_recording} manual={manual} \
                             last_check_at={last_check_at:?}"
                        );
                    }
                }
            }
        }
    }

    /// Independent re-derivation of the expected precedence, so the matrix
    /// test isn't just re-stating `decide_check`'s own branches. There is
    /// no throttle arm: a recent `last_check_at` never suppresses a check.
    fn expected_decision(consent: UpdateConsent, is_recording: bool) -> CheckDecision {
        if consent != UpdateConsent::Granted {
            return CheckDecision::SkipNoConsent;
        }
        if is_recording {
            return CheckDecision::SkipRecording;
        }
        CheckDecision::Run
    }

    #[test]
    fn decide_check_runs_only_when_granted_and_not_recording() {
        let now = OffsetDateTime::now_utc();
        assert_eq!(
            decide_check(UpdateConsent::Granted, None, false, now, false),
            CheckDecision::Run
        );
    }

    #[test]
    fn decide_check_skips_no_consent_takes_priority_over_everything_else() {
        let now = OffsetDateTime::now_utc();
        assert_eq!(
            decide_check(UpdateConsent::Unset, None, true, now, true),
            CheckDecision::SkipNoConsent
        );
        assert_eq!(
            decide_check(UpdateConsent::Declined, None, false, now, true),
            CheckDecision::SkipNoConsent
        );
    }

    #[test]
    fn decide_check_skips_recording_even_when_granted_and_manual() {
        let now = OffsetDateTime::now_utc();
        assert_eq!(
            decide_check(UpdateConsent::Granted, None, true, now, true),
            CheckDecision::SkipRecording
        );
    }

    #[test]
    fn decide_check_runs_automatically_even_when_the_previous_check_just_ran() {
        // Every-startup cadence: a recent `last_check_at` never suppresses
        // an automatic check — this is the regression guard for "I still
        // have to click on 'check updates' to actually check updates."
        let now = OffsetDateTime::now_utc();
        let recent = now - time::Duration::minutes(5);
        assert_eq!(
            decide_check(UpdateConsent::Granted, Some(recent), false, now, false),
            CheckDecision::Run
        );
    }

    #[test]
    fn decide_check_runs_automatically_once_the_interval_has_elapsed() {
        let now = OffsetDateTime::now_utc();
        let stale = now - time::Duration::hours(25);
        assert_eq!(
            decide_check(UpdateConsent::Granted, Some(stale), false, now, false),
            CheckDecision::Run
        );
    }

    #[test]
    fn decide_check_ignores_the_manual_flag_for_gating() {
        // `manual` is still part of the IPC shape but no longer gates
        // anything: automatic and manual checks run under the same guards.
        let now = OffsetDateTime::now_utc();
        let recent = now - time::Duration::hours(1);
        assert_eq!(
            decide_check(UpdateConsent::Granted, Some(recent), false, now, true),
            CheckDecision::Run
        );
        assert_eq!(
            decide_check(UpdateConsent::Granted, Some(recent), false, now, false),
            CheckDecision::Run
        );
    }

    // --- decide_install: full precedence matrix --------------------------

    #[test]
    fn decide_install_matrix_covers_every_precedence_branch() {
        for consent in [
            UpdateConsent::Unset,
            UpdateConsent::Granted,
            UpdateConsent::Declined,
        ] {
            for is_recording in [false, true] {
                let decision = decide_install(consent, is_recording);
                let expected = expected_install_decision(consent, is_recording);
                assert_eq!(
                    decision, expected,
                    "consent={consent:?} is_recording={is_recording}"
                );
            }
        }
    }

    /// Independent re-derivation of the expected precedence (recording
    /// first, consent second), so the matrix test isn't just re-stating
    /// `decide_install`'s own branches.
    fn expected_install_decision(consent: UpdateConsent, is_recording: bool) -> InstallDecision {
        if is_recording {
            return InstallDecision::SkipRecording;
        }
        if consent != UpdateConsent::Granted {
            return InstallDecision::SkipNoConsent;
        }
        InstallDecision::Run
    }

    #[test]
    fn decide_install_skips_recording_even_when_consent_is_granted() {
        // An install is always user-initiated ("manual"); the recording
        // guard still binds — ADR 0011: never touch a live session.
        assert_eq!(
            decide_install(UpdateConsent::Granted, true),
            InstallDecision::SkipRecording
        );
    }

    #[test]
    fn decide_install_skips_no_consent_when_unset_or_declined_and_idle() {
        assert_eq!(
            decide_install(UpdateConsent::Unset, false),
            InstallDecision::SkipNoConsent
        );
        assert_eq!(
            decide_install(UpdateConsent::Declined, false),
            InstallDecision::SkipNoConsent
        );
    }

    #[test]
    fn decide_install_runs_when_granted_and_idle() {
        assert_eq!(
            decide_install(UpdateConsent::Granted, false),
            InstallDecision::Run
        );
    }
}
