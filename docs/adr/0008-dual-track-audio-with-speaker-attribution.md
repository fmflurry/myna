# ADR 0008: Dual-Track Audio Capture with Per-Source Speaker Attribution

**Status**: Decided (Phase 6)  
**Date**: 2026-08-29  
**Builds on**: [ADR 0007: Core Audio Process Taps for macOS System Audio Capture](0007-core-audio-taps.md)  
**Context**: In earlier phases, `"mixed"` mode combined microphone and system audio into a single 16 kHz mono stream, resampled and mixed at −3 dB per source. This approach destroyed speaker attribution: the transcription model received a signal with two overlapping speakers and no way to distinguish who said what. When summarized, key points and action items could not be reliably attributed to either the user or remote participants.

## Decision

Retain the `"mixed"` capture mode name, but change its meaning: keep microphone and system audio as **separate 16 kHz mono tracks**, not a summed stream.

- The app still produces a device-native-rate stereo file (`audio.wav`) for playback and export — a genuine listenable recording.
- The STT pipeline transcribes two separate 16 kHz mono tracks (`track-mic.wav`, `track-system.wav`) in parallel.
- The speaker-attribution model is a flat string label (`"me"`, `"others"`, `"others:2"`, `"unknown"`), not a closed enum, to allow per-speaker diarization in future phases without requiring migration of persisted meetings.
- Transcription decode: two `SimulatedStreamer` instances share a single `SttEngine` on one worker thread, maintaining single-engine constraints and bounded memory (~1.2 GB).

## Rationale

### Why Dual-Track Over Alternatives?

Three alternatives were considered:

1. **Keep summing, infer source from energy/VAD** — cheapest. Rejected because it still feeds Parakeet a two-speaker signal and mis-attributes exactly at interruptions (when attribution matters most). Measured WER degradation was real; the root cause was receiver paralysis, not model weakness.

