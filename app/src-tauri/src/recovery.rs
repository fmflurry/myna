//! Startup orphan recovery and stop-failure salvage (ADR 0011, Phase 3).
//!
//! The manifest invariant — *manifest existence == a recording is in
//! progress* — makes this module's job mechanical: startup recovery runs in
//! `lib.rs`'s `setup` before any session can exist in the new process, so
//! every `session.json` found at startup is an orphan of a dead process and
//! gets folded back into a real meeting. [`recover_orphaned_sessions`] is
//! that pass. The same scan also carries a legacy pass
//! ([`recover_legacy_orphan`]) for pre-ADR-0011 crashes that never wrote a
//! manifest: meetings frozen at 0 s behind hound's placeholder WAV header,
//! unplayable forever without the header repair.
//!
//! The same fold — repair the unfinalized WAV headers, replay the transcript
//! journal, persist the meeting, delete the durability artifacts — is also
//! what the stop path falls back to when [`crate::session::RecordingSession::stop`]
//! errors (the decode/capture worker died mid-recording). Rather than
//! dead-ending the user with an error and a meeting that vanishes,
//! [`salvage_recording_after_stop_failure`] runs the identical salvage and
//! announces the original failure over [`crate::events::APP_ERROR`] as a non-fatal warning,
//! following the `emit_dropped_audio_warning` precedent in
//! [`crate::commands::recording`].
//!
//! Recovery never re-transcribes (a model load would block boot — the
//! user-triggered `retranscribe_meeting` command covers the undecoded audio
//! tail) and never emits events from the startup pass (the UI's normal
//! `list_meetings` boot shows the recovered meeting). Every per-meeting
//! failure is logged to stderr and skipped: one unreadable artifact must
//! never block the app from starting — the same never-fatal policy as
//! [`crate::paths::harden_existing_data_root`].

use std::fs;
use std::io::ErrorKind;
use std::path::PathBuf;
use std::str::FromStr;

use myna_audio::repair_wav_sizes;

use crate::domain::{Meeting, MeetingId};
use crate::error::AppError;
use crate::events::ErrorPayload;
use crate::session_manifest;
use crate::store::fs_store::FsMeetingStore;
use crate::store::MeetingStore;

/// [`ErrorPayload`]'s `code` carried by the [`crate::events::APP_ERROR`] emitted when a
/// stop had to be salvaged from disk because the recording worker died —
/// the UI's machine-readable signal that the transcript may end early
/// (re-transcribe recovers the tail) even though the meeting itself was
/// saved.
pub const RECORDING_ENDED_WITH_ERROR_CODE: &str = "RECORDING_ENDED_WITH_ERROR";

/// Derives the meetings root from a store path accessor.
///
/// `FsMeetingStore` keeps its root private and its API is frozen; every
/// per-meeting accessor returns `<root>/meetings/<id>/<file>`, so two
/// levels above a manifest path built for any synthetic id is exactly the
/// directory to scan. Pure path arithmetic — touches no disk.
fn meetings_root(store: &FsMeetingStore) -> Option<PathBuf> {
    let probe = store.session_manifest_path(MeetingId::new());
    Some(probe.parent()?.parent()?.to_path_buf())
}

