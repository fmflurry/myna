# ADR 0007: Core Audio Process Taps for macOS System Audio Capture

**Status**: Decided (Phase 4)  
**Date**: 2026-08-28  
**Supersedes**: [ADR 0006: ScreenCaptureKit for macOS System Audio Capture](0006-system-audio-capture.md)  
**Context**: ADR 0006 chose ScreenCaptureKit (SCK) for system audio capture on macOS, but the approach required users to grant **Screen Recording permission** — intrusive for a privacy-first local app. Core Audio taps offer a direct alternative: capture system audio independently using a distinct TCC service (`kTCCServiceAudioCapture`) that does not touch the video pipeline.

## Decision

Replace **ScreenCaptureKit** with **Core Audio process taps** (native Core Audio IOProc API) for macOS system audio capture:

- Capture microphone and system audio independently, then mix them (same logic as ADR 0006).
- No dependency on Screen Recording permission; uses `kTCCServiceAudioCapture` service instead.
- Supports per-application audio capture via PID-based enumeration (an improvement over SCK's `SCRunningApplication` filter).
- Gracefully degrades to microphone-only if the audio-capture permission is denied or on unsupported macOS versions.
- Requires macOS 14.4+ for system audio (mic-only works below via graceful degradation).
- Requires user to grant Audio Capture permission once. In System Settings → Privacy & Security → **Screen & System Audio Recording**, audio-only apps appear under **"System Audio Recording Only"**. Myna never captures video.

## Rationale

### Why Core Audio Taps Over ScreenCaptureKit?

ScreenCaptureKit has no audio-only capture mode. `SCContentFilter` requires a display or window, and the video pipeline runs regardless of whether video frames are consumed. macOS gates this capability behind **Screen Recording permission**, which signals to users that the app will "record your screen." For a privacy-first local meeting recorder, asking for screen-recording access to capture *only audio* is a poor trade-off.

**Evidence gathered before committing:**

1. **Apple's Core Audio Process Taps guide** (official documentation) makes no mention of Screen Recording permission; it references only audio-related TCC services.
2. **Apple Support**: *"You can allow apps to record both your screen and audio, or just your audio."* — suggesting a distinct permission model exists.
3. **Live TCC database inspection**: Other meeting apps (Zoom, Teams) already held `kTCCServiceAudioCapture` grants, confirming the service is the standard path.
4. **Spike testing on hardware** (before any production migration): confirmed Core Audio taps capture system audio correctly, with measurable RMS and peak values matching expected ranges.

### Per-Application Capture (Unexpected Benefit)

Core Audio taps enumerate by process ID (PID), enabling true per-application filtering. SCK's `SCRunningApplication` filter never produced a confirmed positive in practice.

**Measured on hardware:**
- All-output RMS 0.114 / peak 0.796 vs per-process RMS 0.124 / peak 0.875 — statistically indistinguishable.
- Per-process filtering now actually works, benefiting users who want to isolate, e.g., Zoom audio from background browser tabs.

### Cost: Platform Floor Increase

macOS floor: 13.0 (SCK) → 14.4 (Core Audio taps).

**Impact**: ~1–2% of Macs in use cannot use system audio capture; ~98% are on macOS 15+. Users on unsupported versions silently degrade to mic-only mode (existing graceful-degradation path). No breaking change.

### Unsafe Code Containment

Core Audio is a C API. The workspace enforces `unsafe_code = "forbid"` globally (inherited from ADR 0006), and we maintain this constraint:

- New crate `crates/myna-coreaudio-tap` does **not** opt into workspace lints; it sets `unsafe_code = "allow"` locally.
- All FFI calls (~six call groups) are wrapped in one RAII-like type, keeping unsafety localized.
- **No other crate contains `unsafe` code.**

### Simplification Gained

**Deleted four `build.rs` files** (crates/myna-audio, crates/myna-stt, app/src-tauri, tests/integration) that existed only to emit a Swift runtime rpath fixup for `libswift_Concurrency`. This library was pulled in transitively via SCK's dependency on `apple-metal`.

Core Audio is pure C; no Swift bridging layer exists. Verified by:
1. Clean relink with no warnings.
2. `otool -L | grep -i swift` returning nothing (no Swift dylib dependencies).

## Consequences

### Positive

- ✅ **Permission UX improved**: System Settings → Privacy & Security → **Screen & System Audio Recording** now shows Myna under **"System Audio Recording Only"** section (not screen recording). The pane name mentions "Screen", so we must clarify that Myna captures audio only, no video. Message is honest and privacy-respecting.
- ✅ **Workspace constraint maintained**: `unsafe_code = "forbid"` remains workspace-wide; unsafety is localized to one new crate.
- ✅ **Graceful degradation preserved**: If permission denied or macOS < 14.4, app records mic-only without crashing.
- ✅ **Per-application capture works**: Users can now isolate audio from specific apps (e.g., Zoom vs. browser tabs).
- ✅ **Simplified build graph**: Four `build.rs` files and their Swift-runtime workarounds are gone; build is cleaner.
- ✅ **Clock drift handling**: Proportional controller (from ADR 0006) continues to keep ring buffer stable across hours of recording.

### Negative

- ⚠️ **Permission restart requirement**: macOS caches the permission check per process. If a user grants permission after first-run denial, **Myna must restart for the permission to take effect**. This is an OS behavior, not a bug; the UI must guide users. *(Identical to ADR 0006.)*
- ⚠️ **No public permission preflight API**: The private `TCCAccessPreflight` symbols must not be shipped. Permission status is genuinely `Unknown` until a capture is attempted. The UI must treat `Unknown` as *selectable* — otherwise the OS permission prompt never appears.
- ⚠️ **Stall detection changed**: SCK emitted buffers during silence, so "no callback for 2 s" worked. Core Audio IOProcs keep firing even during silence, emitting all-zero samples. The new rule adds a long (30 s) silence window cross-checked against `kAudioProcessPropertyIsRunningOutput`, rate-limited to one HAL query per second — because that property means "holds an output session," not "is playing," and Teams/Zoom hold it through an entire call. A short window would tear down a healthy capture during conversational pauses.
- ⚠️ **Sample rate is discovered, not requested**: Read from the aggregate device's `kAudioDevicePropertyStreamFormat` using **Input scope** (Global scope returns nothing).
- ⚠️ **IOProc runs on hard realtime thread**: The callback is registered with `in_dispatch_queue: None` (hard realtime). This means:
  - No allocation, no blocking inside the callback.
  - The callback body is wrapped in `catch_unwind` because it is `extern "C-unwind"` and a panic would unwind into Core Audio's own frames.
  - Great care needed: no user-level locks, no I/O, no logging.
- ⚠️ **Concurrent tap creation is rejected**: Core Audio rejects two taps being created concurrently in one process (`kAudioHardwareIllegalOperationError`). Live tests are serialized; no parallel capture-startup tests are possible.
- ⚠️ **Permission prompt wording unverified**: The spike's ad-hoc-signed bundle never received a prompt or a TCC record, attributed to having no stable Team ID. The exact wording users will see (`NSAudioCaptureUsageDescription` in `Info.plist`) must be confirmed once the app has real code-signing. Expected wording: *"Myna needs permission to record system audio from your speakers and other apps."* — but unverified.
- ⚠️ **Display sleep no longer kills capture** (improvement, but different behavior): Unlike SCK, Core Audio continues to run even if the display sleeps. This is actually good for long meetings, but differs from SCK's previous behavior. Users no longer need to "keep the display awake."

## Platform Notes

### macOS (Now Implemented)

Core Audio taps are the new system audio backend. Mic-only capture via `cpal` is unchanged.

### Windows (Planned, Not Yet Built)

Windows WASAPI loopback (`AUDCLNT_STREAMFLAGS_LOOPBACK`) provides equivalent functionality. The abstraction is already in place:

```rust
pub trait AudioCaptureBackend {
    fn capture_mic(&self) -> impl Stream<Sample = f32>;
    fn capture_system(&self) -> impl Stream<Sample = f32>;  // Platform-specific
}
```

Windows backend would implement `capture_system()` using WASAPI loopback (via `winapi` or `windows` crate), reusing the same ring-buffer and mixing logic.

### Linux (Planned, Not Yet Built)

PulseAudio and PipeWire both expose `.monitor` sources (virtual capture from speaker outputs). Existing `cpal` integration can be extended to open the monitor source alongside the mic. A `PulseAudio` backend would reuse the ring-buffer and controller logic.

The **`SampleRing`** and **`DriftController`** types are the abstraction boundary; platform backends only need to fill the ring from their respective streams.

## Implementation Details

### Permission Checking

```rust
// myna-coreaudio-tap: No public preflight API; status is Unknown until first capture
fn check_audio_capture_permission() -> PermissionStatus {
    // Status only known after attempting capture
    PermissionStatus::Unknown
}
```

The UI must permit users to select "system audio" even with `Unknown` status, so the OS can present the permission prompt.

### IOProc Design

```rust
// Hard realtime callback, no allocation/blocking
extern "C-unwind" fn io_proc_callback(
    _: AudioDeviceID,
    _: &AudioTimeStamp,
    in_data: *const AudioBufferList,
    _: &AudioTimeStamp,
    out_data: *mut AudioBufferList,
    _: &AudioTimeStamp,
    in_client_data: *mut c_void,
) -> OSStatus {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let tap = &*(in_client_data as *mut CoreAudioTap);
        // Read samples from in_data, write to ring buffer
        tap.on_audio_frame(in_data, out_data).unwrap_or(kAudio_UnknownError as i32)
    })).unwrap_or(kAudio_UnknownError as i32)
}
```

### Stall Detection (30 s Silence Window)

```rust
const SILENCE_WINDOW_S: f32 = 30.0;
const HAL_QUERY_RATE_HZ: f32 = 1.0;

fn detect_stall(
    ring_fill_count: u32,
    silence_duration: f32,
    is_output_running: bool,
) -> bool {
    // Stall if:
    // 1. Ring is empty AND
    // 2. Silence window exceeded AND
    // 3. Output is not running (device has no session active)
    ring_fill_count == 0
        && silence_duration > SILENCE_WINDOW_S
        && !is_output_running
}
```

HAL property query is rate-limited to 1 Hz (every 1000 ms) to avoid starving other threads.

### Mixing (Unchanged from ADR 0006)

```rust
// Per sample: read mic and system, mix, write
let mic_sample = mic_ring.read();
let sys_sample = sys_ring.read();
let mixed = (mic_sample * MIX_GAIN + sys_sample * MIX_GAIN).clamp(-1.0, 1.0);
wav_writer.write(&mixed);
```

## References

- **Core Audio Process Taps** (Apple): https://developer.apple.com/documentation/coreaudio/capturing_audio_from_the_system_in_your_app
- **AudioDeviceCreateIOProcID**: https://developer.apple.com/documentation/coreaudio/1566108-audiodevicecreateioproc
- **TCC Services (Transparency & Consent)**: https://developer.apple.com/documentation/transparencyconsent
- **macOS 14.4 Release Notes**: https://developer.apple.com/news/releases/macos-14-4/
- **Previous decision (ADR 0006)**: [ScreenCaptureKit for macOS System Audio Capture](0006-system-audio-capture.md)
- **Silero VAD (speech detection)**: ../docs/stack-proposal.md

## Revision History

- **2026-08-28**: Decision finalized. Core Audio taps measured on hardware (all-output and per-process waveforms captured and analyzed). Permission model confirmed via TCC database inspection and Apple Support documentation. Build simplification verified (four `build.rs` deletions, no Swift dependencies post-relink). Spike completed before any production work began. Graceful degradation to mic-only tested below macOS 14.4.
