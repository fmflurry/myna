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
use std::time::Duration;

use myna_audio::{
    capture_sources, list_system_audio_sources, rms, system_audio_status, CaptureConfig,
    CaptureRequest, CaptureSource, SystemAudioStatus, ALL_OUTPUT_SOURCE_ID,
};

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
            move |samples| {
                if let Ok(mut buffer) = collected_for_capture.lock() {
                    buffer.extend_from_slice(samples);
                }
            },
            |resolved| println!("effective system-audio source: {resolved:?}"),
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
