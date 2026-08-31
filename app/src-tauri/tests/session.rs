//! Pure state-machine and helper tests for the recording session module.
//!
//! No test in this file opens a real audio device or loads a model —
//! [`guard_start`]/[`guard_stop`] are decision functions over a plain
//! `bool`, and [`LevelThrottle`] is driven by synthetic `Instant`s.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use myna_app::domain::MeetingId;
use myna_app::error::AppError;
use myna_app::session::{
    announce_resolved_system_source, create_playback_recorder, fold_track_event,
    guard_not_recording, guard_start, guard_stop, open_track_wavs, resolve_capture_source,
    resolve_system_source_id, speaker_for_track, AudioPaths, DecodeChannel, LevelThrottle, Track,
};
use myna_audio::{
    mix_into, rms, rms_dbfs, CaptureSource, RecordingSpec, SystemAudioSource, SystemAudioStatus,
    WavRecorder,
};
use myna_stt::{Speaker, SttEvent, Transcript, TranscriptSegment};

#[test]
fn starting_while_a_session_is_active_yields_busy() {
    // Act
    let result = guard_start(true, false);

    // Assert
    assert!(matches!(result, Err(AppError::Busy(_))));
}

#[test]
fn starting_while_idle_is_allowed() {
    // Act
    let result = guard_start(false, false);

    // Assert
    assert!(result.is_ok());
}

/// Regression test for code-review CRITICAL finding (1): starting a
/// recording while an import/re-transcribe is in flight puts STT-decode-heavy
/// blocking work in direct CPU contention with the new recording's decode
/// worker — the same resource-starvation class that caused the dropped-audio
/// bug `DecodeChannel` exists to fix. `guard_start` must refuse this even
/// when no recording session is currently active.
#[test]
fn starting_while_an_import_is_in_flight_yields_busy_naming_the_conflict() {
    // Act
    let result = guard_start(false, true);

    // Assert: variant is Busy, and the message names *this* conflict (not
    // the pre-existing "a recording is already in progress" message).
    let err = result.expect_err("starting a recording during an in-flight import must be refused");
    assert!(matches!(err, AppError::Busy(_)));
    let message = err.to_string().to_lowercase();
    assert!(
        message.contains("import"),
        "message should name the import conflict, got: {message}"
    );
}

#[test]
fn stopping_while_idle_yields_busy() {
    // Act
    let result = guard_stop(false);

    // Assert
    assert!(matches!(result, Err(AppError::Busy(_))));
}

#[test]
fn stopping_while_a_session_is_active_is_allowed() {
    // Act
    let result = guard_stop(true);

    // Assert
    assert!(result.is_ok());
}

#[test]
fn level_throttle_emits_on_the_first_call() {
    // Arrange
    let mut throttle = LevelThrottle::new(100);

    // Act
    let emitted = throttle.should_emit(Instant::now());

    // Assert
    assert!(emitted);
}

#[test]
fn level_throttle_suppresses_a_call_inside_the_interval() {
    // Arrange
    let mut throttle = LevelThrottle::new(100);
    let start = Instant::now();
    throttle.should_emit(start);

    // Act
    let emitted = throttle.should_emit(start + Duration::from_millis(50));

    // Assert
    assert!(!emitted);
}

#[test]
fn level_throttle_emits_again_once_the_interval_has_elapsed() {
    // Arrange
    let mut throttle = LevelThrottle::new(100);
    let start = Instant::now();
    throttle.should_emit(start);

    // Act
    let emitted = throttle.should_emit(start + Duration::from_millis(100));

    // Assert
    assert!(emitted);
}

#[test]
fn level_throttle_never_emits_more_than_once_per_interval_across_many_calls() {
    // Arrange
    let mut throttle = LevelThrottle::new(100);
    let start = Instant::now();
    let mut emit_count = 0;

    // Act: 1001 calls spaced 1ms apart span 1000ms, so at most 11 emits
    // (t = 0, 100, 200, ..., 1000) can occur.
    for step_ms in 0..=1000u64 {
        if throttle.should_emit(start + Duration::from_millis(step_ms)) {
            emit_count += 1;
        }
    }

    // Assert
    assert!(
        emit_count <= 11,
        "expected at most 11 emits, got {emit_count}"
    );
}

