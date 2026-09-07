//! Per-template prompt overrides, persisted to `<data_root>/preferences.json`
//! under the `"template_prompts"` key this module owns.
//!
//! Mirrors [`crate::summary_prefs`]'s storage contract: reads never fail
//! (a missing or corrupt file yields defaults), and writes merge into the
//! existing top-level object so unrelated keys (e.g. `"summary"`,
//! `"updates"`) survive. Note `summary_prefs::save`,
//! `update_prefs::save`, and `template_prefs::save` all re-read the file
//! before writing; concurrent writes from the settings surfaces are rare
//! and user-initiated, so the last writer only loses the other's in-flight
//! edit to *their* key in that narrow window — acceptable for now, with a
//! shared merge helper as a follow-up.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::AppError;
use crate::paths;

const PREFERENCES_FILE: &str = "preferences.json";
const TEMPLATE_PROMPTS_KEY: &str = "template_prompts";

/// Maximum length, in Unicode scalars, of a single per-template override.
///
/// Scalar-based (not byte- or UTF-16-based) so the cap means the same thing
/// for the ASCII and non-ASCII text users actually paste in. The cut is
/// taken at a `char` boundary, so the result is always valid UTF-8.
pub const MAX_TEMPLATE_PROMPT_CHARS: usize = 12000;

/// Per-template prompt overrides keyed by template name.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct TemplatePromptPrefs {
    #[serde(default)]
    pub prompts: HashMap<String, String>,
}

/// Returns `true` when `name` is a single safe template segment:
/// one or more of `[a-z0-9-]`.
///
/// This rejects empty names, `.`/`..`, slashes, backslashes, dots, and any
/// other character that could escape the templates directory or address a
/// nested path — there is no multi-segment form, so traversal is
/// impossible by construction.
pub fn is_valid_template_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Trims `raw` and caps it at [`MAX_TEMPLATE_PROMPT_CHARS`] Unicode scalars.
///
/// Scalar-based (not byte- or UTF-16-based) so the cap means the same thing
/// for the ASCII and non-ASCII text users actually paste in. The cut is
/// taken at a `char` boundary, so the result is always valid UTF-8.
pub fn normalize_prompt(raw: &str) -> String {
    let trimmed = raw.trim();
    trimmed.chars().take(MAX_TEMPLATE_PROMPT_CHARS).collect()
}

/// Loads template prompt overrides from `<root>/preferences.json`.
///
/// Never errors and never panics: a missing file, a file that isn't valid
/// JSON (corrupt or truncated), a file that is unreadable, or a file whose
/// `"template_prompts"` value doesn't match [`TemplatePromptPrefs`]'s shape
/// all yield [`TemplatePromptPrefs::default`] — no overrides. A launch must
/// never fail because a preferences file failed to parse.
///
/// Entries whose names fail [`is_valid_template_name`] are dropped on load
/// so a hand-edited file can never smuggle a traversal key into memory.
pub fn load(root: &Path) -> TemplatePromptPrefs {
    let path = root.join(PREFERENCES_FILE);
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(_) => return TemplatePromptPrefs::default(),
    };
    let Ok(root_value) = serde_json::from_str::<Value>(&raw) else {
        return TemplatePromptPrefs::default();
    };
    let mut prefs: TemplatePromptPrefs = root_value
        .get(TEMPLATE_PROMPTS_KEY)
        .cloned()
        .and_then(|section| serde_json::from_value(section).ok())
        .unwrap_or_default();
    prefs.prompts.retain(|name, _| is_valid_template_name(name));
    prefs
}

