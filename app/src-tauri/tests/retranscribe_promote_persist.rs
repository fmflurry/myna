//! Regression coverage for a HIGH-severity data-loss bug that used to exist
//! in `run_retranscribe`'s replace-audio branch
//! (`app/src-tauri/src/commands/import.rs`): the new audio was promoted into
//! place — an eager `fs::rename(staged, &audio_dest)` — *before* the old
//! transcript was backed up (`ingest::backup_transcript`) and the new
//! transcript was persisted (`state.store.save`). If backup or persistence
//! failed after the rename had already succeeded, `run_retranscribe`
//! returned `Err`, but `audio.wav` on disk was now the *new* audio while
//! `meeting.json` still held the *old* transcript — permanently desynced,
//! since the old transcript's segment timestamps and text describe audio
//! that no longer exists on disk. `run_retranscribe`'s own doc comment
//! claims "a cancellation (or any other failure) mid-conversion or
//! mid-transcribe must leave the meeting's existing `audio.wav` and
//! transcript byte-for-byte untouched" — a guarantee that did not hold once
//! the promote-rename had already run ahead of persistence.
//!
//! `run_retranscribe` itself is a private fn taking a real `AppHandle`,
//! which this workspace has no test harness to construct (see
//! `tests/import.rs`'s module doc comment for the established reason). The
//! fix extracted the promote+persist step into a single, `AppHandle`-free,
//! all-or-nothing helper that `run_retranscribe`'s replace-audio branch now
//! delegates to instead of running `fs::rename` eagerly up front:
//!
//! ```ignore
//! pub fn promote_and_persist_retranscribe(
//!     store: &FsMeetingStore,
//!     staged: &Path,
//!     audio_dest: &Path,
//!     previous_transcript: Option<(&Transcript, &BTreeMap<String, String>)>,
//!     updated: &Meeting,
//! ) -> Result<(), AppError>
//! ```
//! in `myna_app::commands::import` (a `pub mod`, so reachable from an
//! external test binary). Its contract: `staged` is promoted over
//! `audio_dest` only once backing up `previous_transcript` (when `Some`)
//! and persisting `updated` via `store.save` have both fully succeeded —
//! never before. On any failure, `audio_dest` must be left exactly as it
//! was before the call.
//!
//! It is kept in its own file, separate from `tests/import.rs`, so a future
//! regression in this seam cannot collaterally block that file's unrelated,
//! already-passing tests (a single `tests/*.rs` file is one compiled
//! binary; a compile error in one file cannot affect another file's
//! binary).
//!
//! `run_retranscribe` now calls the helper, deferring its
//! `fs::rename(staged, &audio_dest)` until after persistence is confirmed
//! rather than performing it eagerly up front, so this test's fault
//! injection — forcing the transcript backup to fail — produces a result
//! where `audio_dest` still holds the OLD bytes, matching the OLD
//! transcript still readable via `store.get`.

use std::collections::BTreeMap;
use std::fs;

use myna_app::commands::import::promote_and_persist_retranscribe;
use myna_app::domain::Meeting;
use myna_app::store::fs_store::FsMeetingStore;
use myna_app::store::MeetingStore;
use myna_stt::{Speaker, Transcript, TranscriptSegment};