#[test]
fn omitted_source_resolves_to_microphone() {
    // Act
    let effective = resolve_capture_source(
        None,
        SystemAudioStatus::Unavailable {
            reason: "no backend".to_string(),
        },
    );

    // Assert
    assert_eq!(effective, CaptureSource::Microphone);
}

#[test]
fn mixed_source_falls_back_to_microphone_when_permission_denied() {
    // Arrange
    let requested = Some(CaptureSource::Mixed);
    let status = SystemAudioStatus::PermissionDenied {
        restart_required: false,
    };

    // Act
    let effective = resolve_capture_source(requested, status);

    // Assert
    assert_eq!(effective, CaptureSource::Microphone);
}

#[test]
fn mixed_source_is_kept_when_system_audio_is_available() {
    // Arrange
    let requested = Some(CaptureSource::Mixed);
    let status = SystemAudioStatus::Available;

    // Act
    let effective = resolve_capture_source(requested, status);

    // Assert
    assert_eq!(effective, CaptureSource::Mixed);
}

/// Regression test for the root-cause bug this module was rewritten to
/// fix: the audio callback used to call `SimulatedStreamer::push` — a
/// full offline decode measured at p50=706.8ms / p99=1799.9ms /
/// max=2342.2ms — synchronously inside the cpal callback, which must
/// return in ~20ms. That starved captures so badly ~97% of audio was
/// lost. `DecodeChannel` is the fix: the callback hands samples off via
/// a non-blocking `try_send` instead of decoding inline.
///
/// This simulates the worst case a slow (or fully stalled) decode worker
/// can produce: a receiver that never drains, backing the channel all
/// the way up. It asserts the producing side — exactly what the audio
/// callback calls — is never blocked waiting for room, only bounded by
/// how fast it can enqueue. If someone reinstates an inline decode in
/// the callback (bypassing `DecodeChannel` entirely), this test can't
/// directly observe that regression, but it pins down the non-blocking
/// invariant the fix depends on: sending must complete in a small,
/// bounded time regardless of consumer speed.
#[test]
fn decode_channel_send_never_blocks_when_the_consumer_is_stalled() {
    // Arrange: a tiny channel and a receiver that is never read from —
    // simulating a decode worker that has fallen far behind (or stalled
    // entirely), which is exactly the scenario a synchronous, inline
    // decode in the audio callback would create for itself.
    let (tx, _rx) = std::sync::mpsc::sync_channel::<(Track, Vec<f32>)>(4);
    let channel = DecodeChannel::new(tx);

    // Act: send far more chunks than the channel can ever hold.
    let start = Instant::now();
    for _ in 0..1000 {
        channel.send(Track::Mic, vec![0.0_f32; 320]);
    }
    let elapsed = start.elapsed();

    // Assert: even fully backed up against a stalled consumer, sending
    // must return almost immediately — an audio callback that blocked
    // here for even 20ms per call, let alone the multi-hundred-ms decode
    // costs measured, would reproduce the original bug.
    assert!(
        elapsed < Duration::from_millis(50),
        "expected 1000 non-blocking sends against a stalled consumer to complete in well \
         under 50ms, took {elapsed:?}"
    );
    assert!(
        channel.dropped_count() > 0,
        "expected sends beyond the channel's capacity to be counted as drops rather than \
         blocking or being silently lost without a trace"
    );
}