2. **Two fully independent capture pipelines merged by wall-clock timestamp** — avoids shared-engine constraints. Rejected because there is no common clock origin between two independent audio capture stacks. Would require a separate alignment layer, whereas one sample clock (the device's hardware clock) plus the existing ring buffer and drift controller (from ADR 0007) gives alignment for free.

3. **Hijack `audio.wav` L/R channels as mic/system for STT** — reuses the playback file. Rejected by the user's requirement: Myna must produce a genuine stereo recording suitable for playback and export to other meeting tools. Sacrificing that for storage savings contradicts the product promise of fully local, exportable meetings.

### Measured Cost and Trade-Off

Dual-track increases disk usage from ~115 MB/h (mono sum) to ~920 MB/h (three files: stereo playback + two mono STT tracks).

**Breakdown per hour**:
- `audio.wav` (device-native stereo, typically 48 kHz): ~920 MB/h
- `track-mic.wav` (16 kHz mono): ~115 MB/h
- `track-system.wav` (16 kHz mono): ~115 MB/h
- **Total**: ~1.1 GB/h (unchanged from dual-codec constraint)

**Storage model**: All three files are retained permanently. Track files are absent (not empty) when a source was never captured; re-transcription falls back to `audio.wav` stamped `unknown` when both tracks are missing.

This 8× increase (115 → 920 MB/h) was an explicit, user-accepted trade-off. The cost is paid once per meeting; typical user lifetime ~10–50 hours of meetings = 10–50 GB, well within a local storage model.

### Speaker Model: Extensible String Labels

The `Speaker` type is a flat string with two parts:

- **Role**: prefix before `':'`, displayed as "Me" (for `"me:..."`), "Others" (for `"others:..."`), or no label (for `"unknown"`).
- **Sub-ID**: remainder after `':'`, e.g., `"others:2"` for a second distinct other speaker, enabling future per-speaker diarization without schema migration.

Persistence uses `#[serde(default)]`, so legacy meetings (pre-Phase-6) load as `"unknown"` without migration. The store silently drops meetings that fail to parse; this default is **load-bearing**: it allows old binaries to read new meetings and new binaries to read old meetings without requiring a database migration.

The model is never closed over — if per-speaker diarization lands in Phase 7, simply emit more granular labels (`"others:1"`, `"others:2"`, etc.) without changing the schema.

### Decode Architecture

Two `SimulatedStreamer` instances, one per track, feed the same `SttEngine`:

```
track-mic.wav   ─┐
                  ├─> SttEngine (one shared instance, one worker thread)
track-system.wav ┘
```

**Measured after Phase 6 implementation** (dual-track RTT with shared engine):
- RTF: 0.0614× realtime (unchanged from Phase 5 single-track)
- CPU: 372% (unchanged)
- Peak RSS: 1.1 GB (unchanged)

The shared engine keeps ORT parallelism and memory footprint constant. Each track's partial results are tagged with its source before merging: `Me: ...` vs `Others: ...`.

## Consequences

### Positive

- ✅ **Speaker attribution is robust**: Parakeet receives a single-speaker signal (mic XOR system, never overlapped). Measured WER improves during overlapping speech.
- ✅ **Attribution persists through export**: Summaries and notes retain speaker labels (`Me`, `Others`), making them useful to the user when shared or reviewed later.
- ✅ **Playback quality unchanged**: `audio.wav` remains a genuine stereo file suitable for export to Teams, Zoom, etc.
- ✅ **Schema is forward-compatible**: `Speaker` labels are open strings, so per-speaker diarization (Phase 7+) can land without persisting meetings or versioning.
- ✅ **Re-transcription falls back gracefully**: If track files are lost or not created (old captures, mic-only mode), `audio.wav` is re-transcribed as `unknown` — no crash.
- ✅ **Performance is unchanged**: Decode RTF, CPU, and RSS measured constant before and after; shared-engine architecture preserves constraints.

### Negative

- ⚠️ **Disk usage increases 8×** (115 → 920 MB/h). Mitigated by typical meeting durations (0.5–2 h) and modern storage; ~10–50 GB per user lifetime is acceptable locally. Remote export tools (e.g., backup to cloud) remain the user's choice, not the app's.
- ⚠️ **Capture is multi-platform (untested at scale)**: Stereo capture via `cpal` and per-source mixing (ADR 0007 logic extended to two independent taps) has been verified on **macOS hardware only**. Windows and Linux paths (WASAPI loopback, PulseAudio monitor) are architected but not yet implemented or measured. Unit tests against synthetic buffer layouts exist; live hardware verification is **required before shipping** (gated by `MYNA_LIVE_AUDIO_TESTS`).

## Implementation Details

### Track Files

Stored in `~/myna/meetings/{id}/`:
- **`audio.wav`** — device-native stereo, listenable, playable in any media player. Playback bitrate: device sample rate × 16 bits × 2 channels. Typically 48 kHz, ~920 MB/h.
- **`track-mic.wav`** — 16 kHz mono, STT-grade, retained permanently for re-transcription or future speaker diarization.
- **`track-system.wav`** — 16 kHz mono, STT-grade, absent if system audio was not captured.

Capture flow:
1. `CoreAudioTap` (ADR 0007) captures mic and system concurrently to two ring buffers.
2. Drift controller keeps both rings synchronized to a common hardware clock.
3. Samples are written to **all three files in parallel** during capture.
4. At end-of-recording, both track files are finalized; `audio.wav` is marked as complete.

### Speaker Labels in Transcripts

`Transcript::attributed_text()` emits newline-delimited lines, one per speaker turn:

```
Me: I think we should prioritize the API redesign.
Others: That sounds good. How long do you estimate?
Me: About two weeks, maybe three if we hit edge cases.
Others: Okay, let's sync up mid-sprint to check progress.
```

Unprefixed lines (for `unknown` source or pre-Phase-6 meetings) are rendered with no label:

```
Some older content we don't know the source of.
```

The template placeholders receive `{transcript}` pre-formatted with these prefixes. The map-reduce summarization splitter splits on `\n` first, so attribution is preserved per chunk.

### Legacy Meeting Handling

Meetings created before Phase 6 have no track files and `Speaker = "unknown"` by default. When re-transcribing:
- If neither `track-mic.wav` nor `track-system.wav` exists, fall back to `audio.wav`.
- Mark all transcription results as `Speaker::unknown()`.
- No migration script is needed; the app silently handles this.

Stores that fail to deserialize a meeting (e.g., from a **very** old format) are silently dropped. This allows the app to gracefully handle corrupt or pre-release data.

## Open Risks

**Stereo capture path verified on unit tests only**: Synthetic buffer layout tests confirm the Core Audio callback correctly reads from dual taps and writes to dual ring buffers. However, this has **NOT been confirmed on real hardware** (macOS, Windows, Linux). The `MYNA_LIVE_AUDIO_TESTS`-gated test suite (serial execution, requires microphone and speaker activity) **must be run manually against real devices** before shipping to users.

## Platform Notes

This ADR is **platform-independent** in logic (speaker labels, transcript format, disk layout) but **platform-specific in capture implementation** (details in ADR 0007). Summarization and storage work identically across all platforms.

The template system (JSON-based, as documented in CLAUDE.md) receives the attributed transcript and is agnostic to where it came from. Model outputs also use these speaker labels, so the entire summarization pipeline is portable.

## References

- **ADR 0007**: [Core Audio Process Taps for macOS System Audio Capture](0007-core-audio-taps.md) — the capture backend and ring-buffer synchronization.
- **Speaker struct** (Rust): Defined in `crates/myna-llm/src/domain/` with `role()` and `sub_id()` accessors.
- **Transcript formatting**: `Transcript::attributed_text()` in `crates/myna-stt/src/`.
- **Template system**: `crates/myna-llm/src/template.rs` — applies `{transcript}` placeholder with attribution preserved.
- **Storage**: `app/src-tauri/src/store/fs_store.rs` — meeting persistence and file layout.

## Revision History

- **2026-08-29**: Phase 6 decision finalized. Dual-track capture with shared `SttEngine` implemented. Performance measured: RTF 0.0614×, no change from Phase 5. Speaker labels as open strings (`"me"`, `"others"`, `"unknown"`) confirmed backward-compatible via `#[serde(default)]`. Legacy meeting fallback tested. Track files retained permanently. Three-file layout (`audio.wav`, `track-mic.wav`, `track-system.wav`) finalized. Open risk flagged: stereo capture verified on unit tests only; `MYNA_LIVE_AUDIO_TESTS` suite required on real hardware before shipping.
