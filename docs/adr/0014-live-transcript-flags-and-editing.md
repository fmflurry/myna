# ADR 0014: Live-Transcript Suspect Flags and Live Editing

**Status**: Decided
**Date**: 2026-09-07
**Builds on**: [ADR 0008: Dual-Track Audio Capture with Per-Source Speaker Attribution](0008-dual-track-audio-with-speaker-attribution.md) and [ADR 0011: Disk-Backed Session State for Reload and Crash Recovery](0011-session-resilience.md)
**Context**: During a live meeting the user reads the running transcript as it folds. Parakeet-TDT via sherpa-onnx occasionally emits visibly wrong finals — an utterance repeated verbatim, a seconds-long segment fused into one line, a near-silent span transcribed as words — and the user has no way to tell which lines to trust or to fix one before it reaches the summary. There was no per-segment quality signal and no correction path short of editing the transcript file by hand after the meeting.

## Decision

Flag possibly-wrong live finals with cheap deterministic heuristics, and let the user correct a live final in place while recording continues.

- **Heuristics, not model confidence.** Parakeet through sherpa-onnx exposes text, tokens, and timestamps only — no per-token confidence to threshold. So suspicion is computed from observable signal properties (repetition, duration, energy, timing, length), never from a score the engine does not provide.
- **`SuspectReason` (5 variants).** A final segment carries zero or more flags; each flag is advisory and never blocks display, journaling, or summarization:
  - `repetition` — the text repeats itself (looped decode).
  - `drift` — segment duration suggests VAD under-segmentation.
  - `lowEnergy` — near-silence transcribed as words.
  - `timingAnomaly` — timestamps inconsistent with the capture clock.
  - `degenerateLength` — pathologically short or empty decode.
- **Thresholds.** Fixed constants, chosen to mirror existing pipeline bounds rather than tuned per model:

  | Reason | Threshold | Source / justification |
  |---|---|---|
  | `repetition` | same normalized phrase repeated ≥ 3× within one segment | Matches the looped-decode failure mode observed in live runs |
  | `drift` | `seg_len > 5 s` | Mirrors `MAX_DECODE_CHUNK_SEC`; anything longer means the VAD did not cut where the decoder expects a cut |
  | `lowEnergy` | RMS below the VAD silence floor for the segment span | A span the VAD calls silence should not yield words |
  | `timingAnomaly` | `endSec <= startSec`, or segment extends past capture clock + tolerance | Violates the capture-clock ordering the journal and dedupe rely on |
  | `degenerateLength` | trimmed text empty or below the minimum word length | Guards the trim/empty path shared with the edit command |

- **Journal compatibility is additive.** The new `TranscriptSegment` fields (`suspect flags`, `original_text`) are `#[serde(default)]`, following the ADR 0008 `Speaker` precedent: old journals and old meetings load without migration, and new journals remain readable by older binaries that simply ignore the extra fields.
- **`edit_live_transcript_segment` semantics.** One IPC, one segment, while recording continues:
  - Unknown id returns `NotFound`, never `Busy` — a missing segment is a lookup failure, not contention with the decode worker.
  - Trim/empty guard: whitespace-only replacement text is rejected; the stored segment is never blanked by an edit.
  - First-edit-wins `original_text`: the pre-edit text is preserved on the first edit and never overwritten by later edits, so the audit trail survives repeated corrections.
  - Editing clears suspect flags: a human-corrected segment is by definition no longer suspect.
  - Persisted with the ADR 0011 tmp+rename pattern (mode 0600) and re-emitted as `TRANSCRIPT_FINAL` so the UI updates through the existing event path.
  - The `(startSec, endSec, speaker)` dedupe triple is immutable — an edit may change text but never the identity the dedupe and journal fold rely on.
- **UI: badge + edit affordance.** A flagged live line shows a suspect badge; every live final is editable (`editableLive`), and a corrected line shows an Edited chip. The facade applies the edit optimistically and rolls back on IPC failure, so typing never blocks on the core.
- **Summarization reads the edited text.** Summaries render from the current (possibly edited) segment text. The mid-recording "stale summary" warning stays vacuous by design: it cannot know about edits the user has not made yet, so it never claims freshness it cannot verify.

## Rationale

### Why heuristics instead of model confidence?

The preferred signal — "the model is unsure, so flag it" — does not exist on this stack. sherpa-onnx's transducer output for Parakeet is decoded text plus tokens and timestamps; there is no calibrated confidence channel to threshold. Waiting for one means either forking the runtime or swapping model families, both disproportionate to the problem. The observable failure modes (repetition loops, over-long fused segments, words from silence, impossible timestamps, empty decodes) are each detectable from properties we already have, with zero inference cost and fully deterministic tests.

### Why these five reasons and these thresholds?

Each variant maps to one failure mode actually seen in live runs, not to a taxonomy of everything that could go wrong. The `5 s` drift bound is deliberately not tuned: it mirrors `MAX_DECODE_CHUNK_SEC`, the chunk size the decoder already assumes, so a segment longer than a decode chunk is suspicious by construction. Tying the threshold to an existing pipeline constant keeps the two from drifting apart silently. The remaining thresholds are guards at the boundary of sense (empty, unordered, silent) rather than statistical cutoffs — they fire rarely and mean something concrete when they do.

### Why additive serde defaults for the journal?

ADR 0011 made `transcript-journal.jsonl` the durable unit of live transcription and ADR 0008 established the `#[serde(default)]` precedent for evolving per-segment schema without migrations. Suspect flags and edit history ride on that precedent: a journal written before this feature loads with no flags and no original text, and the tolerant trailing-line reader is untouched. No migration script, no version bump, no recovery-path change.