/// Scans `<root>/meetings/*/` and runs both startup passes over each
/// meeting directory:
///
/// - a surviving `session.json` manifest marks an orphaned recording
///   (by construction — this runs before any session can exist in the
///   process), salvaged via [`salvage_meeting_from_disk`];
/// - no manifest triggers the legacy pass, [`recover_legacy_orphan`],
///   which repairs pre-ADR-0011 crashes that never wrote one.
///
/// Directories whose names are not meeting ids are foreign and skipped
/// silently; every other failure is logged and skipped, leaving that
/// meeting's artifacts untouched for a later run — this function never
/// returns an error and never panics on bad data. Emits no events:
/// recovered meetings surface through the UI's normal `list_meetings`
/// boot.
pub fn recover_orphaned_sessions(store: &FsMeetingStore) {
    let Some(meetings_root) = meetings_root(store) else {
        return;
    };
    let entries = match fs::read_dir(&meetings_root) {
        Ok(entries) => entries,
        // A missing meetings root simply means nothing has ever recorded.
        Err(err) if err.kind() == ErrorKind::NotFound => return,
        Err(err) => {
            eprintln!("myna-app: recovery: failed to scan {meetings_root:?}: {err}");
            return;
        }
    };

    for entry in entries.filter_map(|entry| entry.ok()) {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let Some(name) = dir.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Ok(meeting_id) = MeetingId::from_str(name) else {
            continue;
        };
        if !store.session_manifest_path(meeting_id).exists() {
            recover_legacy_orphan(store, meeting_id);
            continue;
        }

        match salvage_meeting_from_disk(store, meeting_id, 0.0) {
            Ok(meeting) => {
                let segments = meeting
                    .transcript
                    .as_ref()
                    .map_or(0, |transcript| transcript.segments.len());
                eprintln!(
                    "myna-app: recovered orphaned recording for meeting {} ({:.1}s, {} \
                     journaled segment(s)) — re-transcribe recovers any undecoded audio tail",
                    meeting.id, meeting.duration_sec, segments
                );
            }
            Err(err) => eprintln!(
                "myna-app: failed to recover orphaned recording for meeting {meeting_id}: \
                 {err} — leaving it untouched for a later run"
            ),
        }
    }
}

/// Startup repair for pre-ADR-0011 orphans (the user's actual stuck
/// meeting): a session recorded before the durability artifacts existed
/// has no `session.json`, so the manifest pass above never sees it. When
/// the app died mid-recording, such a session leaves a meeting that is
/// broken forever — `meeting.json` frozen at 0 s with no transcript, and
/// an `audio.wav` holding every sample the crashed recorder wrote behind
/// hound's zero-data placeholder header, which the UI reports as
/// "Playback error". This pass repairs the WAV headers and stamps the
/// real duration so the recording becomes playable; it never invents a
/// transcript (the user-triggered `retranscribe_meeting` covers that) and
/// never fabricates track files.
///
/// The stuck signature is deliberately narrow — `meeting.json` parses,
/// `duration_sec == 0`, the transcript is empty, and `audio.wav` exists —
/// so finished meetings (any duration > 0, or a non-empty transcript) and
/// meetings without audio are passed over untouched. Safety: this runs in
/// `setup` before any session can exist in-process, and every new-code
/// live session carries a manifest (dirs with one take the salvage
/// branch, never this pass). A legitimately-empty 0 s meeting that does
/// have an `audio.wav` is harmless to pass through — `repair_wav_sizes`
/// is idempotent and the save rewrites the same values. Any failure is
/// logged and skipped: like the rest of recovery, this must never block
/// boot.
fn recover_legacy_orphan(store: &FsMeetingStore, meeting_id: MeetingId) {
    // A missing or unparseable `meeting.json` is not this pass's problem
    // (nothing here is safe to rewrite) — skip, logged.
    let meeting = match store.get(meeting_id) {
        Ok(meeting) => meeting,
        Err(err) => {
            eprintln!("myna-app: recovery: skipping legacy check for meeting {meeting_id}: {err}");
            return;
        }
    };
    if meeting.duration_sec > 0.0 {
        return;
    }
    if meeting
        .transcript
        .as_ref()
        .is_some_and(|transcript| !transcript.segments.is_empty())
    {
        return;
    }
    let audio_path = store.audio_path(meeting_id);
    if !audio_path.exists() {
        // 0 s, no transcript, no audio: nothing was ever captured (or it
        // was discarded) — nothing to repair.
        return;
    }

    let audio_duration_sec = repair_existing_wavs(store, meeting_id);
    let updated = meeting
        .with_duration(meeting.duration_sec.max(audio_duration_sec))
        .with_audio_path(audio_path);
    match store.save(&updated) {
        Ok(()) => eprintln!(
            "myna-app: recovered legacy recording for meeting {} ({:.1}s from repaired \
             audio) — re-transcribe recovers the transcript",
            updated.id, updated.duration_sec
        ),
        Err(err) => eprintln!(
            "myna-app: recovery: failed to save legacy repair for meeting {meeting_id}: {err}"
        ),
    }
}