/// Measures the actual bounded work the audio callback now performs per
/// chunk — up to three WAV writes (mic, system, native-rate stereo
/// playback), the level computation over the mono sum, and up to two
/// `DecodeChannel` sends — with no decode in the mix, against a realistic
/// ~20ms chunk (320 samples at 16kHz, this codebase's measured callback
/// block size).
///
/// This is the direct "how long is the callback now?" measurement the
/// fix's spec asks for: previously this same call site also ran a full
/// `SimulatedStreamer::push` decode (p50=706.8ms, p99=1799.9ms,
/// max=2342.2ms) inline; that work has moved entirely to the decode
/// worker, so what's left here is only the operations below. Phase 3b
/// (dual-track capture) added a second WAV write (system) and a third
/// (native-rate playback) plus a second channel send, so this pins the
/// budget at THREE writes + ONE mix + TWO sends, not the original ONE
/// write + ONE send.
#[test]
fn callback_shaped_work_completes_far_under_the_20ms_device_deadline() {
    // Arrange
    const CHUNK_SAMPLES: usize = 320; // ~20ms at 16kHz
    const CALLBACK_DEADLINE: Duration = Duration::from_millis(20);
    let mic_samples = vec![0.1_f32; CHUNK_SAMPLES];
    let system_samples = vec![0.05_f32; CHUNK_SAMPLES];
    let mut mix_buffer = vec![0.0_f32; CHUNK_SAMPLES];
    let playback_samples = vec![0.2_f32; CHUNK_SAMPLES * 2]; // stereo, native rate

    let dir = tempfile::tempdir().expect("create temp dir");
    let mono_spec = RecordingSpec {
        sample_rate: 16_000,
        channels: 1,
    };
    let mut mic_wav = WavRecorder::create(&dir.path().join("track-mic.wav"), mono_spec)
        .expect("create mic wav recorder");
    let mut system_wav = WavRecorder::create(&dir.path().join("track-system.wav"), mono_spec)
        .expect("create system wav recorder");
    let mut playback_wav = WavRecorder::create(
        &dir.path().join("audio.wav"),
        RecordingSpec {
            sample_rate: 48_000,
            channels: 2,
        },
    )
    .expect("create playback wav recorder");

    let (tx, rx) = std::sync::mpsc::sync_channel::<(Track, Vec<f32>)>(300);
    let decode_channel = DecodeChannel::new(tx);

    // Act: run the same operations `build_sample_callback` performs per
    // chunk — three WAV writes, one mono mix for the level meter, two
    // channel handoffs — for 100 chunks (2 seconds of simulated audio),
    // taking the worst single chunk's time as the measured maximum
    // callback cost.
    let mut max_chunk_duration = Duration::ZERO;
    for _ in 0..100 {
        let chunk_start = Instant::now();

        mic_wav.write(&mic_samples).expect("mic wav write");
        system_wav.write(&system_samples).expect("system wav write");
        playback_wav
            .write(&playback_samples)
            .expect("playback wav write");
        mix_into(&mic_samples, &system_samples, &mut mix_buffer);
        let _ = rms(&mix_buffer);
        let _ = rms_dbfs(&mix_buffer);
        decode_channel.send(Track::Mic, mic_samples.clone());
        decode_channel.send(Track::System, system_samples.clone());

        max_chunk_duration = max_chunk_duration.max(chunk_start.elapsed());
        // keep the channel from filling, like the decode worker would
        let _ = rx.try_recv();
        let _ = rx.try_recv();
    }

    // Assert: the measured maximum is a small fraction of the ~20ms
    // device deadline — nowhere near the multi-hundred-millisecond decode
    // costs the callback used to incur inline.
    assert!(
        max_chunk_duration < CALLBACK_DEADLINE,
        "expected callback-shaped work to complete well under the {CALLBACK_DEADLINE:?} \
         device deadline, measured maximum was {max_chunk_duration:?}"
    );
}

/// Regression test for the Phase 7 plumbing that surfaces dropped-chunk
/// counts to the persisted meeting: `run_worker` reads
/// [`DecodeChannel::dropped_handle`] *after* the `DecodeChannel` itself
/// (moved into the audio callback) has been dropped, so the handle must
/// keep reflecting drops recorded on the original instance.
#[test]
fn dropped_handle_reflects_drops_recorded_by_the_original_channel_after_it_is_dropped() {
    // Arrange: a channel with no room, so every send overflows and counts
    // as a drop — mirrors a stalled decode worker.
    let (tx, _rx) = std::sync::mpsc::sync_channel::<(Track, Vec<f32>)>(1);
    let channel = DecodeChannel::new(tx);
    let handle = channel.dropped_handle();

    // Act: send enough chunks to guarantee at least one overflow, then
    // drop the channel itself (as `run_worker` does once `capture_sources`
    // returns and the audio callback — and the `DecodeChannel` it
    // captured — goes out of scope).
    for _ in 0..10 {
        channel.send(Track::Mic, vec![0.0_f32; 16]);
    }
    let dropped_before = channel.dropped_count();
    drop(channel);

    // Assert: the handle taken beforehand still reports the same count
    // once the owning `DecodeChannel` no longer exists.
    assert!(dropped_before > 0, "expected at least one overflow drop");
    assert_eq!(
        handle.load(std::sync::atomic::Ordering::Relaxed),
        dropped_before
    );
}

