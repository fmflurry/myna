//! WASAPI loopback viability probe (Windows only).
//!
//! Opens the default render endpoint with `AUDCLNT_STREAMFLAGS_LOOPBACK`,
//! captures a few seconds of the shared mix, and reports the native mix
//! rate, channel count, RMS/peak, and the silent-vs-audible frame split the
//! future system-audio backend would need. Device removal mid-probe is
//! reported, not panicked.
//!
//! ```sh
//! cargo run -p myna-wasapi-probe --locked
//! ```
//!
//! The stub below keeps this binary compiling on non-Windows hosts; the
//! real probe never compiles there, and no `SystemAudioCapture` behavior
//! changes anywhere.

#[cfg(not(target_os = "windows"))]
fn main() {
    eprintln!("myna-wasapi-probe runs on Windows only.");
}

#[cfg(target_os = "windows")]
use std::time::{Duration, Instant};

#[cfg(target_os = "windows")]
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_E_DEVICE_INVALIDATED, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_LOOPBACK, WAVEFORMATEX, WAVE_FORMAT_PCM,
};
#[cfg(target_os = "windows")]
use windows::Win32::Media::KernelStreaming::{KSDATAFORMAT_SUBTYPE_PCM, WAVE_FORMAT_EXTENSIBLE};
#[cfg(target_os = "windows")]
use windows::Win32::Media::Multimedia::{KSDATAFORMAT_SUBTYPE_IEEE_FLOAT, WAVE_FORMAT_IEEE_FLOAT};
#[cfg(target_os = "windows")]
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
    COINIT_MULTITHREADED,
};

#[cfg(target_os = "windows")]
fn main() -> windows::core::Result<()> {
    run_probe()
}

#[cfg(target_os = "windows")]
struct ComGuard;

#[cfg(target_os = "windows")]
impl Drop for ComGuard {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

#[cfg(target_os = "windows")]
#[derive(Clone, Copy, PartialEq, Eq)]
enum SampleLayout {
    Float32,
    Pcm16,
    Pcm32,
}

#[cfg(target_os = "windows")]
#[derive(Default)]
struct ProbeStats {
    frames: u64,
    silent_frames: u64,
    packets: u64,
    sum_squares: f64,
    peak: f32,
}

#[cfg(target_os = "windows")]
impl ProbeStats {
    fn push(&mut self, value: f32) {
        self.sum_squares += f64::from(value) * f64::from(value);
        self.peak = self.peak.max(value.abs());
    }
}

#[cfg(target_os = "windows")]
fn sample_layout(mix_format: *const WAVEFORMATEX) -> Option<SampleLayout> {
    // SAFETY: `mix_format` is the caller-owned `GetMixFormat` buffer, valid
    // for the duration of this call; only read, never written.
    let mix: WAVEFORMATEX = unsafe { *mix_format };
    let tag = u32::from(mix.wFormatTag);
    if tag == WAVE_FORMAT_IEEE_FLOAT && mix.wBitsPerSample == 32 {
        return Some(SampleLayout::Float32);
    }
    if tag == WAVE_FORMAT_PCM {
        return match mix.wBitsPerSample {
            16 => Some(SampleLayout::Pcm16),
            32 => Some(SampleLayout::Pcm32),
            _ => None,
        };
    }
    if tag == WAVE_FORMAT_EXTENSIBLE {
        // WAVEFORMATEXTENSIBLE is `packed(1)`, so `SubFormat` may be
        // unaligned; read it without creating an unaligned reference.
        let sub_format = unsafe {
            std::ptr::addr_of!(
                (*mix_format.cast::<windows::Win32::Media::Audio::WAVEFORMATEXTENSIBLE>())
                    .SubFormat
            )
            .read_unaligned()
        };
        if sub_format == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT && mix.wBitsPerSample == 32 {
            return Some(SampleLayout::Float32);
        }
        if sub_format == KSDATAFORMAT_SUBTYPE_PCM {
            return match mix.wBitsPerSample {
                16 => Some(SampleLayout::Pcm16),
                32 => Some(SampleLayout::Pcm32),
                _ => None,
            };
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn run_probe() -> windows::core::Result<()> {
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok()? };
    let _com = ComGuard;

    let enumerator: IMMDeviceEnumerator =
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)? };
    let device = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole)? };
    let client: IAudioClient = unsafe { device.Activate(CLSCTX_ALL, None)? };
    let mix_format = unsafe { client.GetMixFormat()? };
    let mix: WAVEFORMATEX = unsafe { *mix_format };
    // `WAVEFORMATEX` is packed, so its fields cannot be borrowed; copy the
    // scalars out before formatting.
    let actual_rate = mix.nSamplesPerSec;
    let channels = mix.nChannels;
    let bits = mix.wBitsPerSample;
    let tag = mix.wFormatTag;
    println!("actual_rate={actual_rate} channels={channels} bits={bits} tag={tag}");
    let layout = sample_layout(mix_format);
    let init = unsafe {
        client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK,
            10_000_000,
            0,
            mix_format,
            None,
        )
    };
    unsafe { CoTaskMemFree(Some(mix_format as _)) };
    init?;
    let Some(layout) = layout else {
        println!("unsupported mix format; probe inconclusive");
        return Ok(());
    };

    let capture: IAudioCaptureClient = unsafe { client.GetService()? };
    unsafe { client.Start()? };
    let (stats, device_removed) = capture_loop(&capture, layout, channels as usize);
    let stopped = unsafe { client.Stop() };
    report(&stats, channels as usize, device_removed);
    stopped
}

