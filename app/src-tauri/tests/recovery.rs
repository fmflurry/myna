//! Integration tests for Phase 3 of the session-resilience work (ADR 0011):
//! startup orphan recovery (`myna_app::recovery`), the stop path's
//! dead-worker salvage, and the durability primitives they consume
//! (`session_manifest`, `myna_audio::repair_wav_sizes`) — exercised against
//! real temporary directories, mirroring `tests/ingest.rs`'s WAV-fixture
//! style and `tests/state.rs`'s tempdir-rooted `FsMeetingStore` pattern.
//!
//! Like `tests/import.rs`, the stop-failure scenario cannot drive the real
//! `#[tauri::command]` (no `tauri::test` mock-app harness exists in this
//! workspace), so it exercises
//! `recovery::salvage_recording_after_stop_failure` directly — the exact
//! function the command calls — and observes the would-be `APP_ERROR`
//! emission through the injected `emit_error` closure, following the
//! `session::announce_resolved_system_source` precedent for testing
//! emissions without an `AppHandle`.
//!
//! All WAV fixtures are generated at test time; no binaries are committed.

use std::io::Write;
use std::path::Path;

use myna_app::domain::MeetingId;
use myna_app::error::AppError;
use myna_app::events::ErrorPayload;
use myna_app::recovery::{
    recording_ended_error_payload, recover_orphaned_sessions, salvage_recording_after_stop_failure,
    RECORDING_ENDED_WITH_ERROR_CODE,
};
use myna_app::session_manifest::{
    delete_manifest, read_journal, read_manifest, write_manifest, JournalWriter, SessionManifest,
};
use myna_app::store::fs_store::FsMeetingStore;
use myna_app::store::MeetingStore;
use myna_audio::{repair_wav_sizes, CaptureSource};
use myna_stt::{Speaker, Transcript, TranscriptSegment};

/// Writes a `frames`-frame WAV fixture at `path` (16-bit PCM, sine tone —
/// only the shape matters), finalized so its header is already correct.
/// Mirrors `tests/ingest.rs`'s helper.
fn write_wav_fixture(path: &Path, sample_rate: u32, channels: u16, frames: usize) {
    let spec = hound::WavSpec {
        channels,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec).expect("create wav fixture");
    for i in 0..frames {
        let t = i as f32 / sample_rate as f32;
        let sample = (t * 440.0 * std::f32::consts::TAU).sin();
        let pcm = (sample * i16::MAX as f32 * 0.5) as i16;
        for _ in 0..channels {
            writer.write_sample(pcm).expect("write sample");
        }
    }
    writer.finalize().expect("finalize wav fixture");
}

