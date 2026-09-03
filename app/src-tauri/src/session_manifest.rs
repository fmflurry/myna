//! Session durability artifacts: the `session.json` manifest and the
//! `transcript-journal.jsonl` append-only journal (ADR 0011, Phase 1).
//!
//! The manifest is the recovery invariant — *manifest existence == a
//! recording is in progress* — written the moment a session starts and
//! deleted only after the finished meeting has been persisted. The journal
//! captures every finalized transcript segment as one JSON line, so a
//! crash between "capture stopped" and "meeting saved" loses neither the
//! fact that a recording was live nor the finals already decoded.
//!
//! Both files are written with the same atomic tmp+rename discipline as
//! `store::fs_store::save` and the same owner-only (`0600`) permissions as
//! every other meeting-scoped artifact — `~/myna` is not a TCC-protected
//! location.

use std::fs;
use std::io::Write;
use std::path::Path;

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use myna_audio::CaptureSource;
use myna_stt::{Transcript, TranscriptSegment};

use crate::error::AppError;
use crate::paths;

/// Current on-disk schema version of [`SessionManifest`].
pub const MANIFEST_VERSION: u32 = 1;

/// A recording that was in progress when this file was written. Serialized
/// `camelCase` to match every other persisted JSON shape in the app.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionManifest {
    pub version: u32,
    pub meeting_id: String,
    /// The EFFECTIVE capture source (after any system-audio fallback), not
    /// what was originally requested.
    pub source: CaptureSource,
    /// The effective system-audio source id requested of the backend
    /// (`None` = all-output / microphone-only). The backend may still
    /// resolve differently once the tap is live — that refinement is
    /// announced over events, not journaled here.
    pub system_source_id: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    pub started_at: OffsetDateTime,
    /// Pid of the process that started the recording. A manifest whose pid
    /// is still alive is a live session in the current process; a dead pid
    /// is what a later recovery pass keys off.
    pub pid: u32,
}

impl SessionManifest {
    /// Builds a version-1 manifest stamped with the current time and pid.
    pub fn new(meeting_id: &str, source: CaptureSource, system_source_id: Option<String>) -> Self {
        Self {
            version: MANIFEST_VERSION,
            meeting_id: meeting_id.to_string(),
            source,
            system_source_id,
            started_at: OffsetDateTime::now_utc(),
            pid: std::process::id(),
        }
    }
}

/// Sibling `.tmp` path used for the atomic write (mirrors
/// `fs_store`'s `meeting.json.tmp`).
fn tmp_path(path: &Path) -> std::path::PathBuf {
    path.with_extension("json.tmp")
}

/// Atomically writes `manifest` to `path` (tmp + rename, `0600`),
/// creating the parent directory owner-only if missing.
pub fn write_manifest(path: &Path, manifest: &SessionManifest) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        paths::create_dir_all_0700(parent)?;
    }
    let json =
        serde_json::to_string_pretty(manifest).map_err(|err| AppError::Store(err.to_string()))?;
    let tmp = tmp_path(path);
    paths::write_0600(&tmp, json.as_bytes())?;
    if let Err(err) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(AppError::from(err));
    }
    Ok(())
}

/// Reads a manifest written by [`write_manifest`].
pub fn read_manifest(path: &Path) -> Result<SessionManifest, AppError> {
    let raw = fs::read_to_string(path)?;
    serde_json::from_str(&raw).map_err(|err| AppError::Store(err.to_string()))
}

/// Removes `path`, treating an already-absent file as success (the stop
/// path calls this defensively; a missing artifact means there is nothing
/// to clean up, not an error).
fn remove_if_exists(path: &Path) -> Result<(), AppError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(AppError::from(err)),
    }
}

/// Deletes the session manifest (used by `stop_recording` after the
/// meeting is saved; `cancel_recording` removes the whole meeting dir).
pub fn delete_manifest(path: &Path) -> Result<(), AppError> {
    remove_if_exists(path)
}

/// Deletes the transcript journal (used by `stop_recording` after the
/// meeting is saved).
pub fn delete_journal(path: &Path) -> Result<(), AppError> {
    remove_if_exists(path)
}

/// Opens a transcript journal for appending, one snake_case
/// [`TranscriptSegment`] JSON object per line.
///
/// Owned exclusively by the decode worker thread — never reachable from
/// the realtime audio callback. Each append is a single `write_all`
/// directly to the OS (no userspace buffering), so a `kill -9` loses at
/// most the segment being written, and every earlier line is durable
/// against *process death*. No `fsync` is issued, so a power loss (or a
/// kernel panic) can still lose lines the OS had acknowledged into its
/// page cache — durability here is against the app dying, not the
/// machine.
pub struct JournalWriter {
    /// The append sink — a `fs::File` in production, a simulated failing
    /// writer in tests (the only way to exercise the mid-`write_all`
    /// error path deterministically without filling a real disk).
    sink: Box<dyn Write + Send>,
    /// `true` once an append has failed mid-write. See [`Self::append`].
    dead: bool,
}