#[test]
fn decode_channel_delivers_every_chunk_while_the_consumer_keeps_up() {
    // Arrange
    let (tx, rx) = std::sync::mpsc::sync_channel::<(Track, Vec<f32>)>(4);
    let channel = DecodeChannel::new(tx);

    // Act
    channel.send(Track::Mic, vec![1.0, 2.0]);
    channel.send(Track::System, vec![3.0, 4.0]);

    // Assert: nothing was dropped, and both chunks arrive in order, tagged
    // with the right track.
    assert_eq!(channel.dropped_count(), 0);
    assert_eq!(rx.recv().unwrap(), (Track::Mic, vec![1.0, 2.0]));
    assert_eq!(rx.recv().unwrap(), (Track::System, vec![3.0, 4.0]));
}

#[test]
fn system_source_falls_back_to_microphone_when_unavailable() {
    // Arrange
    let requested = Some(CaptureSource::System);
    let status = SystemAudioStatus::Unavailable {
        reason: "unsupported platform".to_string(),
    };

    // Act
    let effective = resolve_capture_source(requested, status);

    // Assert
    assert_eq!(effective, CaptureSource::Microphone);
}

#[test]
fn omitted_source_resolves_to_mixed_when_system_audio_is_available() {
    // Act: `CaptureSource::default()` is `Mixed`, and system audio is
    // available, so an omitted request should keep it rather than falling
    // back to `Microphone`.
    let effective = resolve_capture_source(None, SystemAudioStatus::Available);

    // Assert
    assert_eq!(effective, CaptureSource::Mixed);
}

#[test]
fn requested_system_source_id_is_kept_when_it_matches_an_available_source() {
    // Arrange
    let available = vec![SystemAudioSource {
        id: "app:com.example.app".to_string(),
        name: "Example".to_string(),
    }];

    // Act
    let effective = resolve_system_source_id(Some("app:com.example.app".to_string()), &available);

    // Assert
    assert_eq!(effective, Some("app:com.example.app".to_string()));
}

#[test]
fn unresolvable_system_source_id_falls_back_to_all_output() {
    // Arrange: the requested id (e.g. an app that has since quit) is not
    // among the currently available sources.
    let available = vec![SystemAudioSource {
        id: "system:all".to_string(),
        name: "All system audio".to_string(),
    }];

    // Act
    let effective = resolve_system_source_id(Some("app:com.example.stale".to_string()), &available);

    // Assert: falls back to all-output (`None`), not an error.
    assert_eq!(effective, None);
}

/// Regression test for the fix promoted from nice-to-have: `Unknown` is the
/// normal initial state (no public TCC preflight exists for
/// `kTCCServiceAudioCapture`), so it must be *attempted*, not silently
/// downgraded to microphone — otherwise the very first Mixed/System
/// recording never attempts a tap and the OS permission prompt may never
/// appear at all.
#[test]
fn mixed_source_is_attempted_when_system_audio_status_is_unknown() {
    // Arrange
    let requested = Some(CaptureSource::Mixed);

    // Act
    let effective = resolve_capture_source(requested, SystemAudioStatus::Unknown);

    // Assert
    assert_eq!(effective, CaptureSource::Mixed);
}

/// Same fix as above, for a `System`-only request.
#[test]
fn system_source_is_attempted_when_system_audio_status_is_unknown() {
    // Arrange
    let requested = Some(CaptureSource::System);

    // Act
    let effective = resolve_capture_source(requested, SystemAudioStatus::Unknown);

    // Assert
    assert_eq!(effective, CaptureSource::System);
}

#[test]
fn omitted_system_source_id_resolves_to_all_output() {
    // Act
    let effective = resolve_system_source_id(None, &[]);

    // Assert
    assert_eq!(effective, None);
}

