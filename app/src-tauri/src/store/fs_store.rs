//! Filesystem-backed [`MeetingStore`]: one directory per meeting under
//! `<root>/meetings/<id>/`.

use std::fs;
use std::path::{Path, PathBuf};

use time::OffsetDateTime;

use crate::domain::meeting::{Meeting, MeetingId};
use crate::domain::placement::effective_position;
use crate::domain::summary::Summary;
use crate::error::AppError;
use crate::paths;
use crate::store::MeetingStore;

const MEETINGS_DIR: &str = "meetings";
const MEETING_FILE: &str = "meeting.json";
const MEETING_TMP_FILE: &str = "meeting.json.tmp";
const AUDIO_FILE: &str = "audio.wav";
const MIC_TRACK_FILE: &str = "track-mic.wav";
const SYSTEM_TRACK_FILE: &str = "track-system.wav";
const SESSION_FILE: &str = "session.json";
const JOURNAL_FILE: &str = "transcript-journal.jsonl";
const SUMMARIES_DIR: &str = "summaries";
const FALLBACK_TEMPLATE_NAME: &str = "template";

/// Filesystem-backed meeting store rooted at an arbitrary directory.
///
/// Production code roots this at the user's data directory (see
/// `crate::paths::data_root`); tests root it at a `tempfile::tempdir()` so
/// persistence is exercised without touching the user's real `~/myna`.
pub struct FsMeetingStore {
    root: PathBuf,
}

impl FsMeetingStore {
    /// Creates a store rooted at `root`. Does not create any directories
    /// eagerly; they are created lazily on first write.
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn meetings_root(&self) -> PathBuf {
        self.root.join(MEETINGS_DIR)
    }

    fn meeting_dir(&self, id: MeetingId) -> PathBuf {
        self.meetings_root().join(id.to_string())
    }

    fn meeting_json_path(&self, id: MeetingId) -> PathBuf {
        self.meeting_dir(id).join(MEETING_FILE)
    }

    fn meeting_tmp_path(&self, id: MeetingId) -> PathBuf {
        self.meeting_dir(id).join(MEETING_TMP_FILE)
    }

    fn summaries_dir(&self, id: MeetingId) -> PathBuf {
        self.meeting_dir(id).join(SUMMARIES_DIR)
    }

    fn summary_path(&self, id: MeetingId, template: &str, language: &str) -> PathBuf {
        self.summaries_dir(id).join(format!(
            "{}__{}.md",
            sanitize_path_segment(template),
            sanitize_path_segment(language)
        ))
    }

    fn read_meeting_file(path: &Path) -> Result<Meeting, AppError> {
        let raw = fs::read_to_string(path)?;
        serde_json::from_str(&raw).map_err(|err| AppError::Store(err.to_string()))
    }
}

/// Restricts a summary path component (template name or language code) to a
/// single, safe path segment so a malicious or odd value (e.g.
/// `../../etc/passwd`) cannot escape the meeting directory.
fn sanitize_path_segment(segment: &str) -> String {
    let sanitized: String = segment
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();

    if sanitized.is_empty() {
        FALLBACK_TEMPLATE_NAME.to_string()
    } else {
        sanitized
    }
}

impl MeetingStore for FsMeetingStore {
    fn create(&self, title: &str) -> Result<Meeting, AppError> {
        let meeting = Meeting::new(title);
        self.save(&meeting)?;
        Ok(meeting)
    }

    fn get(&self, id: MeetingId) -> Result<Meeting, AppError> {
        let path = self.meeting_json_path(id);
        if !path.exists() {
            return Err(AppError::NotFound(id.to_string()));
        }
        Self::read_meeting_file(&path)
    }

    fn list(&self) -> Result<Vec<Meeting>, AppError> {
        let meetings_root = self.meetings_root();
        if !meetings_root.exists() {
            return Ok(Vec::new());
        }

        let mut meetings: Vec<Meeting> = fs::read_dir(&meetings_root)?
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.path().is_dir())
            .filter_map(|entry| Self::read_meeting_file(&entry.path().join(MEETING_FILE)).ok())
            .collect();

