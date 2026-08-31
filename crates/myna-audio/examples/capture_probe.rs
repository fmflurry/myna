//! Throwaway manual-verification tool: runs a real, short system-audio
//! capture against a given `SystemAudioSource::id` (or all-output when no
//! argument is given) and prints sample count, non-zero count, RMS, and
//! peak. Not part of the crate's public surface or test suite — used to
//! eyeball real hardware capture results on a real machine, the same way
//! `list_sources.rs` eyeballs enumeration. Requires system-audio
//! (`kTCCServiceAudioCapture`) permission already granted to this binary.
//!
//! ```sh
//! cargo run -p myna-audio --example capture_probe --locked -- "app:group:microsoft-teams"
//! ```

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use myna_audio::{capture_sources, rms, CaptureConfig, CaptureRequest, CaptureSource, TrackBlock};

/// How long to run the probe capture before stopping and printing results.
const CAPTURE_DURATION: Duration = Duration::from_secs(5);

/// Largest absolute sample value, mirroring `tests/system_macos_live.rs`'s
/// own `peak` helper.
fn peak(samples: &[f32]) -> f32 {
    samples
        .iter()
        .fold(0.0_f32, |max, &sample| max.max(sample.abs()))
}

fn main() {
    let system_source = std::env::args().nth(1);
    println!("probing system_source = {system_source:?} for {CAPTURE_DURATION:?}");

    let collected: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
    let collected_for_capture = Arc::clone(&collected);
    let stop = Arc::new(AtomicBool::new(false));
    let stop_for_capture = Arc::clone(&stop);

    let capture_thread = thread::spawn(move || {
        let request = CaptureRequest {
            source: CaptureSource::System,
            device: None,
            system_source: system_source.as_deref(),
            config: CaptureConfig::default(),
        };
        capture_sources(
            &request,
            stop_for_capture,
            move |block: &TrackBlock<'_>| {
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
    let non_zero_count = samples.iter().filter(|&&sample| sample != 0.0).count();
    let level = rms(&samples);
    let peak_level = peak(&samples);
    println!(
        "captured {} samples ({non_zero_count} non-zero), rms = {level:.6}, peak = {peak_level:.6}",
        samples.len()
    );
}