/// Simulates the exact shape a `kill -9` leaves behind: every sample
/// reaches the disk (a plain unbuffered `File` writes each `write_sample`
/// straight to the OS), but the header patch that `finalize()` — or
/// `hound`'s `Drop` — would have applied never runs, because the writer is
/// `mem::forget`-ed. Mirrors `myna-audio`'s own `write_crashed_wav` test
/// helper; `myna_audio::WavRecorder` itself wraps a `BufWriter`, so
/// forgetting one would (realistically, but non-deterministically) also
/// lose its unflushed tail — this fixture keeps the frame count exact so
/// the repair assertions can be precise.
fn write_crashed_wav(path: &Path, sample_rate: u32, channels: u16, frames: usize) {
    let spec = hound::WavSpec {
        channels,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let file = std::fs::File::create(path).expect("create crashed wav");
    let mut writer = hound::WavWriter::new(file, spec).expect("hound writer");
    for frame in 0..frames {
        for _ in 0..channels {
            writer
                .write_sample((frame % 100) as i16)
                .expect("write sample");
        }
    }
    std::mem::forget(writer);
}

fn segment(start_sec: f32, end_sec: f32, text: &str, speaker: Speaker) -> TranscriptSegment {
    TranscriptSegment {
        start_sec,
        end_sec,
        text: text.to_string(),
        speaker,
        speaker_pinned: false,
    }
}

/// Writes `segments` to the journal at `path`, in the given (decode-
/// completion) order.
fn write_journal(path: &Path, segments: &[TranscriptSegment]) {
    let mut writer = JournalWriter::create(path).expect("create journal");
    for segment in segments {
        writer.append(segment).expect("append segment");
    }
}

/// Seeds a meeting exactly as a crashed process would leave it: a saved
/// `meeting.json` (no transcript/duration), a manifest, a journal, and the
/// given crashed WAV files. Returns the meeting id.
fn seed_orphan(
    store: &FsMeetingStore,
    title: &str,
    source: CaptureSource,
    journal_segments: &[TranscriptSegment],
    crashed_audio: Option<(u32, u16, usize)>,
    crashed_mic_track: Option<usize>,
    crashed_system_track: Option<usize>,
) -> MeetingId {
    let meeting = store.create(title).expect("create meeting");
    let id = meeting.id;

    if let Some((sample_rate, channels, frames)) = crashed_audio {
        write_crashed_wav(&store.audio_path(id), sample_rate, channels, frames);
    }
    if let Some(frames) = crashed_mic_track {
        write_crashed_wav(&store.mic_track_path(id), 16_000, 1, frames);
    }
    if let Some(frames) = crashed_system_track {
        write_crashed_wav(&store.system_track_path(id), 16_000, 1, frames);
    }
    write_journal(&store.transcript_journal_path(id), journal_segments);
    write_manifest(
        &store.session_manifest_path(id),
        &SessionManifest::new(&id.to_string(), source, None),
    )
    .expect("write manifest");
    id
}

// --- durability primitives, end-to-end through the public API ------------

#[test]
fn manifest_round_trips_and_the_atomic_tmp_file_never_lingers() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = FsMeetingStore::new(dir.path());
    let id = MeetingId::new();
    let path = store.session_manifest_path(id);
    let manifest = SessionManifest::new(
        &id.to_string(),
        CaptureSource::Mixed,
        Some("app:com.example.meet".to_string()),
    );

    write_manifest(&path, &manifest).expect("write manifest");

    assert!(path.is_file(), "manifest must exist after write");
    assert_eq!(read_manifest(&path).expect("read manifest"), manifest);
    assert!(
        !path.with_extension("json.tmp").exists(),
        "the atomic tmp file must be consumed by the rename"
    );

    delete_manifest(&path).expect("delete manifest");
    assert!(!path.exists());
    // The stop/recovery cleanup paths call this defensively — a second
    // delete of an already-absent file must be Ok, not an error.
    delete_manifest(&path).expect("re-delete of a missing manifest is Ok");
}

#[test]
fn journal_fold_survives_a_truncated_trailing_line_and_keeps_chronological_order() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = FsMeetingStore::new(dir.path());
    let id = MeetingId::new();
    let journal_path = store.transcript_journal_path(id);

    // Decode-completion order, not chronological: a long system segment
    // finalized before an earlier mic segment.
    write_journal(
        &journal_path,
        &[
            segment(3.0, 4.5, "there", Speaker::others()),
            segment(0.0, 1.0, "hello", Speaker::me()),
        ],
    );
    // The crash signature: a half-written line with no trailing newline.
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&journal_path)
        .expect("reopen journal");
    file.write_all(br#"{"start_sec":5.0,"end"#)
        .expect("write truncated line");
    drop(file);

    let transcript = read_journal(&journal_path).expect("truncated tail must be tolerated");

    let texts: Vec<&str> = transcript
        .segments
        .iter()
        .map(|segment| segment.text.as_str())
        .collect();
    assert_eq!(
        texts,
        ["hello", "there"],
        "fold order must be ascending by start_sec"
    );
    assert_eq!(transcript.segments[0].speaker, Speaker::me());
    assert_eq!(transcript.segments[1].speaker, Speaker::others());
}

// --- startup orphan recovery ----------------------------------------------