/// Repairs the size fields of every EXISTING WAV artifact of `meeting_id`
/// (`audio.wav`, `track-mic.wav`, `track-system.wav`) — a file that was
/// never created is never fabricated; track presence is what encodes the
/// capture source. Returns `audio.wav`'s repaired duration in seconds, or
/// `0.0` when it is absent or unrepairable. A per-file repair failure
/// (e.g. a non-canonical header, or data beyond the 4 GiB a canonical
/// 32-bit WAV header can describe) is logged and skipped: it must not
/// cost the user the transcript that IS recoverable.
fn repair_existing_wavs(store: &FsMeetingStore, meeting_id: MeetingId) -> f32 {
    let audio_path = store.audio_path(meeting_id);
    let mic_path = store.mic_track_path(meeting_id);
    let system_path = store.system_track_path(meeting_id);

    let mut audio_duration_sec = 0.0_f32;
    for path in [
        audio_path.as_path(),
        mic_path.as_path(),
        system_path.as_path(),
    ] {
        if !path.exists() {
            continue;
        }
        match repair_wav_sizes(path) {
            Ok(stats) => {
                if path == audio_path.as_path() {
                    audio_duration_sec = stats.duration.as_secs_f32();
                }
            }
            Err(err) => eprintln!(
                "myna-app: recovery: failed to repair {path:?} for meeting {meeting_id}: \
                 {err} — continuing with the rest of the recording"
            ),
        }
    }
    audio_duration_sec
}

