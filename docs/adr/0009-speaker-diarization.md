# ADR 0009: Offline Speaker Diarization with Manual Trigger and Per-Segment Correction

**Status**: Decided (Phase 7)  
**Date**: 2026-08-30  
**Builds on**: [ADR 0008: Dual-Track Audio Capture with Per-Source Speaker Attribution](0008-dual-track-audio-with-speaker-attribution.md)  
**Context**: After dual-track capture (ADR 0008), every remote participant collapsed into a single `others` label. A user watching a real recording saw two distinct people both rendered as "Others". The `Speaker` label was designed as an open string (`"me"`, `"others"`, `"others:2"`, `"unknown"`) precisely to enable per-speaker diarization in future phases without requiring migration of persisted meetings — this ADR spends that affordance.

## Decision

Offline speaker diarization over `track-system.wav` only, using sherpa-onnx's `OfflineSpeakerDiarization` (pyannote-segmentation-3.0 + NeMo TitaNet-small embeddings, `FastClusteringConfig { num_clusters: -1, threshold: 0.5 }`). No new Rust dependency — the binding was already present in the pinned sherpa-onnx 1.13.6 and the native symbols were verified in the linked static library.

**Manual trigger, not automatic.** A "Detect speakers" control appears beside the re-transcribe actions. Rationale: the pass costs roughly 1–5 minutes per recorded hour and the user is often finished with the app when a meeting ends; automatic means a machine that keeps working for a result nobody asked for. It also makes the confidence rule legible — a partially-`others` result reads as an honest outcome rather than a silent failure. Mutually exclusive with recording and re-transcribe via the existing import guard.

**Why nothing runs live.** Clustering needs the whole recording: identity is global, and with an inferred speaker count a late joiner can renumber everyone retroactively. A live "speaker changed" heuristic would flicker labels mid-meeting, which is fabricating attribution the app does not have.

## Confidence Rule

The **honesty mechanism — state it exactly**: a segment is relabelled `others:N` only when all hold:
- `num_speakers >= 2` (otherwise the whole transcript stays bare `others`, because "Others 1" is meaningless with one speaker)
- segment duration >= 1.0 s
- >= 70% of the segment covered by exactly one speaker index

Anything failing stays bare `others`, meaning *we don't know which*, not a guess. `me`, `unknown`, and user-pinned segments are never touched.

## Speaker Names & Display

Display names live in `Meeting.speaker_names: BTreeMap<String,String>` (`#[serde(default)]`, additive, no migration), keyed by label. They can NEVER enter a label: `Speaker::is_well_formed` restricts sub-ids to `[a-z0-9_-]+`, so `others:Jean`, `others:José`, `others:Marie Dupont` would silently degrade to `unknown` — a data-loss trap. A rename is rejected unless the label round-trips through `Speaker::parse` unchanged.

**Per-segment correction** works via a chip-click menu (Me / Others / known identities / New speaker…), deliberately NOT the free-text segment editor. Corrections set `speaker_pinned`, which `relabel_others` skips, so re-running detection never silently overwrites the user's work. User-minted speakers use a reserved `m`-prefixed namespace (`others:m1`), and the diarizer only ever emits pure-numeric sub-ids, so collision is structurally impossible rather than merely unlikely. Reassigning to `me` is allowed — the "me is guaranteed the user" rule constrains what the machine asserts, and a user correcting a mislabel of their own voice is ground truth.

