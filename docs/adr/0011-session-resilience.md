# ADR 0011: Disk-Backed Session State for Reload and Crash Recovery

**Status**: Decided (Phase 8)  
**Date**: 2026-09-02  
**Builds on**: [ADR 0003: Filesystem JSON Storage over SQLite](0003-meeting-storage.md) and [ADR 0008: Dual-Track Audio Capture with Per-Source Speaker Attribution](0008-dual-track-audio-with-speaker-attribution.md)  
**Context**: During a live meeting, if the webview reloads or the app is killed, the Rust core's capture worker keeps writing WAVs but the UI loses all recording state: no Stop button, 0-min duration, "Playback error", "No transcript available". The meeting is silently half-lost from the user's point of view while the disk keeps filling. Root cause: session state lived only in a `Mutex<Option<RecordingSession>>` (app/src-tauri/src/state.rs:100), live transcript finals existed only in the decode worker's memory and were persisted only at stop, and the UI derived recording state only from fire-and-forget Tauri events (`recording://state`, `transcript://final`) with no boot-time query.

## Decision

Persist the two facts a session must survive on — *is a recording in progress* and *what has been transcribed so far* — to disk, and make the UI re-derive its state from them at boot instead of trusting events it may have missed.

- **`session.json` manifest** — written atomically (tmp+rename, mode 0600) into `~/myna/meetings/{id}/` at recording start, carrying the **effective** source (after any system-audio fallback), deleted at stop/cancel. Invariant: **manifest existence == recording in progress**. No state-field churn to keep in sync with the file. Across processes, any surviving manifest is an orphan, because startup recovery runs before any session can exist in the new process — the ordering makes the invariant self-enforcing.
- **`transcript-journal.jsonl`** — append-only, one `TranscriptSegment` per line, written by the **decode worker** (never the realtime audio callback) as each final segment folds. A tolerant reader drops a truncated trailing line. Partials are **not** journaled: they are provisional hypotheses superseded by finals; missed partials are unrecoverable **by design**; finals are never lost.
- **Re-attach (same-process reload)** — `recording_state` IPC gains `elapsedSec`; a new `get_live_transcript` IPC replays journaled finals. The UI on boot queries both and seeds its state from the answers. Dedupe by `(startSec, endSec, speaker)` covers the race where the event subscription delivers a final before the journal read returns.
- **Orphan recovery (killed process)** — a startup scan repairs un-finalized WAV headers (hound writes a 0-data placeholder patched only at finalize — `repair_wav_sizes` patches the RIFF/data sizes from file length), folds the journal into `meeting.json`, computes duration = max(wav duration, last segment end), then deletes manifest + journal. Per-meeting failures are logged and skipped — recovery never blocks startup. The stop path falls back to journal-based finalization when the worker died, instead of erroring out and losing the meeting.
- **Known limitation** — no single-instance guard; two Myna instances could fight over capture, and recovery treats any found manifest as orphaned. Accepted for now (see Open Risks).

## Rationale

### Why a manifest file instead of a state field?

A `Mutex<Option<...>>` is invisible to a new process and to a reloaded webview. The question recovery must answer — "was a recording in progress when we died?" — is exactly the question file existence answers, with no schema, no versioning, and no sync bug between memory and disk. Making *existence itself* the flag removes the failure mode where a state field and a file disagree. The ordering guarantee (startup recovery runs before any session can exist in the new process) means "manifest present" can only mean "left over from a dead process" — no timestamps, no heartbeats, no liveness checks needed.

### Why does the decode worker write the journal, not the audio callback?

Hard-won lesson (see CLAUDE.md): the realtime callback has a ~20 ms deadline and must not do heavy work — a decode run inline there once discarded 97% of captured audio. A journal append is a file write with unknown latency (buffer flush, disk pressure). The decode worker is the single owner of final-segment ordering anyway, so it is the only correct place to serialize finals to disk. The callback's job remains: write WAVs, compute level, hand off samples.

### Why journal finals only, and not partials?