/// Persists `prefs` under the `"template_prompts"` key of
/// `<root>/preferences.json`, preserving any unrelated top-level keys
/// already present in the file (a missing or corrupt file is treated as an
/// empty object rather than failing the save). Writes via the existing
/// owner-only (`0600`) helper, so the file never has a world- or
/// group-readable window.
///
/// Entries whose names fail [`is_valid_template_name`] are dropped before
/// writing so an invalid in-memory key can never reach disk.
pub fn save(root: &Path, prefs: &TemplatePromptPrefs) -> Result<(), AppError> {
    let path = root.join(PREFERENCES_FILE);

    let mut root_map = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| match value {
            Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default();

    let cleaned: HashMap<&str, &str> = prefs
        .prompts
        .iter()
        .filter(|(name, _)| is_valid_template_name(name))
        .map(|(name, prompt)| (name.as_str(), prompt.as_str()))
        .collect();
    let section_value = serde_json::to_value(TemplatePromptPrefsView { prompts: &cleaned })
        .map_err(|err| AppError::Store(err.to_string()))?;
    root_map.insert(TEMPLATE_PROMPTS_KEY.to_string(), section_value);

    paths::create_dir_all_0700(root)?;
    let json = serde_json::to_string_pretty(&Value::Object(root_map))
        .map_err(|err| AppError::Store(err.to_string()))?;
    paths::write_0600(&path, json.as_bytes())?;
    Ok(())
}

/// Serializable view of the cleaned prompts map, so [`save`] drops invalid
/// names without mutating the caller's struct.
#[derive(Serialize)]
struct TemplatePromptPrefsView<'a> {
    prompts: &'a HashMap<&'a str, &'a str>,
}

/// Returns the override for `name`, or `None` when there is no override or
/// `name` fails [`is_valid_template_name`].
pub fn get<'a>(prefs: &'a TemplatePromptPrefs, name: &str) -> Option<&'a str> {
    if !is_valid_template_name(name) {
        return None;
    }
    prefs.prompts.get(name).map(String::as_str)
}

/// Sets the override for `name` to the normalized `prompt`.
///
/// The prompt is normalized via [`normalize_prompt`]; a prompt that
/// normalizes to empty removes any existing override (an empty string
/// carries no instruction, so storing it would only be dead weight).
/// Returns `false` — without touching `prefs` — when `name` fails
/// [`is_valid_template_name`]; returns `true` otherwise.
pub fn set(prefs: &mut TemplatePromptPrefs, name: &str, prompt: &str) -> bool {
    if !is_valid_template_name(name) {
        return false;
    }
    let normalized = normalize_prompt(prompt);
    if normalized.is_empty() {
        prefs.prompts.remove(name);
    } else {
        prefs.prompts.insert(name.to_owned(), normalized);
    }
    true
}

/// Removes the override for `name`. Returns `true` when an entry was
/// removed, `false` when `name` is invalid or had no override.
pub fn reset(prefs: &mut TemplatePromptPrefs, name: &str) -> bool {
    if !is_valid_template_name(name) {
        return false;
    }
    prefs.prompts.remove(name).is_some()
}

impl TemplatePromptPrefs {
    /// Returns the override for `name` — see [`get`].
    pub fn get(&self, name: &str) -> Option<&str> {
        get(self, name)
    }

    /// Sets the override for `name` — see [`set`].
    pub fn set(&mut self, name: &str, prompt: &str) -> bool {
        set(self, name, prompt)
    }