**Ordering: Record → Optional Re-Transcribe → Detect Speakers → Name.** Re-transcribe clears `speaker_names` (after re-clustering, `others:1` is likely a different human, and displaying "Jean" over someone else's words is the app lying about who spoke); the old map is snapshotted into the existing `transcript.previous.json` backup, and the re-transcribe controls warn before you click.

**Names reach export and the summarizer**, not just the transcript view — "Jean: I'll own the migration" lets the model put a real name in the action items; "Others 1:" cannot. Grouping stays keyed on the underlying label, so two speakers sharing a display name do not merge.

## Models

~45 MiB total. Fresh installs bundle diarization automatically — when core models are missing (`!all_present`), **Initialize** downloads diarization alongside Parakeet/Qwen/Silero (via `missing_artifacts` including `Diarization`). Existing installs remain not gated (`all_present` = parakeet && qwen && silero), so they are never blocked; diarization is fetched on demand via the **Download speaker models** CTA in Detect speakers, or manually via `./scripts/download-models.sh --only diarization`. 

**Licences:** pyannote-segmentation-3.0 is MIT (CNRS, bundled LICENSE verified); NeMo TitaNet is Apache-2.0 per the NeMo Toolkit licence. `sherpa-onnx-reverb-diarization-v1` was rejected — Rev.ai's licence is not MIT-compatible.

## Measured Cost

Real run, on-device:
- Models load: ~0.10 s
- Added RTF: 0.0413
- Peak RSS delta: ~300 MB

Gates were RTF > 0.12, RSS delta > 500 MB.

## Rejected Alternatives and Why

- **Automatic-on-stop**: Machine keeps working unasked.
- **Live/streaming diarization**: No streaming API in the binding, and identities are not stable until the recording ends.
- **Storing display names inside the label**: Silent data loss via `is_well_formed`.
- **Index-keyed override map for corrections**: Segment indices shift on re-merge, so an index-keyed map is silent corruption waiting to happen — hence the per-segment `speaker_pinned` flag that travels with the segment.
- **Diarizing the mic track**: Would give up the one attribution the app is certain about.

## Open Risk — UNVERIFIED ACCURACY

**State it plainly and prominently.** Accuracy is UNVERIFIED on real multi-party call audio. The only recording available during development was a 54-second single-narrator mic test, on which the model reported 5 speakers. Video-call audio is codec-compressed with aggressive gain control, which flattens exactly the voice characteristics these models rely on, and that is not represented in the benchmark sets they are tuned on. The confidence rule is designed to absorb overcounting by leaving low-confidence segments bare, but this has NOT been validated end-to-end. 

**A real two-or-more-participant call must be recorded and inspected before trusting the output.** Do not soften this.

Known failure modes: overlapping speech, short utterances, similar voices, late joiners, and mixdown (not per-participant) call audio.

## Consequences

### Positive

- ✅ **Multiple remote speakers are now distinguishable**: Transcript labels change from bare `"others"` to `"others:1"`, `"others:2"`, etc., enabling readers and summaries to track who said what.
- ✅ **User corrections are safe**: Per-segment `speaker_pinned` flag prevents re-running detection from silently overwriting corrections.
- ✅ **User-minted names avoid data loss**: Reserved `m`-prefixed namespace makes collision structurally impossible.
- ✅ **Names reach summaries**: Summaries now include real speaker names, making action items and key points more useful.
- ✅ **Graceful degradation**: The confidence rule leaves low-confidence segments bare, so partial results read as honest.
- ✅ **Optional models don't lock out users**: Excluded from `all_present` gate; existing users are not forced to download them.
- ✅ **Models are licensed**: MIT and Apache-2.0, compatible with project licence.

### Negative

- ⚠️ **Accuracy unverified on real call audio**: Only tested on a single-narrator 54-second mic test. Video-call audio (codec-compressed, aggressive gain control) is not represented in benchmark sets. **Required before shipping:** real multi-party call recording must be captured and inspected end-to-end.
- ⚠️ **Processing time is real**: 1–5 minutes per recorded hour. Not automatic, so users must explicitly opt in; adds UI flow.
- ⚠️ **System audio only**: Diarizes `track-system.wav` only, missing any overlapping user voice. Rationale: `me` is the ground-truth attribution (the user knows their own voice), and system audio is what needs disambiguation.

## Implementation Details

### Diarization Process

1. Load pre-downloaded models (~45 MiB, optional, not in default `all_present` gate).
2. Run `OfflineSpeakerDiarization` over `track-system.wav` with `FastClusteringConfig { num_clusters: -1, threshold: 0.5 }`.
3. Receive segment-wise speaker indices.
4. Apply confidence rule: relabel segments where all conditions hold to `others:N`, leave the rest bare `others`.
5. Merge with existing transcript, preserving user-pinned segments.
6. Return relabelled transcript.

### Storage

`Meeting.speaker_names: BTreeMap<String,String>` stores display name mappings:
```json
{
  "others:1": "Jean",
  "others:2": "Marie"
}
```

Old meetings have empty map by default (`#[serde(default)]`). Naming is additive — re-running detection never deletes entries.

### Re-Transcribe Interaction

When re-transcribing:
1. `speaker_names` is cleared (old labels no longer valid).
2. Old map is snapshotted to `transcript.previous.json` for archival.
3. UI warns: "Speaker names will be cleared. Continue?"

### Segment Pinning

Each segment holds an optional `speaker_pinned: bool` flag. Corrections set it to `true`. On subsequent diarization passes, `relabel_others` skips pinned segments.

User-pinned labels use namespace `others:m1`, `others:m2`, etc. Machine-emitted labels use pure-numeric sub-ids (`others:1`, `others:2`, etc.). No collision possible.

## Models and Licensing

**Models**: Downloaded via `./scripts/download-models.sh --only diarization`
- **pyannote-segmentation-3.0** (speaker activity detection): MIT (CNRS)
- **NeMo TitaNet-small** (speaker embeddings): Apache-2.0 (NVIDIA NeMo Toolkit)

Both bundled; no external API calls.

## Platform Notes

Speaker diarization is independent of platform — it operates on the raw audio file. The confidence rule, segment pinning, and name storage are identical across macOS, Windows, and Linux.

## References

- **ADR 0008**: [Dual-Track Audio Capture with Per-Source Speaker Attribution](0008-dual-track-audio-with-speaker-attribution.md) — the upstream attribution model.
- **ADR 0007**: [Core Audio Process Taps for macOS System Audio Capture](0007-core-audio-taps.md) — system audio capture backend.
- **ADR 0002**: Model weights licensing precedent (CC-BY-4.0, Apache-2.0, MIT compatibility).
- **sherpa-onnx OfflineSpeakerDiarization** — https://github.com/k2-fsa/sherpa-onnx (Apache-2.0, documentation and bindings).
- **Speaker struct** (Rust): Defined in `crates/myna-llm/src/domain/` with `role()`, `sub_id()`, and `is_well_formed()` accessors.
- **Storage**: `app/src-tauri/src/store/fs_store.rs` — meeting persistence with `speaker_names` map.
- **Transcript formatting**: Applies speaker labels in summaries and export.

## Revision History

- **2026-08-30**: Phase 7 decision finalized. Offline speaker diarization over `track-system.wav` implemented using sherpa-onnx `OfflineSpeakerDiarization` with pyannote-segmentation-3.0 + NeMo TitaNet-small embeddings. Manual "Detect speakers" trigger (not automatic). Confidence rule enforced: relabel only when `num_speakers >= 2`, segment duration >= 1.0 s, >= 70% single-speaker coverage. Per-segment `speaker_pinned` flag prevents silent overwrites. Display names in `Meeting.speaker_names: BTreeMap`, never embedded in labels. Models optional (~45 MiB), excluded from `all_present` gate; fetched via `--only diarization` flag. Measured RTF 0.0413, peak RSS delta ~300 MB. Licences verified: MIT (pyannote-segmentation-3.0) and Apache-2.0 (NeMo TitaNet). Open risk flagged: accuracy UNVERIFIED on real multi-party call audio (only tested on 54-second single-narrator mic test; video-call audio codec compression and gain control not represented in benchmark). **Required before shipping:** real two-or-more-participant call must be recorded and inspected end-to-end. Known failure modes: overlapping speech, short utterances, similar voices, late joiners, mixdown call audio.
- **2026-08-30 (rev.)**: Bundling clarified — fresh onboarding **Initialize** now includes diarization (~45 MB) when core is missing (`missing_artifacts` adds `Diarization` when `!all_present`); `all_present` remains core-only (parakeet && qwen && silero) so existing installs are not gated. Existing users fetch diarization on demand via **Download speaker models** CTA or `download-models.sh --only diarization`.
