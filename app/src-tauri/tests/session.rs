//! Pure state-machine and helper tests for the recording session module.
//!
//! No test in this file opens a real audio device or loads a model —
//! [`guard_start`]/[`guard_stop`] are decision functions over a plain
//! `bool`, and [`LevelThrottle`] is driven by synthetic `Instant`s.

use std::time::{Duration, Instant};

use myna_app::domain::MeetingId;
use myna_app::error::AppError;
use myna_app::session::{
    guard_not_recording, guard_start, guard_stop, resolve_capture_source, resolve_system_source_id,
    DecodeChannel, LevelThrottle,
};
use myna_audio::{
    rms, rms_dbfs, CaptureSource, RecordingSpec, SystemAudioSource, SystemAudioStatus, WavRecorder,
};

#[test]
fn starting_while_a_session_is_active_yields_busy() {
    // Act
    let result = guard_start(true);

    // Assert
    assert!(matches!(result, Err(AppError::Busy(_))));
}

#[test]
fn starting_while_idle_is_allowed() {
    // Act
    let result = guard_start(false);

    // Assert
    assert!(result.is_ok());
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
    let (tx, _rx) = std::sync::mpsc::sync_channel::<Vec<f32>>(4);
    let channel = DecodeChannel::new(tx);

    // Act: send far more chunks than the channel can ever hold.
    let start = Instant::now();
    for _ in 0..1000 {
        channel.send(vec![0.0_f32; 320]);
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
/// chunk — a WAV write, the level computation, and a `DecodeChannel` send
/// — with no decode in the mix, against a realistic ~20ms chunk (320
/// samples at 16kHz, this codebase's measured callback block size).
///
/// This is the direct "how long is the callback now?" measurement the
/// fix's spec asks for: previously this same call site also ran a full
/// `SimulatedStreamer::push` decode (p50=706.8ms, p99=1799.9ms,
/// max=2342.2ms) inline; that work has moved entirely to the decode
/// worker, so what's left here is only the operations below.
#[test]
fn callback_shaped_work_completes_far_under_the_20ms_device_deadline() {
    // Arrange
    const CHUNK_SAMPLES: usize = 320; // ~20ms at 16kHz
    const CALLBACK_DEADLINE: Duration = Duration::from_millis(20);
    let samples = vec![0.1_f32; CHUNK_SAMPLES];

    let dir = tempfile::tempdir().expect("create temp dir");
    let wav_path = dir.path().join("callback_bench.wav");
    let mut wav_recorder = WavRecorder::create(
        &wav_path,
        RecordingSpec {
            sample_rate: 16_000,
            channels: 1,
        },
    )
    .expect("create wav recorder");

    let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<f32>>(150);
    let decode_channel = DecodeChannel::new(tx);

    // Act: run the same three operations `build_sample_callback` performs
    // per chunk — WAV write, level computation, channel handoff — for
    // 100 chunks (2 seconds of simulated audio), taking the worst single
    // chunk's time as the measured maximum callback cost.
    let mut max_chunk_duration = Duration::ZERO;
    for _ in 0..100 {
        let chunk_start = Instant::now();

        wav_recorder.write(&samples).expect("wav write");
        let _ = rms(&samples);
        let _ = rms_dbfs(&samples);
        decode_channel.send(samples.clone());

        max_chunk_duration = max_chunk_duration.max(chunk_start.elapsed());
        let _ = rx.try_recv(); // keep the channel from filling, like the decode worker would
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

#[test]
fn decode_channel_delivers_every_chunk_while_the_consumer_keeps_up() {
    // Arrange
    let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<f32>>(4);
    let channel = DecodeChannel::new(tx);

    // Act
    channel.send(vec![1.0, 2.0]);
    channel.send(vec![3.0, 4.0]);

    // Assert: nothing was dropped, and both chunks arrive in order.
    assert_eq!(channel.dropped_count(), 0);
    assert_eq!(rx.recv().unwrap(), vec![1.0, 2.0]);
    assert_eq!(rx.recv().unwrap(), vec![3.0, 4.0]);
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