/// The shared salvage fold, used by the startup orphan pass (with a `0.0`
/// duration floor) and by the stop path's dead-worker fallback (with the
/// session's elapsed wall-clock as the floor).
///
/// Steps, in order:
/// 1. `repair_wav_sizes` on each EXISTING WAV via [`repair_existing_wavs`]
///    (see that helper for the never-fabricate / never-fatal policy).
/// 2. Fold the transcript journal (tolerant of a truncated trailing line).
/// 3. Duration = max(`fallback_duration_sec`, repaired `audio.wav`
///    duration, last journal segment `end_sec`, and the ALREADY-PERSISTED
///    duration — salvage is monotonic, see below).
/// 4. Re-read `meeting.json`, apply transcript/duration/audio path, save.
/// 5. Delete manifest + journal — only after the save succeeded, so a
///    failed save leaves everything in place for a later retry.
///
/// Monotonicity (MINOR-3): when a successful stop-save's artifact CLEANUP
/// failed, this fold re-runs on the next boot over an already richer
/// meeting. The journal can hold FEWER segments than the persisted
/// transcript (it only ever saw finals up to the crash point), and the
/// fallback duration is `0.0` from the startup pass — without the maxes
/// below, a re-salvage would SHRINK a saved meeting. So the transcript is
/// only replaced when the journal fold has at least as many segments, and
/// the duration never decreases.
///
/// Steps 2-4 propagate errors (the callers decide the failure policy); a
/// corrupt `meeting.json` therefore surfaces here as `store.get` failing,
/// which is what keeps the artifacts for a later run.
pub fn salvage_meeting_from_disk(
    store: &FsMeetingStore,
    meeting_id: MeetingId,
    fallback_duration_sec: f32,
) -> Result<Meeting, AppError> {
    let audio_path = store.audio_path(meeting_id);
    let audio_duration_sec = repair_existing_wavs(store, meeting_id);

    let journal_path = store.transcript_journal_path(meeting_id);
    let journaled = session_manifest::read_journal(&journal_path)?;
    let journal_end_sec = journaled
        .segments
        .last()
        .map(|segment| segment.end_sec)
        .unwrap_or(0.0);

    let meeting = store.get(meeting_id)?;
    let duration_sec = fallback_duration_sec
        .max(audio_duration_sec)
        .max(journal_end_sec)
        .max(meeting.duration_sec);
    let transcript = match meeting.transcript.as_ref() {
        Some(existing) if existing.segments.len() > journaled.segments.len() => {
            eprintln!(
                "myna-app: recovery: meeting {meeting_id} already holds {} persisted \
                 segment(s) — keeping them over the journal's {} (salvage never shrinks \
                 a saved meeting)",
                existing.segments.len(),
                journaled.segments.len()
            );
            existing.clone()
        }
        _ => journaled,
    };
    let updated = meeting
        .with_transcript(transcript)
        .with_duration(duration_sec);
    // Only point `audio_path` at a file that actually exists — a crash
    // before `on_native_rate` fired can leave `audio.wav` never created,
    // and a meeting must never claim playback audio it does not have.
    let updated = if audio_path.exists() {
        updated.with_audio_path(audio_path)
    } else {
        updated
    };
    store.save(&updated)?;

    // Durability artifacts are cleaned up only after the meeting is durably
    // saved; a cleanup failure is logged, never fatal (the meeting is
    // already persisted, and the salvage fold is idempotent for a later
    // run's retry).
    if let Err(err) = session_manifest::delete_manifest(&store.session_manifest_path(meeting_id)) {
        eprintln!(
            "myna-app: recovery: failed to delete session manifest for meeting {meeting_id}: \
             {err}"
        );
    }
    if let Err(err) = session_manifest::delete_journal(&journal_path) {
        eprintln!(
            "myna-app: recovery: failed to delete transcript journal for meeting \
             {meeting_id}: {err}"
        );
    }

    Ok(updated)
}

/// Builds the non-fatal [`crate::events::APP_ERROR`] payload announcing that a recording
/// ended through the salvage path, carrying the original worker error's
/// message for diagnosis. Extracted from
/// [`salvage_recording_after_stop_failure`] so the wire contract (code +
/// message) is directly testable.
pub fn recording_ended_error_payload(original_error: &AppError) -> ErrorPayload {
    ErrorPayload {
        code: RECORDING_ENDED_WITH_ERROR_CODE.to_string(),
        message: original_error.to_string(),
    }
}

/// The stop path's never-dead-end fallback: when
/// [`crate::session::RecordingSession::stop`] returns `Err` (the worker
/// died mid-recording), salvage the meeting from disk exactly like startup
/// recovery does — with the session's elapsed wall-clock as the duration
/// floor — and announce the original failure through `emit_error` as a
/// non-fatal [`crate::events::APP_ERROR`] warning.
///
/// `emit_error` is injected (rather than taking an `AppHandle`) following
/// the [`crate::session::announce_resolved_system_source`] precedent, so
/// the persistence + emission contract is integration-testable without a
/// live Tauri app; the command wires it to `app.emit(APP_ERROR, ..)`.
///
/// On a salvage failure (e.g. an unreadable `meeting.json`) the original
/// worker error is returned — the user learns about the real failure, and
/// the manifest stays for startup recovery to retry on the next launch.
pub fn salvage_recording_after_stop_failure(
    store: &FsMeetingStore,
    meeting_id: MeetingId,
    elapsed_sec: f32,
    original_error: &AppError,
    emit_error: impl FnOnce(ErrorPayload),
) -> Result<Meeting, AppError> {
    let meeting = salvage_meeting_from_disk(store, meeting_id, elapsed_sec)?;
    emit_error(recording_ended_error_payload(original_error));
    Ok(meeting)
}
