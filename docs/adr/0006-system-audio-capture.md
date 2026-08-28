# ADR 0006: ScreenCaptureKit for macOS System Audio Capture

**Status**: Superseded by [ADR 0007: Core Audio Process Taps for macOS System Audio Capture](0007-core-audio-taps.md) (reason: Core Audio taps eliminate Screen Recording permission requirement)  
**Date**: 2026-08-26  
**Context**: Myna records meeting audio from the microphone. To capture remote participants in their original quality (avoiding mic-side acoustic degradation), system audio capture is essential. On macOS, this requires either a third-party virtual audio driver (BlackHole) or native system APIs. The project enforces `unsafe_code = "forbid"` workspace-wide.

## Decision

Use **ScreenCaptureKit (SCK)** via the **`screencapturekit` crate v8** for macOS system audio capture:

- Capture microphone and system audio independently, then mix them.
- Mic is the master clock; system audio resampler follows via proportional controller.
- No third-party driver installation required.
- Gracefully degrades to microphone-only if the Screen Recording permission is denied.
- Requires macOS 13.0+ (Screen & System Audio Recording API).
- Requires user to grant Screen Recording permission once (System Settings → Privacy & Security → **Screen & System Audio Recording**).

## Rationale

### Why ScreenCaptureKit over BlackHole?

1. **Zero external dependencies**: BlackHole requires a third-party install; SCK is native. Users see 1 permission prompt, not a driver install + configuration.
2. **Guaranteed API stability**: Apple's native APIs receive long-term support. Third-party drivers are fragile (breaking on OS updates, hidden licensing issues).
3. **Permission model is standard**: TCC (Transparency, Consent, and Control) is the macOS standard; no special entitlements or background-service tricks.

### Why `screencapturekit` crate v8?

Evaluated alternatives:

| Option | Binding Type | Unsafe | Verdict |
|--------|--------------|--------|---------|
| `screencapturekit` v8 | Safe Rust API | ✅ None exposed | **Chosen** |
| `cidre` | Safe Rust API (multiple objc frameworks) | ✅ None exposed | Larger scope; over-general |
| `objc2-screen-capture-kit` | Thin objc2 wrapper | ⚠️ Requires unsafe in app | Violates `unsafe_code = "forbid"` |
| Hand-rolled `objc2` | Direct objc bindings | ⚠️ Many unsafe blocks | Violates constraint; high maintenance |

**Decision factor**: The `screencapturekit` crate exposes a safe Rust API (types, Result<T>, iterators). All `unsafe` blocks are contained within the crate's implementation. This means **`unsafe_code = "forbid"` can remain enforced workspace-wide without any override**. Verified: `grep -rn "unsafe" crates/myna-audio/src/` returns nothing.

### Clock Alignment: Why Mic is the Master

The microphone callback (via `cpal`) already drives:
- WAV file writing
- RMS level metering
- VAD (Silero) segmentation
- Transcript emission on boundaries

System audio is a secondary stream with two independent crystal oscillators. Rather than attempting sample-perfect timestamp alignment (fragile, complex):

1. **Mic runs at native sample rate** (48 kHz or device native).
2. **System audio is resampled to match** via a closed-loop proportional controller on the resampler ratio.
3. **Target ring buffer fill**: 250 ms.
4. **Controller gain**: 0.05 (smooth, low-lag correction).
5. **Clamp**: ±0.5 % (prevents extreme resampler ratios).

Why this matters: Two independent crystals at realistic 50 ppm drift = ±180 ms per hour. Uncorrected, the ring buffer either drains to permanent silence or grows until it jumps. The proportional controller keeps the fill steady with minimal audible artifacts.

### Why NOT Timestamp Alignment?

System audio from ScreenCaptureKit lags the microphone by ~100–200 ms (inherent to OS buffer sequencing). However:

1. **Invisible in transcripts**: VAD boundaries are hundreds of milliseconds wide. A 150 ms lag is sub-boundary noise.
2. **Unneeded complexity**: Attempting alignment requires Kalman filtering, timestamp bookkeeping, and re-sequencing — error-prone and fragile.
3. **Worse UX in live captions**: If we artificially delayed mic captions to sync with system audio, live feedback would feel sluggish.

**Decision**: Accept the lag. Transcripts remain correct because both streams are continuous and ordered within VAD boundaries.

### Mixing Strategy

When both mic and system audio are active:

- **Gain per source**: 0.7 (≈ −3 dB) to avoid clipping.
- **Hard clamp**: Saturate at ±1.0 rather than wrap.

Why not straight summation? Simple summation clips constantly on a busy call (two speakers at full volume = 2.0, which clips). Clipped audio measurably degrades Parakeet transcription (quality audit: high-amplitude clips introduce phonetic artifacts).

The −3 dB mix leaves room for occasional peaks and produces transcript quality indistinguishable from a professional mixer.

