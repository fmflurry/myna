//! Live, real-hardware acceptance tests for system-audio capture.
//!
//! CI cannot run these: they require real system-audio (`kTCCServiceAudioCapture`)
//! permission granted to the test binary, plus actual audio playing on the
//! machine. Gated two ways on purpose (belt and braces) — `#[ignore]`, which
//! `--ignored` alone can enable by accident in a CI pipeline, AND an
//! explicit `MYNA_LIVE_AUDIO_TESTS` env var that must be set by hand:
//!
//! ```sh
//! afplay /System/Library/Sounds/Glass.aiff # or any other audio, looping
//! MYNA_LIVE_AUDIO_TESTS=1 cargo test -p myna-audio --release --locked -- --ignored --nocapture
//! ```
//!
//! If system-audio permission has not been granted to the test binary,
//! these print the exact [`SystemAudioStatus`] observed and return without
//! failing — they do not fake a pass. Since there is no preflight for this
//! TCC service (see `crate::system_macos`'s docs), permission may only
//! become known partway through the *first* capture attempt in a given
//! process — a fresh `PermissionDenied` there most likely means the OS just
//! showed a prompt for this binary; grant it and re-run.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use myna_audio::{
    capture_sources, list_system_audio_sources, rms, system_audio_status, CaptureConfig,
    CaptureRequest, CaptureSource, SystemAudioStatus, ALL_OUTPUT_SOURCE_ID,
};
#[cfg(target_os = "macos")]
use myna_coreaudio_tap::{hal_device_uid, list_hal_device_ids, AudioObjectID};

/// How long to run each live capture before stopping and inspecting results.
const CAPTURE_DURATION: Duration = Duration::from_secs(5);

/// Serializes the three live capture tests below: Core Audio does not
/// tolerate two process taps/aggregate devices being stood up concurrently
/// by the same process, so running these under the default multi-threaded
/// test harness can race and fail both with OSStatus `1852797029` (`'nope'`
/// = `kAudioHardwareIllegalOperationError`). Held for the duration of each
/// test regardless of `--test-threads`.
static LIVE_CAPTURE_LOCK: Mutex<()> = Mutex::new(());

/// Largest absolute sample value — more diagnostic than RMS for judging
/// whether an intermittent/short sound was actually captured, since RMS
/// averages over the whole (possibly mostly-silent) window.
fn peak(samples: &[f32]) -> f32 {
    samples
        .iter()
        .fold(0.0_f32, |max, &sample| max.max(sample.abs()))
}

/// Runs `capture_sources` for `CAPTURE_DURATION` against `system_source`,
/// returning the collected samples. Shared by the all-output and
/// specific-application live tests below so both measure capture the same
/// way.
fn capture_for_duration(system_source: Option<&str>) -> Vec<f32> {
    let collected: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
    let collected_for_capture = Arc::clone(&collected);
    let stop = Arc::new(AtomicBool::new(false));
    let stop_for_capture = Arc::clone(&stop);
    let system_source_owned = system_source.map(str::to_string);

    let capture_thread = thread::spawn(move || {
        let request = CaptureRequest {
            source: CaptureSource::System,
            device: None,
            system_source: system_source_owned.as_deref(),
            config: CaptureConfig::default(),
        };
        capture_sources(
            &request,
            stop_for_capture,
            move |block: &myna_audio::TrackBlock<'_>| {
                if let Some(samples) = block.system {
                    if let Ok(mut buffer) = collected_for_capture.lock() {
                        buffer.extend_from_slice(samples);
                    }
                }
            },
            |resolved| println!("effective system-audio source: {resolved:?}"),
            |rate: u32| println!("native playback rate: {rate}"),
        )
    });

    thread::sleep(CAPTURE_DURATION);
    stop.store(true, Ordering::Relaxed);
    let capture_result = capture_thread.join().expect("capture thread joins");
    capture_result.expect("system audio capture runs without error");

    let samples = collected.lock().expect("collected-samples lock").clone();
    samples
}

#[test]
#[ignore = "requires real hardware: system-audio (kTCCServiceAudioCapture) permission granted, plus audio playing"]
fn captures_nonzero_system_audio_when_permission_is_granted() {
    let _guard = LIVE_CAPTURE_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);

    if std::env::var("MYNA_LIVE_AUDIO_TESTS").is_err() {
        return;
    }

    let status = system_audio_status();
    // `Unknown` is expected on a fresh test binary — there is no preflight
    // for this TCC service, so the only way to learn the real status is to
    // actually attempt the capture below, which itself observes and caches
    // the outcome. Only a *definite* non-available status short-circuits.
    if matches!(
        status,
        SystemAudioStatus::PermissionDenied { .. } | SystemAudioStatus::Unavailable { .. }
    ) {
        println!(
            "system audio not available (status: {status:?}) — grant system-audio \
             (Audio Recording) permission to this test binary in System Settings and \
             re-run; not failing the test since this is an environment \
             precondition, not a code defect"
        );
        return;
    }

    let samples = capture_for_duration(None);
    let non_zero_count = samples.iter().filter(|&&sample| sample != 0.0).count();
    let level = rms(&samples);
    let peak_level = peak(&samples);
    println!(
        "all-output: captured {} samples ({non_zero_count} non-zero), rms = {level:.6}, peak = {peak_level:.6}",
        samples.len()
    );

    assert!(!samples.is_empty(), "expected some samples to be captured");
    assert!(
        non_zero_count > 0,
        "expected at least one non-zero sample while audio was playing"
    );
}

