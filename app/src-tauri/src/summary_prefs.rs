//! App-wide general guidelines for summary generation, persisted to
//! `<data_root>/preferences.json` under the `"summary"` key this module
//! owns.
//!
//! Mirrors [`crate::update_prefs`]'s storage contract: reads never fail
//! (a missing or corrupt file yields defaults), and writes merge into the
//! existing top-level object so unrelated keys (e.g. `"updates"`) survive.
//! Note both `update_prefs::save` and `summary_prefs::save` re-read the
//! file before writing; concurrent writes from the two settings surfaces
//! are rare and user-initiated, so the last writer only loses the other's
//! in-flight edit to *their* key in that narrow window — acceptable for
//! now, with a shared merge helper as a follow-up.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::AppError;
use crate::paths;

const PREFERENCES_FILE: &str = "preferences.json";
const SUMMARY_KEY: &str = "summary";

/// Maximum length, in Unicode scalars, of the persisted guidelines text.
/// Defined locally so this module stays self-contained; crates/myna-llm
/// may export its own cap once the generation-side work lands, at which
/// point the two should be reconciled.
pub const MAX_GUIDELINE_CHARS: usize = 4000;

/// Persisted general guidelines applied to every summary generation.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct SummaryPrefs {
    pub guidelines: String,
}

/// Trims `raw` and caps it at [`MAX_GUIDELINE_CHARS`] Unicode scalars.
///
/// Scalar-based (not byte- or UTF-16-based) so the cap means the same
/// thing for the ASCII and non-ASCII text users actually paste in. The
/// cut is taken at a `char` boundary, so the result is always valid UTF-8.
pub fn normalize_guidelines(raw: &str) -> String {
    let trimmed = raw.trim();
    trimmed.chars().take(MAX_GUIDELINE_CHARS).collect()
}

/// Loads summary preferences from `<root>/preferences.json`.
///
/// Never errors and never panics: a missing file, a file that isn't valid
/// JSON (corrupt or truncated), a file that is unreadable, or a file whose
/// `"summary"` value doesn't match [`SummaryPrefs`]'s shape all yield
/// [`SummaryPrefs::default`] — empty guidelines. A launch must never fail
/// because a preferences file failed to parse.
pub fn load(root: &Path) -> SummaryPrefs {
    let path = root.join(PREFERENCES_FILE);
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(_) => return SummaryPrefs::default(),
    };
    let Ok(root_value) = serde_json::from_str::<Value>(&raw) else {
        return SummaryPrefs::default();
    };
    root_value
        .get(SUMMARY_KEY)
        .cloned()
        .and_then(|summary| serde_json::from_value(summary).ok())
        .unwrap_or_default()
}