#[cfg(target_os = "windows")]
fn capture_loop(
    capture: &IAudioCaptureClient,
    layout: SampleLayout,
    channels: usize,
) -> (ProbeStats, bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut stats = ProbeStats::default();
    while Instant::now() < deadline {
        let available = match unsafe { capture.GetNextPacketSize() } {
            Ok(frames) => frames,
            Err(error) if error.code() == AUDCLNT_E_DEVICE_INVALIDATED => {
                return (stats, true);
            }
            Err(error) => panic!("GetNextPacketSize failed: {error}"),
        };
        if available == 0 {
            std::thread::sleep(Duration::from_millis(10));
            continue;
        }
        let mut data: *mut u8 = std::ptr::null_mut();
        let mut frames = 0;
        let mut flags = 0;
        match unsafe { capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None) } {
            Ok(()) => {}
            Err(error) if error.code() == AUDCLNT_E_DEVICE_INVALIDATED => {
                return (stats, true);
            }
            Err(error) => panic!("GetBuffer failed: {error}"),
        }
        stats.packets += 1;
        stats.frames += u64::from(frames);
        if (flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32)) != 0 {
            stats.silent_frames += u64::from(frames);
        } else {
            let count = frames as usize * channels;
            match layout {
                SampleLayout::Float32 => {
                    for &sample in unsafe { std::slice::from_raw_parts(data.cast::<f32>(), count) }
                    {
                        stats.push(sample);
                    }
                }
                SampleLayout::Pcm16 => {
                    for &sample in unsafe { std::slice::from_raw_parts(data.cast::<i16>(), count) }
                    {
                        stats.push(f32::from(sample) / 32768.0);
                    }
                }
                SampleLayout::Pcm32 => {
                    for &sample in unsafe { std::slice::from_raw_parts(data.cast::<i32>(), count) }
                    {
                        stats.push(sample as f32 / 2_147_483_648.0);
                    }
                }
            }
        }
        match unsafe { capture.ReleaseBuffer(frames) } {
            Ok(()) => {}
            Err(error) if error.code() == AUDCLNT_E_DEVICE_INVALIDATED => {
                return (stats, true);
            }
            Err(error) => panic!("ReleaseBuffer failed: {error}"),
        }
    }
    (stats, false)
}

#[cfg(target_os = "windows")]
fn report(stats: &ProbeStats, channels: usize, device_removed: bool) {
    let audible = stats.frames - stats.silent_frames;
    let rms = if audible == 0 {
        0.0
    } else {
        (stats.sum_squares / (audible as f64 * channels as f64)).sqrt()
    };
    println!(
        "frames={} silent_frames={} packets={}",
        stats.frames, stats.silent_frames, stats.packets
    );
    println!("rms={rms:.6} peak={:.6}", stats.peak);
    if device_removed {
        println!("device invalidated mid-probe");
    }
    let verdict = if audible == 0 {
        "silence (start playback and re-run)"
    } else if rms < 0.000_100 {
        "near-silence"
    } else {
        "playback detected"
    };
    println!("verdict={verdict}");
}