/// Regression test for the "recording bar shows Mic only for the entire
/// mixed recording" bug: the initial `recording://state` event emitted by
/// `start_recording` necessarily carries `system_source: null` (the capture
/// backend resolves the source only once the system-audio tap actually
/// starts, well after `RecordingSession::start` returned), and before the
/// fix the worker only *stored* the resolved source without ever emitting a
/// follow-up event — so the UI showed the degraded "Mic only (system audio
/// unavailable)" label for a healthy mixed recording.
///
/// `announce_resolved_system_source` is what `run_worker`'s
/// `on_system_source` callback now runs once the capture backend resolves a
/// source. It must both store the resolved source (so `recording_state`
/// polls and the stop/cancel emissions report it) and announce it via the
/// emit callback carrying `Some(resolved)` — never `None`.
#[test]
fn resolved_system_source_is_stored_and_announced_to_the_ui_as_some() {
    // Arrange: the session's system-source slot starts empty — exactly the
    // state the initial `recording://state` event reflected.
    let slot: Mutex<Option<SystemAudioSource>> = Mutex::new(None);
    let resolved = SystemAudioSource {
        id: "app:com.example.teams".to_string(),
        name: "Teams".to_string(),
    };
    let mut announced: Vec<Option<SystemAudioSource>> = Vec::new();

    // Act: what the capture worker does the moment the system-audio
    // backend starts and reports its effective source.
    announce_resolved_system_source(&slot, |source| announced.push(source), resolved.clone());

    // Assert: the slot is populated for later `recording_state` polls, and
    // the follow-up event carries the resolved source — not null.
    assert_eq!(
        slot.lock().unwrap().clone(),
        Some(resolved.clone()),
        "the resolved source must be stored so recording_state polls report it"
    );
    assert_eq!(
        announced,
        vec![Some(resolved)],
        "the follow-up recording://state event must carry the resolved source, not null"
    );
}

/// Regression test for the wire-contract half of the "Mic only shown for
/// the entire mixed recording" bug: the Angular adapter
/// (`tauri-recorder.adapter.ts`) reads `effectiveSystemSource` off the
/// `recording://state` payload, but the field used to serialize under its
/// plain camelCase name `systemSource` — so even a payload carrying the
/// resolved source was read as `undefined` (→ `null`) by the UI, and the
/// degraded "Mic only (system audio unavailable)" label never cleared.
/// The field must serialize under exactly the name the adapter expects.
#[test]
fn recording_state_payload_serializes_the_system_source_under_the_adapters_name() {
    // Arrange
    use myna_app::events::RecordingStatePayload;
    let payload = RecordingStatePayload {
        meeting_id: Some(MeetingId::new().to_string()),
        state: myna_app::session::RecordingState::Recording,
        source: CaptureSource::Mixed,
        system_source: Some(
            SystemAudioSource {
                id: "app:com.example.teams".to_string(),
                name: "Teams".to_string(),
            }
            .into(),
        ),
    };

    // Act
    let json = serde_json::to_value(&payload).expect("serialize recording state payload");

    // Assert
    assert!(
        json.get("effectiveSystemSource").is_some(),
        "payload must expose the system source under the key the Angular \
         adapter reads, got keys: {:?}",
        json.as_object()
            .map(|object| object.keys().collect::<Vec<_>>())
    );
    assert!(
        json.get("systemSource").is_none(),
        "the plain camelCase rendering would be silently ignored by the UI"
    );
    assert_eq!(
        json["effectiveSystemSource"],
        serde_json::json!({ "id": "app:com.example.teams", "name": "Teams" }),
    );
}

#[test]
fn rejects_archiving_the_meeting_currently_being_recorded() {
    // Arrange
    let target = MeetingId::new();

    // Act
    let result = guard_not_recording(Some(target), target);

    // Assert
    assert!(matches!(result, Err(AppError::Busy(_))));
}

#[test]
fn allows_archiving_a_meeting_that_is_not_being_recorded() {
    // Arrange
    let active = MeetingId::new();
    let target = MeetingId::new();

    // Act
    let result = guard_not_recording(Some(active), target);

    // Assert
    assert!(result.is_ok());
}

#[test]
fn allows_archiving_when_no_recording_is_in_progress() {
    // Arrange
    let target = MeetingId::new();

    // Act
    let result = guard_not_recording(None, target);

    // Assert
    assert!(result.is_ok());
}