impl JournalWriter {
    /// Creates (or reopens for appending) the journal at `path` with
    /// owner-only (`0600`) permissions, ensuring the parent directory
    /// exists owner-only (`0700`).
    pub fn create(path: &Path) -> Result<Self, AppError> {
        if let Some(parent) = path.parent() {
            paths::create_dir_all_0700(parent)?;
        }
        let file = open_append_0600(path)?;
        Ok(Self {
            sink: Box::new(file),
            dead: false,
        })
    }

    #[cfg(test)]
    fn with_sink(sink: Box<dyn Write + Send>) -> Self {
        Self { sink, dead: false }
    }

    /// Appends `segment` as one JSON line. Callers on the decode worker
    /// log failures to stderr and must never abort capture over them.
    ///
    /// A failed `write_all` may have landed a *partial* line with no
    /// trailing newline. Appending onto that would splice two JSON
    /// objects into one interior line — permanent corruption the tolerant
    /// reader (see [`read_journal`]) cannot recover from. So after the
    /// first failure the writer marks itself dead and rejects every
    /// further append without writing: the journal keeps a (tolerable)
    /// truncated tail instead of gaining an interior one. Retiring the
    /// writer is chosen over truncating back to the last newline because
    /// a write error usually means the volume is out of space — the
    /// recovery `set_len` could fail too, and a failed append that
    /// silently *kept* a poisoned writer is the exact bug this guards.
    pub fn append(&mut self, segment: &TranscriptSegment) -> Result<(), AppError> {
        if self.dead {
            return Err(AppError::Store(
                "transcript journal retired after an earlier failed write".to_string(),
            ));
        }
        let mut line =
            serde_json::to_vec(segment).map_err(|err| AppError::Store(err.to_string()))?;
        line.push(b'\n');
        if let Err(err) = self.sink.write_all(&line) {
            self.dead = true;
            return Err(AppError::from(err));
        }
        Ok(())
    }
}

#[cfg(unix)]
fn open_append_0600(path: &Path) -> std::io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .open(path)
}

#[cfg(not(unix))]
fn open_append_0600(path: &Path) -> std::io::Result<fs::File> {
    fs::OpenOptions::new().append(true).create(true).open(path)
}

/// Replays the journal at `path` into an ordered [`Transcript`].
///
/// A missing file reads as an empty transcript (a session with no finals
/// yet has nothing to replay). A truncated trailing line — the expected
/// shape of a crash that landed mid-append — is tolerated and skipped;
/// any *interior* parse failure is real corruption and surfaces as an
/// error. Segments are inserted via
/// [`crate::ingest::insert_final_segment`] so the result is ordered
/// ascending by `start_sec` regardless of the order the two tracks'
/// segments finished decoding (journal lines are written in
/// decode-completion order, which is not chronological order across
/// tracks).
pub fn read_journal(path: &Path) -> Result<Transcript, AppError> {
    let raw = match fs::read(path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Transcript::default());
        }
        Err(err) => return Err(AppError::from(err)),
    };

    let mut transcript = Transcript::default();
    let mut lines = raw
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.iter().all(u8::is_ascii_whitespace))
        .peekable();
    while let Some(line) = lines.next() {
        match serde_json::from_slice::<TranscriptSegment>(line) {
            Ok(segment) => crate::ingest::insert_final_segment(&mut transcript, segment),
            Err(err) => {
                if lines.peek().is_none() {
                    // Truncated trailing line from a crash mid-append: the
                    // one corruption mode this reader exists to tolerate.
                    break;
                }
                return Err(AppError::Store(format!(
                    "malformed journal line (interior corruption): {err}"
                )));
            }
        }
    }
    Ok(transcript)
}

#[cfg(test)]
mod tests {
    use super::*;
    use myna_stt::Speaker;

    fn segment(start_sec: f32, end_sec: f32, text: &str, speaker: Speaker) -> TranscriptSegment {
        TranscriptSegment {
            start_sec,
            end_sec,
            text: text.to_string(),
            speaker,
            speaker_pinned: false,
        }
    }

    // --- manifest ---------------------------------------------------------

    #[test]
    fn manifest_round_trips_through_camel_case_json_atomically() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("session.json");
        let manifest = SessionManifest::new(
            "abc-123",
            CaptureSource::Mixed,
            Some("app:com.example.teams".to_string()),
        );