#[test]
fn orphaned_mixed_recording_is_recovered_and_the_second_pass_is_a_no_op() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = FsMeetingStore::new(dir.path());
    // 2.0 s of 48 kHz stereo `audio.wav` (96_000 channel-frames), a full
    // mic + system track, and a journal whose last segment ends at 4.5 s —
    // later than the audio, so duration must come from the journal.
    let id = seed_orphan(
        &store,
        "Crashed standup",
        CaptureSource::Mixed,
        &[
            segment(3.0, 4.5, "action items", Speaker::others()),
            segment(0.0, 1.0, "hello", Speaker::me()),
        ],
        Some((48_000, 2, 96_000)),
        Some(32_000),
        Some(32_000),
    );
    let audio_path = store.audio_path(id);
    let mic_path = store.mic_track_path(id);
    let system_path = store.system_track_path(id);

    recover_orphaned_sessions(&store);

    let recovered = store.get(id).expect("recovered meeting must load");
    let transcript = recovered
        .transcript
        .expect("journal transcript must be folded in");
    let texts: Vec<&str> = transcript
        .segments
        .iter()
        .map(|segment| segment.text.as_str())
        .collect();
    assert_eq!(texts, ["hello", "action items"]);
    assert!(
        (recovered.duration_sec - 4.5).abs() < 0.01,
        "duration must be max(audio 2.0s, journal end 4.5s), got {}",
        recovered.duration_sec
    );
    assert_eq!(
        recovered.audio_path.as_deref(),
        Some(audio_path.as_path()),
        "a meeting with audio.wav on disk must point at it"
    );

    assert!(
        !store.session_manifest_path(id).exists(),
        "the manifest must be deleted once the meeting is saved"
    );
    assert!(
        !store.transcript_journal_path(id).exists(),
        "the journal must be deleted once the meeting is saved"
    );
    // The audio itself must survive — repaired, not deleted, not truncated.
    for path in [&audio_path, &mic_path, &system_path] {
        assert!(path.is_file(), "{path:?} must still exist after recovery");
    }
    let reader = hound::WavReader::open(&audio_path).expect("repaired audio.wav must read");
    assert_eq!(
        reader.duration() as usize,
        96_000,
        "the repaired header must describe the exact frame count"
    );

    // A second startup pass must find no manifests and change nothing.
    let before = store.get(id).expect("re-read");
    recover_orphaned_sessions(&store);
    let after = store.get(id).expect("re-read after second pass");
    assert_eq!(
        before, after,
        "recovery must be a no-op once artifacts are gone"
    );
}

#[test]
fn orphaned_mic_only_recording_recovers_without_fabricating_a_system_track() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = FsMeetingStore::new(dir.path());
    // 6.0 s of 48 kHz stereo audio, a 16 kHz mono mic track, and NO
    // `track-system.wav` at all — the mic-only layout. The journal ends at
    // 1.0 s, so duration must come from the (longer) audio.
    let id = seed_orphan(
        &store,
        "Crashed solo call",
        CaptureSource::Microphone,
        &[segment(0.0, 1.0, "notes to self", Speaker::me())],
        Some((48_000, 2, 288_000)),
        Some(96_000),
        None,
    );

    recover_orphaned_sessions(&store);

    let recovered = store.get(id).expect("recovered meeting must load");
    let transcript = recovered.transcript.expect("transcript folded in");
    assert_eq!(transcript.segments.len(), 1);
    assert_eq!(transcript.segments[0].speaker, Speaker::me());
    assert!(
        (recovered.duration_sec - 6.0).abs() < 0.01,
        "duration must be the repaired audio.wav's 6.0s (longer than the journal), got {}",
        recovered.duration_sec
    );
    assert!(
        !store.system_track_path(id).exists(),
        "recovery must never fabricate a track file the capture never wrote"
    );
    assert!(
        store.mic_track_path(id).is_file(),
        "the mic track must remain"
    );
    assert!(!store.session_manifest_path(id).exists());
    assert!(!store.transcript_journal_path(id).exists());
}

#[test]
fn corrupt_meeting_json_is_skipped_not_fatal_and_its_manifest_is_kept() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = FsMeetingStore::new(dir.path());

    // A healthy orphan and a corrupt one, side by side — the corrupt one
    // must not stop the healthy one from recovering.
    let healthy = seed_orphan(
        &store,
        "Fine meeting",
        CaptureSource::Microphone,
        &[segment(0.0, 2.0, "all good", Speaker::me())],
        Some((48_000, 2, 96_000)),
        Some(32_000),
        None,
    );
    let broken = seed_orphan(
        &store,
        "Corrupt meeting",
        CaptureSource::Microphone,
        &[segment(0.0, 1.0, "unreachable", Speaker::me())],
        Some((48_000, 2, 48_000)),
        Some(16_000),
        None,
    );
    let broken_meeting_json = store
        .audio_path(broken)
        .parent()
        .expect("meeting dir")
        .join("meeting.json");
    std::fs::write(&broken_meeting_json, b"{ not valid json").expect("corrupt meeting.json");

    recover_orphaned_sessions(&store);

    // The corrupt meeting: skipped, directory kept, manifest kept (a later
    // run — or a human — can still deal with it), and NOT listed.
    assert!(
        store.session_manifest_path(broken).exists(),
        "a meeting whose salvage failed must keep its manifest"
    );
    assert!(
        broken_meeting_json.exists(),
        "the corrupt meeting's directory must be kept, not deleted"
    );
    assert!(
        store.get(broken).is_err(),
        "the corrupt meeting.json must not be rewritten"
    );

    // The healthy meeting: recovered normally in the same pass.
    let recovered = store
        .get(healthy)
        .expect("healthy orphan must still recover");
    let transcript = recovered.transcript.expect("transcript folded in");
    assert_eq!(transcript.segments.len(), 1);
    assert!(!store.session_manifest_path(healthy).exists());
}

