# Developer notes

## Core Audio Taps: Live Audio Tests

System audio capture (Core Audio taps on macOS 14.4+) includes live integration tests that must run serially because Core Audio rejects concurrent tap creation within the same process (error `kAudioHardwareIllegalOperationError`).

**Environment gate**: `MYNA_LIVE_AUDIO_TESTS`

Run live audio tests:

```bash
export MYNA_LIVE_AUDIO_TESTS=1
cargo test --workspace --ignored -- --test-threads=1
```

Do not run with `--test-threads > 1`; concurrent tap creation will fail. This is an OS limitation, not a test harness limitation.

## Graceful Degradation

Myna records mic-only if:
1. System audio permission is denied.
2. macOS version is below 14.4 (Core Audio taps not available).
3. The Core Audio device enumeration fails at runtime.

Mic-only mode uses the same `cpal`-based mic capture. Users see a notification in the UI if system audio became unavailable.