### Why NotFound-not-Busy, first-edit-wins, and clear-on-edit?

`Busy` would tell the UI to retry; but an unknown segment id is never transient — the segment was never journaled or was already finalized into `meeting.json`. `NotFound` tells the truth and the UI surfaces it once. `original_text` is first-edit-wins because the audit question is "what did the engine actually say?", and the second edit's "before" is just the first edit's "after" — overwriting it destroys the only record of the model output. Clearing flags on edit follows from what the flags mean: they mark *engine output* as suspect, and once a human has replaced the text the engine output is gone.

### Why immutable dedupe triple?

The `(startSec, endSec, speaker)` triple is the identity used by the ADR 0011 re-attach dedupe and by the journal fold at stop/recovery. If an edit could change timing or speaker, the edited segment would dedupe as a different segment — duplicating on reload and forking the journal. Text is content; the triple is identity. Edits touch content only.

## Options Considered

### Download a model (or sidecar) that emits confidence scores

- **Pros**: A calibrated score would subsume all five heuristics with one threshold.
- **Cons**: A new multi-hundred-MB download contradicts the local-first footprint the user already paid for; every supported language needs the new artifact; the whole VAD/decode pipeline must be re-validated for a signal that may still be poorly calibrated on transducer outputs.
- **Rejected**: Heuristics cover the observed failure modes at zero download and zero inference cost.

### Send audio or text to a cloud service for verification / correction

- **Pros**: Best raw accuracy; trivial to integrate.
- **Cons**: Violates the product promise stated in every stack doc — fully local, no data sent to the cloud. Also adds latency and a network dependency to the live path.
- **Rejected**: Non-negotiable; the fully-local constraint rules out cloud verification.

### Block the UI on suspect segments until the user confirms

- **Pros**: Guarantees no suspect line ever reaches a summary unreviewed.
- **Cons**: Turns an advisory signal into a mid-meeting interruption; the user is in a meeting, not a review queue. Also couples the decode worker to UI responsiveness, recreating the callback-blocking failure mode from the hard-won lessons.
- **Rejected**: Flags are badges, not gates. The meeting continues; the user corrects when they choose.

## Consequences

### Positive

- Suspect live lines are visible at a glance (badge) instead of silently trusted.
- A wrong final can be fixed in seconds, mid-meeting, and the fix flows into the journal, the re-emitted event, recovery, and the summary.
- No migration: old journals/meetings load; old binaries read new journals (ignoring new fields).
- No new downloads, no network, no inference-cost change.

### Negative

- Heuristics can misfire (a genuinely repeated phrase, a long deliberate utterance) — mitigated by making flags advisory-only and clearing them on edit.
- Each in-progress meeting journal now carries slightly wider lines (flags + optional original text); bounded at ~1 line per utterance, same as ADR 0011.
- `original_text` retains engine output the user may consider wrong — kept deliberately as the audit trail; surfaced only where the UI chooses to show edit history.

## Implementation Notes

- **Heuristics**: `suspect.rs` — pure functions over segment text, duration, energy, and timestamps; no model access, deterministic unit tests per variant.
- **Segment fields**: `TranscriptSegment` gains additive `#[serde(default)]` fields for flags and `original_text`; journal DTO extended the same way so `transcript-journal.jsonl` lines round-trip.
- **Command**: `edit_live_transcript_segment` — lookup → `NotFound` on unknown id → trim/empty guard → stamp first-edit-wins `original_text` → replace text → clear flags → tmp+rename write (0600) → re-emit `TRANSCRIPT_FINAL`.
- **UI**: domain/mapper/port/adapter carry the new fields; `LiveTranscript` component renders badge + edit control + Edited chip; facade/store apply optimistic update with rollback on IPC error; shell wiring threads the port through the existing live-transcript path.
- **Summarization**: verified edited-based — templates receive the current segment text; the mid-recording stale indicator is unchanged (vacuous by design).

## Open Risks

**Heuristic thresholds are fixed, not adaptive.** A speaker who legitimately repeats a phrase or speaks in > 5 s unbroken spans will collect flags. Accepted because flags are advisory and one edit clears them; revisit only with measured false-positive data from real meetings, not synthetic transcripts.

**No conflict handling between concurrent edits and finals.** An edit racing a journal fold targets the same segment id; the triple-immutable rule keeps identity stable, but last-writer-wins applies to text. Accepted: the window is one utterance wide and the user sees the result immediately.

## References

- **ADR 0008**: [Dual-Track Audio Capture with Per-Source Speaker Attribution](0008-dual-track-audio-with-speaker-attribution.md) — speaker labels, `#[serde(default)]` schema-evolution precedent, transcript attribution format.
- **ADR 0011**: [Disk-Backed Session State for Reload and Crash Recovery](0011-session-resilience.md) — `session.json` manifest invariant, `transcript-journal.jsonl` (finals only, tolerant reader), tmp+rename 0600 writes, `(startSec, endSec, speaker)` dedupe, boot-time re-attach.
- **Decode bound**: `MAX_DECODE_CHUNK_SEC` — the chunk duration the `5 s` drift threshold mirrors.
- **Events**: `TRANSCRIPT_FINAL` — the existing final-segment event reused for edit re-emit.

## Revision History

- **2026-09-07**: Decision finalized. Heuristics-over-confidence (no confidence channel in sherpa-onnx Parakeet output), five `SuspectReason` variants with fixed thresholds, additive serde-compatible journal fields, `edit_live_transcript_segment` semantics (NotFound, trim/empty guard, first-edit-wins, clear-on-edit, tmp+rename 0600, re-emit, immutable dedupe triple), UI badge + editableLive + Edited chip, edited-based summarization. Rejected: new confidence-model download, cloud verification, blocking UI.