/// Companion to the all-output test above: enumerates the sources this
/// machine reports, then captures from one specific running application
/// (the first non-all-output entry) instead of the whole display.
///
/// Per-application capture is less reliable than whole-output capture in
/// practice — an app that renders its audio in a helper process (common
/// for browsers and Electron apps) may yield silence even though it's
/// "running". This test reports what actually happened rather than
/// papering over a silent result: it prints the picked source and the
/// resulting sample/RMS/peak stats unconditionally.
///
/// This is a **resolution/no-crash smoke test only**: the target is
/// whichever bundle id happens to be the first non-all-output entry
/// enumerated on this machine (e.g. `com.apple.audiomxd`), picked purely by
/// enumeration order, not because it's known to be producing sound. It can
/// therefore legitimately capture zero samples if that process's aggregate
/// device never fires — that's an environment precondition, not a bug, so
/// there is nothing meaningful left to assert about sample counts here. The
/// only thing this test can honestly assert is that `capture_for_duration`
/// completes without erroring (enforced by its internal `.expect(...)`).
/// The real behavioral proof that per-process capture delivers audio is the
/// pid-targeted `afplay` test below, which targets a process known to be
/// making sound.
#[test]
#[ignore = "requires real hardware: system-audio (kTCCServiceAudioCapture) permission granted, plus audio playing"]
fn captures_system_audio_for_one_specific_application_when_permission_is_granted() {
    let _guard = LIVE_CAPTURE_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);

    if std::env::var("MYNA_LIVE_AUDIO_TESTS").is_err() {
        return;
    }

    let status = system_audio_status();
    // `Unknown` is expected on a fresh test binary — there is no preflight
    // for this TCC service, so the only way to learn the real status is to
    // actually attempt the capture below, which itself observes and caches
    // the outcome. Only a *definite* non-available status short-circuits.
    if matches!(
        status,
        SystemAudioStatus::PermissionDenied { .. } | SystemAudioStatus::Unavailable { .. }
    ) {
        println!(
            "system audio not available (status: {status:?}) — grant system-audio \
             (Audio Recording) permission to this test binary in System Settings and \
             re-run; not failing the test since this is an environment \
             precondition, not a code defect"
        );
        return;
    }

    let sources = list_system_audio_sources();
    println!("enumerated {} system-audio source(s):", sources.len());
    for source in &sources {
        println!("  id={:?} name={:?}", source.id, source.name);
    }

    let Some(target) = sources
        .iter()
        .find(|source| source.id != ALL_OUTPUT_SOURCE_ID)
    else {
        println!(
            "no running application source available to capture from — skipping \
             per-application capture (this is an environment precondition, not a \
             code defect)"
        );
        return;
    };
    println!("capturing from application source: {target:?}");

    let samples = capture_for_duration(Some(&target.id));
    let non_zero_count = samples.iter().filter(|&&sample| sample != 0.0).count();
    let level = rms(&samples);
    let peak_level = peak(&samples);
    println!(
        "application '{}': captured {} samples ({non_zero_count} non-zero), rms = {level:.6}, peak = {peak_level:.6}",
        target.name,
        samples.len()
    );
    if non_zero_count == 0 {
        println!(
            "per-application capture for '{}' yielded only silence — this application \
             likely renders its audio through a helper process that shares its bundle \
             id but wasn't included in the tapped process set; reporting this \
             honestly rather than treating it as a pass",
            target.name
        );
    }
}