// --- stop-path dead-worker salvage ----------------------------------------

#[test]
fn stop_failure_salvage_persists_the_meeting_and_emits_recording_ended_with_error() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = FsMeetingStore::new(dir.path());
    // 2.0 s of audio, journal ending at 4.5 s, and a 10 s elapsed clock —
    // duration must take the max (the wall clock).
    let id = seed_orphan(
        &store,
        "Died mid-call",
        CaptureSource::Microphone,
        &[
            segment(3.0, 4.5, "still listening", Speaker::others()),
            segment(0.0, 1.0, "hello", Speaker::me()),
        ],
        Some((48_000, 2, 96_000)),
        Some(32_000),
        None,
    );
    let original_error = AppError::Store("recording worker thread panicked".to_string());
    let mut emitted: Option<ErrorPayload> = None;

    let salvaged =
        salvage_recording_after_stop_failure(&store, id, 10.0, &original_error, |payload| {
            emitted = Some(payload)
        })
        .expect("a dead worker must not dead-end the stop — the meeting must be saved");

    let transcript = salvaged
        .transcript
        .as_ref()
        .expect("journal transcript must be folded in");
    let texts: Vec<&str> = transcript
        .segments
        .iter()
        .map(|segment| segment.text.as_str())
        .collect();
    assert_eq!(texts, ["hello", "still listening"]);
    assert!(
        (salvaged.duration_sec - 10.0).abs() < 0.01,
        "duration must be the elapsed floor (10s > audio 2s > journal 4.5s), got {}",
        salvaged.duration_sec
    );
    assert_eq!(
        salvaged.audio_path.as_deref(),
        Some(store.audio_path(id).as_path())
    );

    // The persisted meeting — not just the returned value — must carry the
    // transcript, and the durability artifacts must be cleaned up.
    let on_disk = store.get(id).expect("salvaged meeting must be saved");
    assert_eq!(on_disk, salvaged);
    assert!(
        !store.session_manifest_path(id).exists(),
        "manifest must be deleted"
    );
    assert!(
        !store.transcript_journal_path(id).exists(),
        "journal must be deleted"
    );

    // The non-fatal APP_ERROR announcement: correct code, original message.
    let payload = emitted.expect("stop salvage must emit exactly one APP_ERROR");
    assert_eq!(payload.code, RECORDING_ENDED_WITH_ERROR_CODE);
    assert_eq!(payload.code, "RECORDING_ENDED_WITH_ERROR");
    assert!(
        payload.message.contains("recording worker thread panicked"),
        "the original worker error must be carried in the payload, got: {}",
        payload.message
    );
}

#[test]
fn recording_ended_payload_is_a_stable_code_plus_the_original_message() {
    let err = AppError::Audio(myna_audio::AudioError::Wav("disk on fire".to_string()));
    let payload = recording_ended_error_payload(&err);
    assert_eq!(payload.code, RECORDING_ENDED_WITH_ERROR_CODE);
    assert!(payload.message.contains("disk on fire"));
}

#[test]
fn stop_failure_salvage_surfaces_the_original_error_when_the_meeting_is_unreadable() {
    // If even the salvage fails (corrupt meeting.json), the fallback must
    // not invent a meeting — the original error is what the command returns
    // (and the artifacts stay for startup recovery to retry).
    let dir = tempfile::tempdir().expect("tempdir");
    let store = FsMeetingStore::new(dir.path());
    let id = seed_orphan(
        &store,
        "Unreadable",
        CaptureSource::Microphone,
        &[segment(0.0, 1.0, "x", Speaker::me())],
        Some((48_000, 2, 48_000)),
        None,
        None,
    );
    std::fs::write(
        store
            .audio_path(id)
            .parent()
            .expect("meeting dir")
            .join("meeting.json"),
        b"garbage",
    )
    .expect("corrupt meeting.json");
    let original_error = AppError::Store("recording worker thread panicked".to_string());

    let result =
        salvage_recording_after_stop_failure(&store, id, 5.0, &original_error, |payload| {
            panic!(
                "no APP_ERROR may be emitted when the salvage failed: code={} message={}",
                payload.code, payload.message
            )
        });

    assert!(result.is_err(), "an unsalvageable stop must be an Err");
    assert!(
        store.session_manifest_path(id).exists(),
        "a failed salvage must keep the manifest for startup recovery"
    );
}