A partial is a provisional hypothesis the model will supersede within the same utterance; replaying one after a reload would render text the engine itself no longer believes. It is also unbounded: partials fire many times per second, finals once per utterance. The value the user loses on a kill is the in-flight utterance's partial display — recoverable from the audio by re-transcription if ever needed. Finals are the durable unit; they are never lost.

### Why a tolerant reader that drops the trailing line?

`kill -9` can land mid-append, leaving a line that is valid JSON up to a truncation point. A strict parser would reject the whole journal and lose every good segment to one bad byte at the tail. Dropping only the unparseable trailing line bounds the damage to the single segment being written at death time.

### Why boot-time query + dedupe instead of replaying events?

Tauri events are fire-and-forget: a webview that reloads has, by definition, missed everything emitted before it re-subscribed. Replaying events from the core would require the core to remember every subscriber's position — a queue per client, unbounded in the worst case. A pull query (`recording_state`, `get_live_transcript`) is stateless on both sides. The dedupe on `(startSec, endSec, speaker)` handles the only race the pull model creates: a live `transcript://final` arriving between the query and the seed, so the same segment briefly exists in both sources.

### Why duration = max(wav duration, last segment end)?

After a kill, neither number alone is trustworthy. The WAV header was never finalized, so its declared duration reads 0 until repaired from file length — and the repair can only measure what reached disk. Segment ends are stamped against the capture clock and can slightly exceed the repaired WAV extent. The max is the honest upper bound of what was actually captured; underestimating would silently shorten the meeting.

## Options Considered

### Poll a persisted state field over IPC (no manifest)
- **Pros**: No filesystem changes; the live process already has the mutex.
- **Cons**: Useless across process death — the whole failure mode is a new process asking an old one's memory. Still needs a boot-time IPC surface.
- **Rejected**: The manifest is the state field, placed where a dead process's successor can read it.

### Re-transcribe `audio.wav` on recovery instead of journaling
- **Pros**: Zero new files; audio is the lossless source of truth.
- **Cons**: Costs minutes of decode per recovered meeting at startup — violating "never block startup" — and re-runs STT on every crash.
- **Rejected**: The journal makes recovery O(lines) instead of O(meeting). `audio.wav` stays as the fallback when the journal itself is missing or corrupt.

### SQLite / WAL for live session state
- **Pros**: Atomic appends and crash-consistent reads for free.
- **Cons**: Contradicts ADR 0003's filesystem-JSON choice for per-meeting data; a second storage engine just for transient state.
- **Rejected**: Two flat files per in-progress meeting dir are sufficient and inspectable; JSONL's crash semantics are handled by the tolerant reader.

### Keep events-only UI state, add a "reconnect" affordance
- **Pros**: Cheapest fix; no core changes.
- **Cons**: Puts recovery labor on the user mid-meeting, and the misleading symptoms (0-min duration, "Playback error") persist until they click.
- **Rejected**: A reload is routine (devtools, webview crash); the app must re-derive state automatically.

## Consequences

### Positive
- A webview reload mid-recording restores the Stop button, the elapsed timer, and the transcript already spoken.
- `kill -9` (or a crash) recovers a playable meeting: WAV headers repaired, journal folded into `meeting.json`, duration computed from what actually reached disk.
- The stop path no longer loses a meeting when the worker thread has died — it finalizes from the journal instead of erroring out.
- The invariant is cheap to reason about and to test: manifest present ⇒ recover; manifest absent ⇒ nothing to do.
- `audio.wav` remains the lossless fallback if journal writes fail entirely.

### Negative
- Every in-progress meeting directory now contains two extra files (`session.json`, `transcript-journal.jsonl`) that must be cleaned up on every exit path (stop, cancel, worker death, orphan recovery).
- One journal append per final segment adds disk I/O to the decode worker (bounded: ~1 line per utterance).
- Without a single-instance guard, a second Myna instance's recovery scan can delete a manifest belonging to a live first instance (see Open Risks).

## Implementation Notes