/// `guard_not_recording` is shared by `set_meeting_archived` and
/// `edit_transcript_segment` — a mid-recording transcript edit would be
/// silently destroyed once `stop_recording` persists the whole in-memory
/// transcript over whatever is on disk, so editing the meeting currently
/// being recorded into must be refused exactly like archiving it.
#[test]
fn rejects_editing_a_transcript_of_the_meeting_currently_being_recorded() {
    // Arrange
    let target = MeetingId::new();

    // Act
    let result = guard_not_recording(Some(target), target);

    // Assert
    assert!(matches!(result, Err(AppError::Busy(_))));
}

// ---- Phase 3b: dual-track capture --------------------------------------

/// Builds the three (not-yet-created) file paths a recording writes to,
/// under a fresh temp directory — mirrors what `FsMeetingStore`'s
/// `audio_path`/`mic_track_path`/`system_track_path` return for one
/// meeting.
fn audio_paths_under(dir: &std::path::Path) -> AudioPaths {
    AudioPaths {
        playback: dir.join("audio.wav"),
        mic: dir.join("track-mic.wav"),
        system: dir.join("track-system.wav"),
    }
}

/// Required test (a): a mixed-source session writes all three files, and
/// each carries the right header — `audio.wav` at the (here, simulated)
/// native rate in stereo, both STT tracks at 16 kHz mono. Exercises the
/// exact same `open_track_wavs`/`create_playback_recorder` helpers
/// `RecordingSession::start`/`create_playback_wav` call in production,
/// without a real audio device.
#[test]
fn mixed_source_session_writes_all_three_wav_files_with_correct_headers() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let audio_paths = audio_paths_under(dir.path());
    let track_spec = RecordingSpec {
        sample_rate: 16_000,
        channels: 1,
    };

    // Act
    let (mic_wav, system_wav) =
        open_track_wavs(CaptureSource::Mixed, &audio_paths, track_spec).expect("open track wavs");
    let playback_wav =
        create_playback_recorder(&audio_paths.playback, 48_000).expect("create playback recorder");

    mic_wav
        .expect("mixed source must create a mic track file")
        .finalize()
        .expect("finalize mic wav");
    system_wav
        .expect("mixed source must create a system track file")
        .finalize()
        .expect("finalize system wav");
    playback_wav.finalize().expect("finalize playback wav");

    // Assert
    let mic_spec = hound::WavReader::open(&audio_paths.mic)
        .expect("open mic wav")
        .spec();
    assert_eq!(mic_spec.channels, 1, "mic track must be mono");
    assert_eq!(mic_spec.sample_rate, 16_000, "mic track must be 16kHz");

    let system_spec = hound::WavReader::open(&audio_paths.system)
        .expect("open system wav")
        .spec();
    assert_eq!(system_spec.channels, 1, "system track must be mono");
    assert_eq!(
        system_spec.sample_rate, 16_000,
        "system track must be 16kHz"
    );

    let playback_spec = hound::WavReader::open(&audio_paths.playback)
        .expect("open playback wav")
        .spec();
    assert_eq!(
        playback_spec.channels, 2,
        "playback file must be genuine stereo"
    );
    assert_eq!(
        playback_spec.sample_rate, 48_000,
        "playback file must be stamped at the reported native rate"
    );
}

/// Required test (b): a mic-only session writes no `track-system.wav` —
/// absence, not an empty file, is how "this track was never captured" is
/// represented (Phase 5's re-transcribe branches on file presence).
#[test]
fn microphone_only_session_never_creates_a_system_track_file() {
    // Arrange
    let dir = tempfile::tempdir().expect("tempdir");
    let audio_paths = audio_paths_under(dir.path());
    let track_spec = RecordingSpec {
        sample_rate: 16_000,
        channels: 1,
    };

    // Act
    let (mic_wav, system_wav) =
        open_track_wavs(CaptureSource::Microphone, &audio_paths, track_spec)
            .expect("open track wavs");

    // Assert: the recorder itself is never even constructed for `system`...
    assert!(
        mic_wav.is_some(),
        "microphone-only source must still create the mic track file"
    );
    assert!(
        system_wav.is_none(),
        "microphone-only source must never construct a system wav recorder"
    );

    mic_wav.unwrap().finalize().expect("finalize mic wav");

    // ...so no file is ever left behind for it, either.
    assert!(audio_paths.mic.exists(), "mic track file must exist");
    assert!(
        !audio_paths.system.exists(),
        "system track file must never be created for a microphone-only session"
    );
}