// --- repair_wav_sizes end-to-end ------------------------------------------

#[test]
fn repair_wav_sizes_recovers_exact_frames_from_a_forgetten_recorder() {
    // The end-to-end crash shape: a recorder whose process died before any
    // finalize/Drop could patch the header (see `write_crashed_wav`'s
    // `mem::forget`), repaired by the same call recovery makes.
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("audio.wav");
    let frames = 48_000; // 3.0 s of 16 kHz mono
    write_crashed_wav(&path, 16_000, 1, frames);

    // Pre-repair, the data is all there but the header claims none of it —
    // this is the bug the repair exists to fix.
    let broken = hound::WavReader::open(&path).expect("crashed wav must still parse");
    assert_eq!(broken.len(), 0, "an unfinalized header must read as empty");

    let stats = repair_wav_sizes(&path).expect("repair must succeed");
    assert_eq!(stats.frames as usize, frames);
    assert_eq!(stats.duration, std::time::Duration::from_secs(3));

    let mut reader = hound::WavReader::open(&path).expect("repaired wav must open");
    assert_eq!(
        reader.len() as usize,
        frames,
        "WavReader must see the exact frame count after repair"
    );
    assert_eq!(reader.samples::<i16>().count(), frames);

    // Idempotent: a second repair (e.g. a failed cleanup leaving the
    // manifest behind for the next startup) changes nothing.
    let again = repair_wav_sizes(&path).expect("repair is idempotent");
    assert_eq!(again.frames, stats.frames);

    // A healthy finalized fixture repairs to itself untouched.
    let healthy = dir.path().join("track-mic.wav");
    write_wav_fixture(&healthy, 16_000, 1, 1_600);
    let healthy_stats = repair_wav_sizes(&healthy).expect("healthy wav must repair cleanly");
    assert_eq!(healthy_stats.frames as usize, 1_600);
}

// --- salvage monotonicity (MINOR-3) ----------------------------------------

#[test]
fn salvage_is_monotonic_over_an_already_saved_richer_meeting() {
    // A successful stop-save whose manifest/journal CLEANUP failed leaves
    // the artifacts behind; the next boot re-runs the salvage fold over an
    // already richer meeting. It must never shrink it: the persisted
    // transcript and the longer duration survive, the stale artifacts are
    // finally deleted.
    let dir = tempfile::tempdir().expect("tempdir");
    let store = FsMeetingStore::new(dir.path());
    let meeting = store.create("Saved, cleanup failed").expect("create");
    let id = meeting.id;
    let rich = Transcript {
        segments: vec![
            segment(0.0, 1.0, "one", Speaker::me()),
            segment(1.0, 2.0, "two", Speaker::me()),
            segment(2.0, 3.0, "three", Speaker::me()),
        ],
    };
    let saved = meeting
        .with_transcript(rich)
        .with_duration(30.0)
        .with_audio_path(store.audio_path(id));
    store.save(&saved).expect("save the rich meeting");
    // The failed-cleanup residue: a stale manifest and a journal that only
    // captured the first segment (fewer segments, earlier end than the
    // persisted meeting).
    write_journal(
        &store.transcript_journal_path(id),
        &[segment(0.0, 1.0, "one", Speaker::me())],
    );
    write_manifest(
        &store.session_manifest_path(id),
        &SessionManifest::new(&id.to_string(), CaptureSource::Microphone, None),
    )
    .expect("write manifest");

    recover_orphaned_sessions(&store);

    let after = store.get(id).expect("meeting must load");
    assert_eq!(
        after, saved,
        "a re-salvage over a richer saved meeting must be non-destructive"
    );
    assert!(
        !store.session_manifest_path(id).exists(),
        "the stale manifest must finally be cleaned up"
    );
    assert!(
        !store.transcript_journal_path(id).exists(),
        "the stale journal must finally be cleaned up"
    );
}

// --- legacy (pre-ADR-0011) orphan rescue ------------------------------------