#[test]
fn promote_and_persist_retranscribe_leaves_audio_byte_identical_to_the_old_file_when_persistence_fails(
) {
    // Arrange: a meeting with an existing, already-persisted transcript and
    // an existing `audio.wav` — the state `run_retranscribe` starts from.
    let dir = tempfile::tempdir().expect("tempdir");
    let store = FsMeetingStore::new(dir.path());

    let old_transcript = Transcript {
        segments: vec![TranscriptSegment {
            start_sec: 0.0,
            end_sec: 1.0,
            text: "old segment describing the OLD audio".to_string(),
            speaker: Speaker::unknown(),
            speaker_pinned: false,
        }],
    };
    let meeting = Meeting::new("desync-repro").with_transcript(old_transcript.clone());
    store
        .save(&meeting)
        .expect("persist the pre-existing meeting");

    let audio_dest = store.audio_path(meeting.id);
    let old_audio_bytes = b"OLD-AUDIO-BYTES-BEFORE-RETRANSCRIBE";
    fs::write(&audio_dest, old_audio_bytes).expect("seed the meeting's existing audio.wav");

    // A staged replacement file, standing in for a successfully converted
    // and transcribed replacement source (conversion/transcription
    // themselves are exercised elsewhere and are not the bug under test
    // here).
    let staged = audio_dest.with_extension("wav.staged");
    let new_audio_bytes = b"NEW-AUDIO-BYTES-FROM-SUCCESSFUL-TRANSCRIBE";
    fs::write(&staged, new_audio_bytes).expect("seed the staged replacement audio");

    // Force persistence to fail: pre-seed the transcript backup's
    // destination as an existing directory — this codebase's own
    // established fault-injection lever (see `ingest.rs`'s
    // `backup_transcript_cleans_up_its_tmp_file_when_the_rename_fails`,
    // which forces the same `fs::rename` the same way).
    let meeting_dir = audio_dest.parent().expect("audio path has a parent dir");
    fs::create_dir_all(meeting_dir.join("transcript.previous.json"))
        .expect("make the backup path an existing directory");

    let new_transcript = Transcript {
        segments: vec![TranscriptSegment {
            start_sec: 0.0,
            end_sec: 2.0,
            text: "new segment describing the NEW audio".to_string(),
            speaker: Speaker::unknown(),
            speaker_pinned: false,
        }],
    };
    let updated = meeting.with_transcript(new_transcript);

    // Act: the extracted all-or-nothing promote+persist step —
    // `run_retranscribe`'s replace-audio branch calls exactly this instead
    // of the old unconditional `fs::rename` followed by separate
    // `backup_transcript`/`store.save` calls.
    let result = promote_and_persist_retranscribe(
        &store,
        &staged,
        &audio_dest,
        Some((&old_transcript, &BTreeMap::new())),
        &updated,
    );

    // Assert: the fault injection actually forced failure.
    assert!(
        result.is_err(),
        "the fault injection must actually force the persistence step to fail"
    );

    // Assert: the persisted transcript must remain the OLD one — since
    // persistence never completed, `store.save` must never have run with
    // the new transcript.
    let persisted = store
        .get(meeting.id)
        .expect("meeting must still be readable");
    assert_eq!(
        persisted.transcript.as_ref(),
        Some(&old_transcript),
        "persisted transcript must remain the old one when persistence fails"
    );

    // Assert: the invariant `run_retranscribe`'s doc comment promises — on
    // failure, `audio.wav` must remain the OLD bytes, mutually consistent
    // with the OLD transcript still persisted above. This is the exact
    // guarantee the old promote-before-persist ordering violated; it only
    // holds because the promote-rename is deferred until after persistence
    // is confirmed to succeed.
    let audio_bytes_after_failure = fs::read(&audio_dest).expect("audio.wav must still exist");
    assert_eq!(
        audio_bytes_after_failure.as_slice(),
        old_audio_bytes.as_slice(),
        "audio.wav must remain the OLD bytes when persistence fails — promoting the staged \
         replacement must be deferred until backup_transcript and store.save have both \
         succeeded, not performed eagerly before those steps are attempted"
    );
}

/// Companion happy-path test: guards against a degenerate implementation
/// that always returns `Err` (which would make the failure-path test above
/// trivially pass without actually implementing the promote). On success,
/// the staged file must actually be promoted over `audio_dest`, and the new
/// transcript must be the one persisted.
#[test]
fn promote_and_persist_retranscribe_promotes_the_staged_audio_and_persists_the_new_transcript_on_success(
) {
    // Arrange: same shape as above, but with nothing forced to fail.
    let dir = tempfile::tempdir().expect("tempdir");
    let store = FsMeetingStore::new(dir.path());

    let old_transcript = Transcript {
        segments: vec![TranscriptSegment {
            start_sec: 0.0,
            end_sec: 1.0,
            text: "old segment".to_string(),
            speaker: Speaker::unknown(),
            speaker_pinned: false,
        }],
    };
    let meeting = Meeting::new("promote-success").with_transcript(old_transcript.clone());
    store
        .save(&meeting)
        .expect("persist the pre-existing meeting");

    let audio_dest = store.audio_path(meeting.id);
    fs::write(&audio_dest, b"OLD-AUDIO").expect("seed the meeting's existing audio.wav");

    let staged = audio_dest.with_extension("wav.staged");
    let new_audio_bytes = b"NEW-AUDIO-BYTES";
    fs::write(&staged, new_audio_bytes).expect("seed the staged replacement audio");

    let new_transcript = Transcript {
        segments: vec![TranscriptSegment {
            start_sec: 0.0,
            end_sec: 2.0,
            text: "new segment".to_string(),
            speaker: Speaker::unknown(),
            speaker_pinned: false,
        }],
    };
    let updated = meeting.with_transcript(new_transcript.clone());

    // Act
    let result = promote_and_persist_retranscribe(
        &store,
        &staged,
        &audio_dest,
        Some((&old_transcript, &BTreeMap::new())),
        &updated,
    );

    // Assert
    assert!(result.is_ok(), "expected success, got: {result:?}");
    let audio_bytes = fs::read(&audio_dest).expect("audio.wav must exist");
    assert_eq!(
        audio_bytes.as_slice(),
        new_audio_bytes.as_slice(),
        "on success, the staged replacement must be promoted over audio_dest"
    );
    let persisted = store
        .get(meeting.id)
        .expect("meeting must still be readable");
    assert_eq!(
        persisted.transcript.as_ref(),
        Some(&new_transcript),
        "on success, the new transcript must be the one persisted"
    );
}