        // Ascending effective position (see `domain::placement`), then
        // `created_at` DESC, then `id` as a final deterministic tie-break.
        // `f64::total_cmp` -- never `partial_cmp().unwrap()` -- since
        // `effective_position` is never NaN but clippy has no way to know
        // that.
        meetings.sort_by(|a, b| {
            effective_position(a)
                .total_cmp(&effective_position(b))
                .then_with(|| b.created_at.cmp(&a.created_at))
                .then_with(|| a.id.to_string().cmp(&b.id.to_string()))
        });
        Ok(meetings)
    }

    fn save(&self, meeting: &Meeting) -> Result<(), AppError> {
        let dir = self.meeting_dir(meeting.id);
        paths::create_dir_all_0700(&dir)?;

        let json = serde_json::to_string_pretty(meeting)
            .map_err(|err| AppError::Store(err.to_string()))?;
        let tmp_path = self.meeting_tmp_path(meeting.id);
        paths::write_0600(&tmp_path, json.as_bytes())?;
        if let Err(err) = fs::rename(&tmp_path, self.meeting_json_path(meeting.id)) {
            let _ = fs::remove_file(&tmp_path);
            return Err(AppError::from(err));
        }
        Ok(())
    }

    fn delete(&self, id: MeetingId) -> Result<(), AppError> {
        let dir = self.meeting_dir(id);
        if !dir.exists() {
            return Err(AppError::NotFound(id.to_string()));
        }
        fs::remove_dir_all(&dir)?;
        Ok(())
    }

    fn audio_path(&self, id: MeetingId) -> PathBuf {
        self.meeting_dir(id).join(AUDIO_FILE)
    }

    fn mic_track_path(&self, id: MeetingId) -> PathBuf {
        self.meeting_dir(id).join(MIC_TRACK_FILE)
    }

    fn system_track_path(&self, id: MeetingId) -> PathBuf {
        self.meeting_dir(id).join(SYSTEM_TRACK_FILE)
    }

    fn session_manifest_path(&self, id: MeetingId) -> PathBuf {
        self.meeting_dir(id).join(SESSION_FILE)
    }

    fn transcript_journal_path(&self, id: MeetingId) -> PathBuf {
        self.meeting_dir(id).join(JOURNAL_FILE)
    }

    fn save_summary(
        &self,
        id: MeetingId,
        template: &str,
        language: &str,
        markdown: &str,
    ) -> Result<PathBuf, AppError> {
        paths::create_dir_all_0700(&self.summaries_dir(id))?;
        let path = self.summary_path(id, template, language);
        paths::write_0600(&path, markdown.as_bytes())?;
        Ok(path)
    }

    fn read_summary(
        &self,
        id: MeetingId,
        template: &str,
        language: &str,
    ) -> Result<Summary, AppError> {
        let path = self.summary_path(id, template, language);
        if !path.exists() {
            return Err(AppError::NotFound(format!(
                "summary '{template}' ({language}) for meeting {id}"
            )));
        }

        let markdown = fs::read_to_string(&path)?;
        let modified = fs::metadata(&path)?.modified()?;
        Ok(Summary {
            template: template.to_string(),
            markdown,
            created_at: OffsetDateTime::from(modified),
            language: language.to_string(),
        })
    }

    fn delete_summary(
        &self,
        id: MeetingId,
        template: &str,
        language: &str,
    ) -> Result<(), AppError> {
        let meeting = self.get(id)?;
        let path = self.summary_path(id, template, language);
        if !path.exists() {
            return Err(AppError::NotFound(format!(
                "summary '{template}' ({language}) for meeting {id}"
            )));
        }
        fs::remove_file(&path)?;
        self.save(&meeting.without_summary(template, language))?;
        Ok(())
    }
}