    /// Removes the override for `name` — see [`reset`].
    pub fn reset(&mut self, name: &str) -> bool {
        reset(self, name)
    }
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
        assert_eq!(prefs, TemplatePromptPrefs::default());
        assert!(prefs.prompts.is_empty());
    }

    #[test]
    fn load_returns_default_when_preferences_file_is_corrupt_json() {
        // Arrange
        let temp = tempfile::tempdir().expect("tempdir");
        fs::write(temp.path().join(PREFERENCES_FILE), b"{not valid json").expect("write");

        // Act
        let prefs = load(temp.path());

        // Assert
        assert_eq!(prefs, TemplatePromptPrefs::default());
    }

    #[test]
    fn load_returns_default_when_preferences_file_is_truncated() {
        // Arrange: a file that is valid UTF-8 but cuts off mid-object, as
        // if the process were killed mid-write.
        let temp = tempfile::tempdir().expect("tempdir");
        fs::write(
            temp.path().join(PREFERENCES_FILE),
            br#"{"template_prompts":{"prompts":{"key-points":"focus on ac"#,
        )
        .expect("write");

        // Act
        let prefs = load(temp.path());

        // Assert
        assert_eq!(prefs, TemplatePromptPrefs::default());
    }

    #[test]
    fn load_returns_default_when_template_prompts_key_has_the_wrong_shape() {
        // Arrange: valid JSON, but "template_prompts" is not a
        // TemplatePromptPrefs.
        let temp = tempfile::tempdir().expect("tempdir");
        fs::write(
            temp.path().join(PREFERENCES_FILE),
            br#"{"template_prompts":"nope"}"#,
        )
        .expect("write");

        // Act
        let prefs = load(temp.path());

        // Assert
        assert_eq!(prefs, TemplatePromptPrefs::default());
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
        assert_eq!(prefs, TemplatePromptPrefs::default());
    }

    #[test]
    fn load_drops_traversal_and_invalid_names_but_keeps_valid_ones() {
        // Arrange: a hand-edited file mixing valid overrides with keys that
        // must never reach memory.
        let temp = tempfile::tempdir().expect("tempdir");
        fs::write(
            temp.path().join(PREFERENCES_FILE),
            br#"{"template_prompts":{"prompts":{"key-points":"Be brief.","../evil":"x","a/b":"y","UPPER":"z","":"w","has space":"v","under_score":"u"}}}"#,
        )
        .expect("write");

        // Act
        let prefs = load(temp.path());

        // Assert: only the valid name survives.
        assert_eq!(prefs.prompts.len(), 1);
        assert_eq!(
            prefs.prompts.get("key-points").map(String::as_str),
            Some("Be brief.")
        );
    }

    // --- save: at-rest permissions and key preservation ------------------

    #[test]
    #[cfg(unix)]
    fn save_writes_preferences_json_at_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;

        // Arrange
        let temp = tempfile::tempdir().expect("tempdir");
        let mut prefs = TemplatePromptPrefs::default();
        assert!(prefs.set("key-points", "Be brief."));

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
        // Arrange: a preferences.json owned by the other settings surfaces
        // — saving template prefs must not clobber them.
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join(PREFERENCES_FILE);
        fs::write(
            &path,
            br#"{"updates":{"consent":"granted"},"summary":{"guidelines":"Be brief."}}"#,
        )
        .expect("seed file");
        let mut prefs = TemplatePromptPrefs::default();
        assert!(prefs.set("key-points", "Focus on decisions."));

        // Act
        save(temp.path(), &prefs).expect("save should succeed");

        // Assert: the other keys survive untouched, and "template_prompts"
        // reflects the new preference.
        let raw = fs::read_to_string(&path).expect("read back");
        let value: Value = serde_json::from_str(&raw).expect("valid json");
        assert_eq!(value["updates"]["consent"], Value::String("granted".into()));
        assert_eq!(
            value["summary"]["guidelines"],
            Value::String("Be brief.".into())
        );
        assert_eq!(
            value["template_prompts"]["prompts"]["key-points"],
            Value::String("Focus on decisions.".into())
        );
    }

    #[test]
    fn save_drops_invalid_names_instead_of_persisting_them() {
        // Arrange: an in-memory struct with a traversal key smuggled in
        // past `set` (e.g. deserialized from an older shape).
        let temp = tempfile::tempdir().expect("tempdir");
        let mut prefs = TemplatePromptPrefs::default();
        assert!(prefs.set("key-points", "Be brief."));
        prefs.prompts.insert("../evil".to_owned(), "x".to_owned());

        // Act
        save(temp.path(), &prefs).expect("save should succeed");

        // Assert: only the valid key reaches disk.
        let reloaded = load(temp.path());
        assert_eq!(reloaded.prompts.len(), 1);
        assert!(reloaded.prompts.contains_key("key-points"));
    }

    // --- round trip: preference survives a restart -----------------------

    #[test]
    fn saved_prompts_survive_a_reload_from_disk() {
        // Arrange
        let temp = tempfile::tempdir().expect("tempdir");
        let mut prefs = TemplatePromptPrefs::default();
        assert!(prefs.set("key-points", "Be brief."));
        assert!(prefs.set("action-items", "Always list owners."));

        // Act
        save(temp.path(), &prefs).expect("save should succeed");
        let reloaded = load(temp.path());

        // Assert
        assert_eq!(reloaded, prefs);
    }

    // --- name validation -------------------------------------------------

    #[test]
    fn valid_template_names_are_lowercase_alphanumeric_and_dashes() {
        assert!(is_valid_template_name("key-points"));
        assert!(is_valid_template_name("a"));
        assert!(is_valid_template_name("action-items-2"));
        assert!(is_valid_template_name("0-9-mix"));
    }

    #[test]
    fn invalid_template_names_are_rejected() {
        for bad in [
            "",
            ".",
            "..",
            "../evil",
            "a/b",
            "a\\b",
            "UPPER",
            "Key-Points",
            "has space",
            "under_score",
            "dot.name",
            "trailing/",
            "/leading",
            "semi;colon",
        ] {
            assert!(
                !is_valid_template_name(bad),
                "expected {bad:?} to be invalid"
            );
        }
    }

    // --- get / set / reset -----------------------------------------------

    #[test]
    fn get_returns_none_for_missing_or_invalid_names() {
        let mut prefs = TemplatePromptPrefs::default();
        assert!(prefs.set("key-points", "Be brief."));
        assert_eq!(prefs.get("key-points"), Some("Be brief."));
        assert_eq!(prefs.get("missing"), None);
        assert_eq!(prefs.get("../evil"), None);
        assert_eq!(prefs.get(""), None);
    }

    #[test]
    fn set_normalizes_and_rejects_invalid_names() {
        let mut prefs = TemplatePromptPrefs::default();
        assert!(prefs.set("key-points", "  Be brief.  "));
        assert_eq!(prefs.get("key-points"), Some("Be brief."));
        assert!(!prefs.set("../evil", "x"));
        assert!(!prefs.set("", "x"));
        assert!(!prefs.set("UPPER", "x"));
        assert_eq!(prefs.prompts.len(), 1);
    }

    #[test]
    fn set_with_empty_prompt_removes_the_override() {
        // Arrange
        let mut prefs = TemplatePromptPrefs::default();
        assert!(prefs.set("key-points", "Be brief."));

        // Act: blank input normalizes to empty, which clears the entry.
        assert!(prefs.set("key-points", "   "));

        // Assert
        assert_eq!(prefs.get("key-points"), None);
        assert!(prefs.prompts.is_empty());
    }

    #[test]
    fn set_caps_at_max_chars() {
        let mut prefs = TemplatePromptPrefs::default();
        let long = "a".repeat(MAX_TEMPLATE_PROMPT_CHARS + 500);
        assert!(prefs.set("key-points", &long));
        assert_eq!(
            prefs.get("key-points").map(str::chars).map(Iterator::count),
            Some(MAX_TEMPLATE_PROMPT_CHARS)
        );
    }

    #[test]
    fn reset_removes_only_the_named_valid_override() {
        // Arrange
        let mut prefs = TemplatePromptPrefs::default();
        assert!(prefs.set("key-points", "Be brief."));
        assert!(prefs.set("action-items", "List owners."));

        // Act / Assert
        assert!(prefs.reset("key-points"));
        assert_eq!(prefs.get("key-points"), None);
        assert_eq!(prefs.get("action-items"), Some("List owners."));
        assert!(!prefs.reset("key-points"));
        assert!(!prefs.reset("../evil"));
        assert!(!prefs.reset(""));
    }

    // --- normalize_prompt: trim and scalar cap ---------------------------

    #[test]
    fn normalize_prompt_trims_surrounding_whitespace() {
        assert_eq!(
            normalize_prompt("  \n\t focus on decisions \r\n "),
            "focus on decisions"
        );
    }

    #[test]
    fn normalize_prompt_caps_at_max_chars() {
        let long = "a".repeat(MAX_TEMPLATE_PROMPT_CHARS + 500);
        let normalized = normalize_prompt(&long);
        assert_eq!(normalized.chars().count(), MAX_TEMPLATE_PROMPT_CHARS);
    }

    #[test]
    fn normalize_prompt_caps_unicode_at_scalar_boundary() {
        // Multibyte input: the cap must count Unicode scalars, and the cut
        // must land on a char boundary (valid UTF-8 out of necessity).
        let long = "ééé".repeat(MAX_TEMPLATE_PROMPT_CHARS);
        let normalized = normalize_prompt(&long);
        assert_eq!(normalized.chars().count(), MAX_TEMPLATE_PROMPT_CHARS);
        // A `String` can only hold valid UTF-8, so a scalar-boundary cut is
        // proven by the type — the observable check is that the count is
        // in scalars, not bytes (each `é` is 2 bytes; a byte cap would
        // yield ~6000 chars here).
        assert!(normalized.len() > MAX_TEMPLATE_PROMPT_CHARS);
    }

    #[test]
    fn normalize_prompt_leaves_short_text_untouched() {
        assert_eq!(normalize_prompt("keep it brief"), "keep it brief");
        assert_eq!(normalize_prompt("   "), "");
    }
}