#[test]
fn legacy_orphan_without_manifest_is_repaired_to_playable_duration() {
    // The user's actual stuck meeting: a pre-feature crash left NO
    // `session.json` (so the manifest pass skips it), a `meeting.json`
    // frozen at 0 s / no transcript, and an `audio.wav` holding every
    // sample behind hound's zero-data placeholder header — "Playback
    // error" forever. The legacy pass repairs the header and stamps the
    // real duration.
    let dir = tempfile::tempdir().expect("tempdir");
    let store = FsMeetingStore::new(dir.path());
    let meeting = store.create("Pre-feature crash").expect("create");
    let id = meeting.id;
    write_crashed_wav(&store.audio_path(id), 48_000, 2, 144_000); // 3 s stereo

    recover_orphaned_sessions(&store);

    let repaired = store.get(id).expect("meeting must load");
    assert!(
        (repaired.duration_sec - 3.0).abs() < 0.01,
        "duration must come from the repaired wav, got {}",
        repaired.duration_sec
    );
    assert_eq!(
        repaired.audio_path.as_deref(),
        Some(store.audio_path(id).as_path()),
        "a meeting with repaired audio must point at it"
    );
    let reader =
        hound::WavReader::open(store.audio_path(id)).expect("the repaired audio must be playable");
    assert_eq!(reader.duration() as usize, 144_000);
    assert!(
        repaired.transcript.is_none(),
        "the legacy pass must not invent a transcript"
    );
    assert!(
        !store.mic_track_path(id).exists() && !store.system_track_path(id).exists(),
        "the legacy pass must never fabricate track files"
    );

    // A second startup pass must be a no-op.
    let before = store.get(id).expect("re-read");
    recover_orphaned_sessions(&store);
    let after = store.get(id).expect("re-read after second pass");
    assert_eq!(before, after, "the legacy pass must be idempotent");
}

#[test]
fn manifest_dirs_take_the_salvage_branch_not_the_legacy_pass() {
    // A dir WITH `session.json` that also matches the legacy signature
    // (0 s, no transcript, crashed audio) must go through the manifest
    // salvage — journal folded into the transcript, manifest deleted —
    // proving the two branches are mutually exclusive.
    let dir = tempfile::tempdir().expect("tempdir");
    let store = FsMeetingStore::new(dir.path());
    let id = seed_orphan(
        &store,
        "Manifested orphan",
        CaptureSource::Microphone,
        &[segment(0.0, 2.0, "journaled", Speaker::me())],
        Some((48_000, 2, 96_000)),
        None,
        None,
    );

    recover_orphaned_sessions(&store);

    let recovered = store.get(id).expect("must recover");
    let transcript = recovered
        .transcript
        .expect("salvage folds the journal — the legacy pass never would");
    assert_eq!(transcript.segments.len(), 1);
    assert!(
        !store.session_manifest_path(id).exists(),
        "the salvage branch deletes the manifest"
    );
}

#[test]
fn legacy_pass_skips_unparseable_meeting_json() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = FsMeetingStore::new(dir.path());
    let meeting = store.create("Corrupt legacy").expect("create");
    let id = meeting.id;
    write_crashed_wav(&store.audio_path(id), 48_000, 2, 96_000);
    std::fs::write(
        store
            .audio_path(id)
            .parent()
            .expect("meeting dir")
            .join("meeting.json"),
        b"{ not valid json",
    )
    .expect("corrupt meeting.json");

    recover_orphaned_sessions(&store); // must not panic, must not block boot

    assert!(
        store.get(id).is_err(),
        "an unparseable meeting.json must be skipped, not rewritten"
    );
    let broken = hound::WavReader::open(store.audio_path(id)).expect("wav still parses");
    assert_eq!(
        broken.len(),
        0,
        "a skipped legacy meeting's wav must be left untouched"
    );
}

#[test]
fn legacy_pass_skips_meetings_without_audio_and_healthy_meetings() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = FsMeetingStore::new(dir.path());
    // 0 s / no transcript but NO `audio.wav` — nothing to repair, skip.
    let empty = store.create("Empty").expect("create");
    // A healthy finished meeting — none of this pass's business.
    let healthy = store.create("Healthy").expect("create");
    let healthy_saved = healthy
        .with_transcript(Transcript {
            segments: vec![segment(0.0, 1.0, "done", Speaker::me())],
        })
        .with_duration(12.0);
    store.save(&healthy_saved).expect("save healthy");

    recover_orphaned_sessions(&store);

    assert_eq!(
        store.get(empty.id).expect("load"),
        empty,
        "a 0 s meeting with no audio.wav must be skipped"
    );
    assert_eq!(
        store.get(healthy.id).expect("load"),
        healthy_saved,
        "a healthy meeting must be untouched by the legacy pass"
    );
}