- **Manifest**: `~/myna/meetings/{id}/session.json` — meeting id, effective `source` (post-fallback), started-at. Written with the tmp+rename pattern from ADR 0003; mode 0600 inside the 0700 data root, matching the `preferences.json` precedent in ADR 0010.
- **Journal**: `~/myna/meetings/{id}/transcript-journal.jsonl` — one serde-serialized `TranscriptSegment` per line, appended by the decode worker as each final folds (crates/myna-audio/src/recorder.rs:108 finalizes the WAVs on the same worker's shutdown path).
- **Header repair**: `repair_wav_sizes` computes RIFF size (file length − 8) and data-chunk size (file length − header) from the file's actual length; hound's `WavWriter::finalize` (crates/myna-audio/src/recorder.rs:108) is the only normal writer of those fields, so a kill always leaves the 0-data placeholder.
- **Re-attach IPC**: `recording_state` (app/src-tauri/src/commands/recording.rs:262) gains `elapsedSec` on the existing camelCase payload (app/src-tauri/src/events.rs); new `get_live_transcript` returns journaled finals. The UI seeds from both on boot, then continues on live events with `(startSec, endSec, speaker)` dedupe.
- **Recovery order**: the startup scan runs in the Tauri setup hook (app/src-tauri/src/lib.rs), before any command can create a session — that ordering is part of the invariant, not an optimization.

## Open Risks

**No single-instance guard.** Two Myna processes can both attempt capture and both scan for orphans; recovery treats any manifest it finds as orphaned. A lockfile (or Tauri single-instance plugin) would close this; deferred because multi-instance launch is rare and the failure is visible (double capture), unlike the silent loss this ADR fixes.

**WAV repair is bounded by the 4 GiB RIFF size field.** The canonical 32-bit RIFF size cannot express more than 4 GiB, so an `audio.wav` larger than that (~11.6 h at 48 kHz stereo) cannot be repaired; recovery logs and skips it, and the meeting still recovers with its journaled transcript.

**Pre-feature sessions have no manifest or journal.** Meetings recorded before this feature lack `session.json` and a journal, so startup recovery additionally runs a legacy pass that repairs un-finalized WAVs for meetings whose `meeting.json` still shows duration 0 with no transcript. Their live transcript finals, held only in memory at crash time, are unrecoverable — re-transcribing from the audio recovers the text.

## Testing

- Unit: tolerant journal reader (valid lines survive a truncated tail); `repair_wav_sizes` against synthetic WAVs with placeholder headers; duration = max(wav, last segment end).
- Integration: manifest lifecycle (created at start with effective source, deleted at stop/cancel); orphan scan recovers a meeting from manifest + journal and never blocks startup on a per-meeting failure.
- Manual (the user's acceptance test): reload the webview mid-recording → Stop + timer + transcript restore; `kill -9` mid-recording → relaunch → meeting is playable with a transcript.

## References

- **Session state**: `app/src-tauri/src/state.rs:100` — the `Mutex<Option<RecordingSession>>` that motivated this ADR.
- **Session machine**: `app/src-tauri/src/session.rs` — capture + decode workers, `elapsed_sec()`.
- **State query**: `app/src-tauri/src/commands/recording.rs:262` — `recording_state`.
- **Events**: `app/src-tauri/src/events.rs` — `recording://state`, `transcript://final` (fire-and-forget).
- **WAV writer**: `crates/myna-audio/src/recorder.rs` — hound `WavWriter`, `finalize()`.
- **ADR 0003**: atomic tmp+rename writes and the per-meeting directory layout.
- **ADR 0008**: dual-track files and speaker labels carried by journaled segments.

## Revision History

- **2026-09-02**: Phase 8 decision finalized. Manifest-existence invariant (`session.json`, mode 0600, effective source), decode-worker-owned `transcript-journal.jsonl` (finals only, tolerant reader), boot-time re-attach via `recording_state.elapsedSec` + `get_live_transcript` with `(startSec, endSec, speaker)` dedupe, and startup orphan recovery (`repair_wav_sizes`, journal fold into `meeting.json`, duration = max(wav, last segment end), failures logged and skipped). Known limitation accepted: no single-instance guard.