/// Headline per-process proof: targets a specific, genuinely-sound-producing
/// process directly by pid — `afplay` looping a system sound, exactly as
/// the spike that validated this migration did — via the `app:pid:<pid>`
/// id scheme, bypassing [`list_system_audio_sources`] entirely (a bare CLI
/// tool like `afplay` has no bundle id and may not appear there the same
/// way a GUI application does).
///
/// Unlike the "one specific application" test above, this one *does* assert
/// non-zero samples: if `afplay` is confirmed running and this still comes
/// back silent, that is a real regression in per-process tapping, not an
/// environment precondition to shrug off.
#[test]
#[ignore = "requires real hardware: system-audio (kTCCServiceAudioCapture) permission granted, plus a running `afplay` process"]
fn captures_system_audio_for_a_specific_afplay_process_by_pid_when_permission_is_granted() {
    let _guard = LIVE_CAPTURE_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);

    if std::env::var("MYNA_LIVE_AUDIO_TESTS").is_err() {
        return;
    }

    let status = system_audio_status();
    // `Unknown` is expected on a fresh test binary — there is no preflight
    // for this TCC service, so the only way to learn the real status is to
    // actually attempt the capture below, which itself observes and caches
    // the outcome. Only a *definite* non-available status short-circuits.
    if matches!(
        status,
        SystemAudioStatus::PermissionDenied { .. } | SystemAudioStatus::Unavailable { .. }
    ) {
        println!(
            "system audio not available (status: {status:?}) — grant system-audio \
             (Audio Recording) permission to this test binary in System Settings and \
             re-run; not failing the test since this is an environment \
             precondition, not a code defect"
        );
        return;
    }

    let Some(pid) = most_recent_afplay_pid() else {
        println!(
            "no running `afplay` process found (pgrep -n afplay) — start one first, e.g.:\n\
             afplay /System/Library/Sounds/Glass.aiff\n\
             not failing the test since this is an environment precondition, not a code defect"
        );
        return;
    };
    println!("targeting afplay pid={pid}");

    let system_source = format!("app:pid:{pid}");
    let samples = capture_for_duration(Some(&system_source));
    let non_zero_count = samples.iter().filter(|&&sample| sample != 0.0).count();
    let level = rms(&samples);
    let peak_level = peak(&samples);
    println!(
        "afplay (pid {pid}): captured {} samples ({non_zero_count} non-zero), rms = {level:.6}, peak = {peak_level:.6}",
        samples.len()
    );

    assert!(!samples.is_empty(), "expected some samples to be captured");
    assert!(
        non_zero_count > 0,
        "expected at least one non-zero sample while afplay (pid {pid}) was looping audio — \
         a silent result here is a real per-process-tap regression, not an environment issue"
    );
}

/// Proves the full Core Audio teardown chain — `AudioDeviceStop` ->
/// `AudioDeviceDestroyIOProcID` -> destroy aggregate device -> destroy
/// process tap (see `myna-coreaudio-tap`'s `tap.rs`) — actually runs on real
/// hardware and leaves no trace: the HAL's device set
/// (`kAudioHardwarePropertyDevices`) is captured before any tap exists, then
/// re-checked after each of several start/stop cycles. A leaked aggregate
/// device would show up as an extra id that persists after `stop()` returns.
///
/// Runs 5 cycles rather than 1 so a slow/eventual leak (e.g. one that only
/// manifests every other teardown) can't hide behind a single lucky pass,
/// and so the device count is proven not to grow cycle over cycle.
///
/// # Why this polls instead of asserting immediately
///
/// Empirically (confirmed via [`hal_device_uid`] on the extra id), Core
/// Audio's `kAudioHardwarePropertyDevices` does not update synchronously
/// with `AudioHardwareDestroyAggregateDevice` returning: a just-destroyed
/// aggregate device (UID `dev.myna.coreaudiotap.aggregate.<pid>`) can still
/// enumerate for up to roughly a second after its owning
/// `ProcessTapCapture`'s `Drop` has already run and returned — and the same
/// lag can leave a *previous* test's (or, once, this test's own prior
/// cycle's) residue in the very first read taken right after that test
/// finished, contaminating a naively-immediate baseline. That is HAL
/// enumeration lag, not a leak: teardown has already returned before this
/// test ever reads the device list. [`stabilized_hal_device_ids`] waits out
/// that lag — for the baseline *and* every post-cycle read — by polling
/// until two consecutive reads agree; a genuine leak would never stabilize
/// back down to the same set.
#[test]
#[ignore = "requires real hardware: system-audio (kTCCServiceAudioCapture) permission granted"]
#[cfg(target_os = "macos")]
fn system_capture_leaves_no_aggregate_device_after_stop() {
    let _guard = LIVE_CAPTURE_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);

    if std::env::var("MYNA_LIVE_AUDIO_TESTS").is_err() {
        return;
    }

    let status = system_audio_status();
    // `Unknown` is expected on a fresh test binary — there is no preflight
    // for this TCC service, so the only way to learn the real status is to
    // actually attempt the capture below, which itself observes and caches
    // the outcome. Only a *definite* non-available status short-circuits.
    if matches!(
        status,
        SystemAudioStatus::PermissionDenied { .. } | SystemAudioStatus::Unavailable { .. }
    ) {
        println!(
            "system audio not available (status: {status:?}) — grant system-audio \
             (Audio Recording) permission to this test binary in System Settings and \
             re-run; not failing the test since this is an environment \
             precondition, not a code defect"
        );
        return;
    }

    const CYCLE_DURATION: Duration = Duration::from_millis(500);
    const CYCLES: usize = 5;
    const SETTLE_TIMEOUT: Duration = Duration::from_secs(3);
    const SETTLE_POLL_INTERVAL: Duration = Duration::from_millis(150);

    let baseline = stabilized_hal_device_ids(SETTLE_TIMEOUT, SETTLE_POLL_INTERVAL);
    println!(
        "baseline HAL device set before any tap (stabilized): {} device(s)",
        baseline.len()
    );

    let mut device_counts = Vec::with_capacity(CYCLES);
    for cycle in 1..=CYCLES {
        run_one_capture_cycle(None, CYCLE_DURATION);
        let after = stabilized_hal_device_ids(SETTLE_TIMEOUT, SETTLE_POLL_INTERVAL);
        println!(
            "cycle {cycle}/{CYCLES}: {} device(s) after stop (stabilized within {SETTLE_TIMEOUT:?})",
            after.len()
        );
        device_counts.push(after.len());
        if after != baseline {
            for id in after.iter().filter(|id| !baseline.contains(id)) {
                println!("  leaked id={id} uid={:?}", hal_device_uid(*id));
            }
        }
        assert_eq!(
            after, baseline,
            "cycle {cycle}/{CYCLES}: HAL device set did not stabilize back to \
             the pre-tap baseline within {SETTLE_TIMEOUT:?} of stop() \
             returning — the tap's aggregate device (or some other HAL \
             resource) was not torn down. before={baseline:?} after={after:?}"
        );
    }

    let grew_every_cycle = device_counts.windows(2).all(|pair| pair[1] > pair[0]);
    assert!(
        !grew_every_cycle,
        "HAL device count grew every cycle across {CYCLES} start/stop cycles: \
         {device_counts:?} — this indicates a leaked aggregate device per capture"
    );
}