        write_manifest(&path, &manifest).expect("write manifest");

        let raw = fs::read_to_string(&path).expect("read raw");
        let value: serde_json::Value = serde_json::from_str(&raw).expect("parse raw");
        assert_eq!(value["meetingId"], "abc-123");
        assert_eq!(value["systemSourceId"], "app:com.example.teams");
        assert_eq!(value["source"], "mixed");
        assert_eq!(value["version"], MANIFEST_VERSION);
        assert!(
            value["startedAt"].as_str().is_some_and(|s| s.contains('T')),
            "startedAt must be an rfc3339 string, got: {}",
            value["startedAt"]
        );
        assert_eq!(value["pid"], std::process::id());

        let read_back = read_manifest(&path).expect("read manifest");
        assert_eq!(read_back, manifest);

        // The atomic tmp file must not linger after a successful write.
        assert!(
            !dir.path().join("session.json.tmp").exists(),
            "tmp file must be consumed by the rename"
        );
    }

    #[test]
    fn manifest_with_no_system_source_round_trips_as_null() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("session.json");
        let manifest = SessionManifest::new("mic-only", CaptureSource::Microphone, None);

        write_manifest(&path, &manifest).expect("write manifest");

        let raw = fs::read_to_string(&path).expect("read raw");
        let value: serde_json::Value = serde_json::from_str(&raw).expect("parse raw");
        assert_eq!(value["systemSourceId"], serde_json::Value::Null);
        assert_eq!(read_manifest(&path).expect("read"), manifest);
    }

    #[test]
    fn delete_manifest_and_journal_tolerate_a_missing_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        delete_manifest(&dir.path().join("session.json")).expect("missing manifest delete is Ok");
        delete_journal(&dir.path().join("transcript-journal.jsonl"))
            .expect("missing journal delete is Ok");
    }

    #[test]
    fn delete_manifest_removes_an_existing_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("session.json");
        write_manifest(
            &path,
            &SessionManifest::new("m", CaptureSource::Microphone, None),
        )
        .expect("write");

        delete_manifest(&path).expect("delete");

        assert!(!path.exists());
    }

    // --- journal ----------------------------------------------------------

    #[test]
    fn journal_lines_are_one_snake_case_json_object_per_line() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("transcript-journal.jsonl");
        let mut writer = JournalWriter::create(&path).expect("create journal");
        writer
            .append(&segment(0.0, 1.0, "hello", Speaker::me()))
            .expect("append");
        writer
            .append(&segment(1.0, 2.0, "hi there", Speaker::others()))
            .expect("append");
        drop(writer);

        let raw = fs::read_to_string(&path).expect("read raw");
        let lines: Vec<&str> = raw.lines().collect();
        assert_eq!(lines.len(), 2);
        // `myna_stt::TranscriptSegment` carries no rename attribute — the
        // journal must mirror the `transcript://final` event's wire shape.
        assert!(
            lines[0].contains("\"start_sec\"") && !lines[0].contains("\"startSec\""),
            "journal lines must be snake_case, got: {}",
            lines[0]
        );
    }

    #[test]
    fn journal_replays_segments_in_start_time_order_across_tracks() {
        // Decode-completion order (what the writer sees) is NOT
        // chronological order across two tracks — a long system segment
        // can finalize after several shorter mic segments.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("transcript-journal.jsonl");
        let mut writer = JournalWriter::create(&path).expect("create journal");
        writer
            .append(&segment(2.0, 3.0, "second", Speaker::others()))
            .expect("append");
        writer
            .append(&segment(0.0, 1.0, "first", Speaker::me()))
            .expect("append");
        writer
            .append(&segment(1.0, 2.0, "middle", Speaker::me()))
            .expect("append");
        drop(writer);

        let transcript = read_journal(&path).expect("read journal");
        let texts: Vec<&str> = transcript
            .segments
            .iter()
            .map(|segment| segment.text.as_str())
            .collect();
        assert_eq!(texts, ["first", "middle", "second"]);
        assert_eq!(transcript.segments[0].speaker, Speaker::me());
        assert_eq!(transcript.segments[2].speaker, Speaker::others());
    }

    #[test]
    fn journal_read_tolerates_a_truncated_trailing_line() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("transcript-journal.jsonl");
        let mut writer = JournalWriter::create(&path).expect("create journal");
        writer
            .append(&segment(0.0, 1.0, "first", Speaker::me()))
            .expect("append");
        writer
            .append(&segment(1.0, 2.0, "second", Speaker::me()))
            .expect("append");
        drop(writer);

        // Simulate the crash: a half-written third line, no trailing \n.
        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("reopen for crash sim");
        file.write_all(br#"{"start_sec":2.0,"end"#)
            .expect("write truncated line");
        drop(file);

        let transcript = read_journal(&path).expect("truncated tail must be tolerated");
        assert_eq!(transcript.segments.len(), 2);
        assert_eq!(transcript.segments[0].text, "first");
        assert_eq!(transcript.segments[1].text, "second");
    }

    #[test]
    fn journal_read_rejects_interior_corruption() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("transcript-journal.jsonl");
        // Two valid lines with garbage between them — not the trailing
        // truncation this reader exists to tolerate.
        fs::write(
            &path,
            b"{\"start_sec\":0.0,\"end_sec\":1.0,\"text\":\"a\",\"speaker\":\"me\",\"speaker_pinned\":false}\nnot json\n{\"start_sec\":2.0,\"end_sec\":3.0,\"text\":\"c\",\"speaker\":\"me\",\"speaker_pinned\":false}\n",
        )
        .expect("write corrupt journal");

        let result = read_journal(&path);

        assert!(
            matches!(result, Err(AppError::Store(_))),
            "interior corruption must surface, got: {result:?}"
        );
    }

    #[test]
    fn read_journal_of_a_missing_file_is_an_empty_transcript() {
        let dir = tempfile::tempdir().expect("tempdir");

        let transcript = read_journal(&dir.path().join("nope.jsonl")).expect("missing is Ok");

        assert!(transcript.segments.is_empty());
    }

    #[test]
    fn journal_writer_creates_a_missing_parent_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir
            .path()
            .join("meeting-9")
            .join("transcript-journal.jsonl");

        let mut writer = JournalWriter::create(&path).expect("create journal");
        writer
            .append(&segment(0.0, 1.0, "hello", Speaker::me()))
            .expect("append");

        assert!(path.exists());
    }

    /// A sink that simulates a transient disk error: writes succeed until
    /// one would cross `fail_at`, that write lands only its prefix (the
    /// partial line, no trailing newline) and returns `Err`, and every
    /// later write then succeeds again (space was freed). This is exactly
    /// the shape that poisons a journal without protection: the next
    /// append concatenates onto the partial line, creating an INTERIOR
    /// corrupt line the tolerant reader cannot recover from.
    struct FailingSink {
        log: std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
        fail_at: usize,
        tripped: bool,
    }

    impl Write for FailingSink {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            let mut log = self.log.lock().expect("sink log lock");
            if !self.tripped && log.len() + buf.len() > self.fail_at {
                self.tripped = true;
                let take = self.fail_at.saturating_sub(log.len());
                log.extend_from_slice(&buf[..take]);
                return Err(std::io::Error::other("simulated transient write failure"));
            }
            log.extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn line_len(segment: &TranscriptSegment) -> usize {
        let mut line = serde_json::to_vec(segment).expect("serialize");
        line.push(b'\n');
        line.len()
    }

    #[test]
    fn a_failed_append_must_not_poison_the_journal_for_later_appends() {
        // MAJOR-1b: a `write_all` that dies mid-line leaves a partial line
        // with no trailing newline. If the next append concatenates onto
        // that partial line, the journal gains an interior corrupt line —
        // permanent poisoning the tolerant reader cannot recover from.
        let seg1 = segment(0.0, 1.0, "first", Speaker::me());
        let seg2 = segment(1.0, 2.0, "second", Speaker::me());
        let seg3 = segment(2.0, 3.0, "third", Speaker::me());
        // Failure strikes 5 bytes into line 2; line 3's append would then
        // succeed again.
        let fail_at = line_len(&seg1) + 5;
        let log = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut writer = JournalWriter::with_sink(Box::new(FailingSink {
            log: std::sync::Arc::clone(&log),
            fail_at,
            tripped: false,
        }));

        writer.append(&seg1).expect("first append succeeds");
        assert!(
            writer.append(&seg2).is_err(),
            "a mid-write failure must surface to the caller"
        );
        assert!(
            writer.append(&seg3).is_err(),
            "the writer must be marked dead and reject further appends \
             rather than concatenate onto the partial line"
        );

        // Persist exactly what reached the "disk" and read it back with
        // the real tolerant reader.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("transcript-journal.jsonl");
        let bytes = log.lock().expect("sink log lock").clone();
        fs::write(&path, bytes).expect("persist sink log");

        let transcript = read_journal(&path)
            .expect("a failed append must never leave interior corruption the reader can't handle");
        assert_eq!(
            transcript.segments.len(),
            1,
            "only the first complete line may survive"
        );
        assert_eq!(transcript.segments[0].text, "first");
    }
}