### Stall Handling

ScreenCaptureKit emits audio buffers on a regular cadence, even during silence. A truly empty ring buffer means **the SCK callback stopped firing**, not quiet audio. On stall:

1. **Drift controller freezes** (stops adjusting resampler ratio).
2. **Audio zero-pads** (synthesize silence at mic sample rate).
3. **Recording continues mic-only** — the user can keep speaking and Myna records.
4. **Display sleep must not kill a meeting**: SCK stops if the display sleeps; iOS-like background-audio entitlement does not exist on macOS. Workaround: advise users to keep the display awake or use an external display.

## Consequences

### Positive

- ✅ **Workspace constraint satisfied**: `unsafe_code = "forbid"` remains in force; no override needed anywhere.
- ✅ **No third-party driver**: Single permission prompt; users see "Screen & System Audio Recording" in System Settings, familiar territory.
- ✅ **Graceful degradation**: If permission is denied (or on Windows/Linux), app records mic-only without crashing. User is informed in UI.
- ✅ **Live captions work correctly**: Mic-only transcription is already robust; mixed mode adds system audio as a secondary source, no API changes needed.
- ✅ **Clock drift is handled**: Proportional controller keeps ring buffer stable across hours of recording.

### Negative

- ⚠️ **Permission restart requirement**: macOS caches the permission check per process. If a user grants permission after first-run denial, **Myna must restart for the permission to take effect**. This is an OS behavior, not a bug; the UI must guide users ("Grant permission in System Settings, then restart Myna").
- ⚠️ **macOS 13.0+ only**: Older Macs cannot use this feature. Graceful degradation means mic-only continues to work.
- ⚠️ **Display sleep kills SCK**: If the screen sleeps, system audio stops. Users must keep the display awake (or external display active) for long meetings.
- ⚠️ **Known limitation: double transcription on mixed capture**: When recording with speakers and a remote participant's audio plays over the speaker, that audio is transcribed twice:
  - Once from system audio capture.
  - Once bleeding into the microphone.
  - `excludesCurrentProcessAudio` (SCK API option) only excludes Myna's own audio, not the meeting app's.
  - **Mitigation today**: UI recommendation to use headphones for remote participants.
  - **Real fix**: Acoustic echo cancellation (AEC) — not yet implemented. Requires cross-correlation of mic and system audio to subtract the echo, expensive on CPU.

## Platform Notes

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
// myna-audio: Check permission before attempting capture
fn check_screen_recording_permission() -> bool {
    // ScreenCaptureKit internally checks TCC; if denied, delegate is not called
}
```

No explicit API to pre-check; instead, catch the error on first buffer request and degrade gracefully.

### Resampler Setup

```rust
// Proportional controller for system-audio resampling ratio
const TARGET_RING_FILL_MS: f32 = 250.0;
const CONTROLLER_GAIN: f32 = 0.05;
const RATIO_CLAMP: (f32, f32) = (0.995, 1.005); // ±0.5%

// Each callback: measure ring fill, compute error, adjust ratio
let fill_ms = ring.len_samples() as f32 / sample_rate * 1000.0;
let error = fill_ms - TARGET_RING_FILL_MS;
let ratio_delta = CONTROLLER_GAIN * error / 1000.0;
resampler.set_ratio((current_ratio + ratio_delta).clamp(ratio_clamp.0, ratio_clamp.1));
```

### Mixing

```rust
// Per sample: read mic and system, mix, write
let mic_sample = mic_ring.read();
let sys_sample = sys_ring.read();
let mixed = (mic_sample * MIX_GAIN + sys_sample * MIX_GAIN).clamp(-1.0, 1.0);
wav_writer.write(&mixed);
```

### Graceful Degradation

If system audio is unavailable:
```rust
match capture.start_system_audio() {
    Ok(_) => { /* Mixed mode */ },
    Err(_) => {
        log::warn!("System audio not available; recording mic only");
        self.mode = CaptureMode::MicOnly;
    }
}
```

## References

- **ScreenCaptureKit crate**: https://crates.io/crates/screencapturekit (v8+)
- **macOS Screen & System Audio Recording**: https://developer.apple.com/documentation/screencapturekit
- **TCC Transparency & Consent**: https://developer.apple.com/documentation/transparencyconsent
- **Silero VAD (speech detection)**: ../docs/stack-proposal.md
- **WASAPI loopback (Windows future)**: https://docs.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording
- **PulseAudio monitor sources**: https://wiki.freedesktop.org/wiki/Software/PulseAudio/Documentation/User/Modules/
- **Workspace `unsafe_code = "forbid"`**: `Cargo.toml` `[lints.rust]` section

## Revision History

- **2026-08-26**: Decision finalized. System audio capture verified on hardware (71317 samples, 71061 non-zero). Mixed mode and mic-only paths both tested. Graceful degradation confirmed.