/// Required test (d): segments (and live partials) decoded from the mic
/// track must be attributed to `me`, and from the system track to bare
/// `others` — never a fabricated `others:<id>`, since there is no
/// diarization. Exercises the exact mapping `apply_event` stamps every
/// decoded event with.
#[test]
fn mic_track_maps_to_me_and_system_track_maps_to_others() {
    assert_eq!(speaker_for_track(Track::Mic), Speaker::me());
    assert_eq!(speaker_for_track(Track::System), Speaker::others());
    assert_ne!(
        speaker_for_track(Track::System),
        Speaker::unknown(),
        "the system track must never be left at the pre-diarization default"
    );
}

// --- fold_track_event (live-decode ordering fix) ----------------------------

fn final_event(start_sec: f32, text: &str) -> SttEvent {
    SttEvent::Final {
        segment: TranscriptSegment {
            start_sec,
            end_sec: start_sec + 1.0,
            text: text.to_string(),
            speaker: Speaker::default(),
            speaker_pinned: false,
        },
    }
}

/// Regression test for the real recording bug: the system track's first VAD
/// segment ran ~20s of continuous speech and only finished decoding after
/// two much shorter mic segments had already been applied, so the persisted
/// transcript rendered the 00:00 system segment third instead of first.
/// Reproduces that arrival order directly against the decode worker's own
/// per-event fold -- the same one `spawn_decode_worker` drives -- and
/// asserts the transcript stays ordered ascending by `start_sec` regardless.
#[test]
fn fold_track_event_orders_transcript_ascending_despite_late_finishing_system_segment() {
    // Arrange
    let mut transcript = Transcript::default();

    // Act: mic@4s and mic@16s finish decoding (and so arrive) before the
    // system segment that actually started at 0s.
    fold_track_event(&mut transcript, Track::Mic, final_event(4.0, "Yeah."));
    fold_track_event(
        &mut transcript,
        Track::Mic,
        final_event(16.0, "Allo, allo, c'est un test."),
    );
    fold_track_event(
        &mut transcript,
        Track::System,
        final_event(0.0, "... long system segment ..."),
    );

    // Assert
    let starts: Vec<f32> = transcript.segments.iter().map(|s| s.start_sec).collect();
    assert_eq!(
        starts,
        vec![0.0, 4.0, 16.0],
        "transcript must stay ordered ascending by start_sec regardless of decode-completion order, got: {:?}",
        transcript.segments
    );
    assert_eq!(transcript.segments[0].speaker, Speaker::others());
    assert_eq!(transcript.segments[1].speaker, Speaker::me());
    assert_eq!(transcript.segments[2].speaker, Speaker::me());
}

/// [`myna_stt::Transcript::attributed_text`] merges *consecutive*
/// same-speaker segments -- so an out-of-order transcript doesn't just
/// render a wrong timeline, it also produces wrong speaker groupings for
/// summarization and export. Feeds the same out-of-order arrival sequence as
/// the ordering test above and asserts the grouping follows chronological
/// adjacency (system, then Me, then Me merged into one group), not arrival
/// adjacency (which would wrongly merge the two mic segments into their own
/// leading group with the system segment trailing behind).
#[test]
fn fold_track_event_result_groups_attributed_text_by_chronological_adjacency() {
    // Arrange
    let mut transcript = Transcript::default();

    // Act: same out-of-order arrival as above.
    fold_track_event(&mut transcript, Track::Mic, final_event(4.0, "Yeah."));
    fold_track_event(
        &mut transcript,
        Track::Mic,
        final_event(16.0, "Allo, allo, c'est un test."),
    );
    fold_track_event(
        &mut transcript,
        Track::System,
        final_event(0.0, "Pirapolis c'est fini"),
    );

    // Assert: one "Others" line (the 0s system segment) followed by one
    // merged "Me" line (the two consecutive mic segments) -- not the other
    // way around, which arrival-order grouping would produce.
    assert_eq!(
        transcript.attributed_text(),
        "Others: Pirapolis c'est fini\nMe: Yeah. Allo, allo, c'est un test."
    );
}