/// Persists `prefs` under the `"summary"` key of `<root>/preferences.json`,
/// preserving any unrelated top-level keys already present in the file (a
/// missing or corrupt file is treated as an empty object rather than
/// failing the save). Writes via the existing owner-only (`0600`) helper, so
/// the file never has a world- or group-readable window.
pub fn save(root: &Path, prefs: &SummaryPrefs) -> Result<(), AppError> {
    let path = root.join(PREFERENCES_FILE);

    let mut root_map = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| match value {
            Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default();

    let summary_value =
        serde_json::to_value(prefs).map_err(|err| AppError::Store(err.to_string()))?;
    root_map.insert(SUMMARY_KEY.to_string(), summary_value);

    paths::create_dir_all_0700(root)?;
    let json = serde_json::to_string_pretty(&Value::Object(root_map))
        .map_err(|err| AppError::Store(err.to_string()))?;
    paths::write_0600(&path, json.as_bytes())?;
    Ok(())
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
        assert_eq!(prefs, SummaryPrefs::default());
        assert_eq!(prefs.guidelines, "");
    }

    #[test]
    fn load_returns_default_when_preferences_file_is_corrupt_json() {
        // Arrange
        let temp = tempfile::tempdir().expect("tempdir");
        fs::write(temp.path().join(PREFERENCES_FILE), b"{not valid json").expect("write");

        // Act
        let prefs = load(temp.path());

        // Assert
        assert_eq!(prefs, SummaryPrefs::default());
    }

    #[test]
    fn load_returns_default_when_preferences_file_is_truncated() {
        // Arrange: a file that is valid UTF-8 but cuts off mid-object, as
        // if the process were killed mid-write.
        let temp = tempfile::tempdir().expect("tempdir");
        fs::write(
            temp.path().join(PREFERENCES_FILE),
            br#"{"summary":{"guidelines":"focus on ac"#,
        )
        .expect("write");

        // Act
        let prefs = load(temp.path());

        // Assert
        assert_eq!(prefs, SummaryPrefs::default());
    }

    #[test]
    fn load_returns_default_when_summary_key_has_the_wrong_shape() {
        // Arrange: valid JSON, but "summary" is not a SummaryPrefs.
        let temp = tempfile::tempdir().expect("tempdir");
        fs::write(temp.path().join(PREFERENCES_FILE), br#"{"summary":"nope"}"#).expect("write");

        // Act
        let prefs = load(temp.path());

        // Assert
        assert_eq!(prefs, SummaryPrefs::default());
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
        assert_eq!(prefs, SummaryPrefs::default());
    }

    // --- save: at-rest permissions and key preservation ------------------

    #[test]
    #[cfg(unix)]
    fn save_writes_preferences_json_at_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;

        // Arrange
        let temp = tempfile::tempdir().expect("tempdir");
        let prefs = SummaryPrefs {
            guidelines: "Use bullet points.".into(),
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
        // Arrange: a preferences.json whose only other owner is the
        // updates surface — saving summary prefs must not clobber it.
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join(PREFERENCES_FILE);
        fs::write(
            &path,
            br#"{"updates":{"consent":"granted","last_check_at":"2026-01-02T03:04:05Z"}}"#,
        )
        .expect("seed file");
        let prefs = SummaryPrefs {
            guidelines: "Always list action items.".into(),
        };

        // Act
        save(temp.path(), &prefs).expect("save should succeed");

        // Assert: the "updates" key survives untouched, and "summary"
        // reflects the new preference.
        let raw = fs::read_to_string(&path).expect("read back");
        let value: Value = serde_json::from_str(&raw).expect("valid json");
        assert_eq!(value["updates"]["consent"], Value::String("granted".into()));
        assert_eq!(
            value["updates"]["last_check_at"],
            Value::String("2026-01-02T03:04:05Z".into())
        );
        assert_eq!(
            value["summary"]["guidelines"],
            Value::String("Always list action items.".into())
        );
    }

    // --- round trip: preference survives a restart -----------------------

    #[test]
    fn saved_guidelines_survive_a_reload_from_disk() {
        // Arrange
        let temp = tempfile::tempdir().expect("tempdir");
        let prefs = SummaryPrefs {
            guidelines: "Summaries in French, bullet points only.".into(),
        };

        // Act
        save(temp.path(), &prefs).expect("save should succeed");
        let reloaded = load(temp.path());

        // Assert
        assert_eq!(reloaded, prefs);
    }

    // --- normalize_guidelines: trim and scalar cap -----------------------

    #[test]
    fn normalize_guidelines_trims_surrounding_whitespace() {
        assert_eq!(
            normalize_guidelines("  \n\t focus on decisions \r\n "),
            "focus on decisions"
        );
    }

    #[test]
    fn normalize_guidelines_caps_at_max_chars() {
        let long = "a".repeat(MAX_GUIDELINE_CHARS + 500);
        let normalized = normalize_guidelines(&long);
        assert_eq!(normalized.chars().count(), MAX_GUIDELINE_CHARS);
    }

    #[test]
    fn normalize_guidelines_caps_unicode_at_scalar_boundary() {
        // Multibyte input: the cap must count Unicode scalars, and the cut
        // must land on a char boundary (valid UTF-8 out of necessity).
        let long = "ééé".repeat(MAX_GUIDELINE_CHARS);
        let normalized = normalize_guidelines(&long);
        assert_eq!(normalized.chars().count(), MAX_GUIDELINE_CHARS);
        // A `String` can only hold valid UTF-8, so a scalar-boundary cut is
        // proven by the type — the observable check is that the count is
        // in scalars, not bytes (each `é` is 2 bytes; a byte cap would
        // yield ~2000 chars here).
        assert!(normalized.len() > MAX_GUIDELINE_CHARS);
    }

    #[test]
    fn normalize_guidelines_leaves_short_text_untouched() {
        assert_eq!(normalize_guidelines("keep it brief"), "keep it brief");
        assert_eq!(normalize_guidelines("   "), "");
    }
}