/// Runs one system-audio start/stop cycle for `duration`, discarding
/// captured samples — this test only cares about the underlying HAL
/// resources (aggregate device, IOProc) left behind, not audio content.
#[cfg(target_os = "macos")]
fn run_one_capture_cycle(system_source: Option<&str>, duration: Duration) {
    let stop = Arc::new(AtomicBool::new(false));
    let stop_for_capture = Arc::clone(&stop);
    let system_source_owned = system_source.map(str::to_string);

    let capture_thread = thread::spawn(move || {
        let request = CaptureRequest {
            source: CaptureSource::System,
            device: None,
            system_source: system_source_owned.as_deref(),
            config: CaptureConfig::default(),
        };
        capture_sources(
            &request,
            stop_for_capture,
            |_samples| {},
            |resolved| println!("effective system-audio source: {resolved:?}"),
            |_rate: u32| {},
        )
    });

    thread::sleep(duration);
    stop.store(true, Ordering::Relaxed);
    let capture_result = capture_thread.join().expect("capture thread joins");
    capture_result.expect("system audio capture runs without error");
}

/// [`list_hal_device_ids`], sorted so two independent enumerations of the
/// same device set compare equal regardless of the HAL's internal ordering.
#[cfg(target_os = "macos")]
fn sorted_hal_device_ids() -> Vec<AudioObjectID> {
    let mut ids = list_hal_device_ids();
    ids.sort_unstable();
    ids
}

/// Polls [`sorted_hal_device_ids`] until two consecutive reads,
/// `poll_interval` apart, agree — or until `timeout` elapses, in which case
/// it returns whatever the last read was. Used for *both* the baseline and
/// every post-cycle read in
/// `system_capture_leaves_no_aggregate_device_after_stop`, since the same
/// HAL enumeration lag that can leave a just-destroyed aggregate device
/// briefly visible can equally leave a *previous* tap's residue in a
/// naively-immediate baseline read — waiting for two-reads-agree rather
/// than for a specific target value catches both.
#[cfg(target_os = "macos")]
fn stabilized_hal_device_ids(timeout: Duration, poll_interval: Duration) -> Vec<AudioObjectID> {
    let deadline = Instant::now() + timeout;
    let mut previous = sorted_hal_device_ids();
    loop {
        thread::sleep(poll_interval);
        let current = sorted_hal_device_ids();
        if current == previous || Instant::now() >= deadline {
            return current;
        }
        previous = current;
    }
}

/// Shells out to `pgrep -n afplay`, mirroring the spike that first validated
/// per-process tapping on this machine.
fn most_recent_afplay_pid() -> Option<i32> {
    std::process::Command::new("pgrep")
        .arg("-n")
        .arg("afplay")
        .output()
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .and_then(|stdout| stdout.trim().parse::<i32>().ok())
}
