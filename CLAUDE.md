# CLAUDE.md

## Project context

Myna is a **local-first AI meeting recorder/summarizer**: capture meeting audio, get live transcripts, review key points, and remember takeaways.

- **STT**: Parakeet-TDT (ONNX) via sherpa-onnx, with VAD-segmented simulated streaming.
- **Summarization**: Qwen2.5-Instruct (GGUF) via llama.cpp, templated.
- **Fully local**: STT and summaries run on-device; **no data is sent to the cloud**.
- **License**: MIT.
- **Targets**: macOS-first; Windows/Linux planned and untested — do not claim support.

## Stack & architecture

Authoritative source: [docs/stack-proposal.md](docs/stack-proposal.md) — do not re-derive. Summary:

- **sherpa-onnx** — Parakeet-TDT STT runtime (Apache-2.0; weights CC-BY-4.0).
- **llama.cpp** — embedded in-process for Qwen (MIT); no background service.
- **cpal** — audio capture across macOS/Windows/Linux.
- **Tauri 2** — shell with Rust core + system webview.
- **Hugging Face Hub** (`hf`) — model downloads.
- **JSON templates** — declarative summarization prompts; built-ins: `key-points`, `action-items`, `meeting-notes`, `decisions`.

## Repository layout

```
myna/
├── app/          # Tauri 2 shell: Rust core + window/webview wiring
├── crates/       # Rust workspace: myna-audio, myna-stt, myna-llm
├── ui/           # Webview frontend sources
├── templates/    # JSON summary templates (built-ins + user extensions)
├── models/       # Downloaded Parakeet + Qwen GGUF (gitignored)
├── scripts/      # download-models.sh + dev helpers
├── docs/         # Stack proposal, ADRs, usage docs
├── tests/        # Cross-crate integration / E2E tests
└── data/         # Machine-local runtime data (gitignored)
```

## Commands

**Model download** (use `./scripts/download-models.sh` for idempotent fetch of all three artifacts; manual commands below for reference):

```bash
# Parakeet-TDT v3 (ONNX, int8) — 25 European languages
# Artifacts: encoder.int8.onnx, decoder.int8.onnx, joiner.int8.onnx, tokens.txt
hf download csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8 \
  --local-dir models/parakeet-tdt-0.6b-v3-int8

# Silero VAD (ONNX) — voice activity detection for simulated streaming
wget https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx \
  -O models/silero-vad/silero_vad.onnx

# Qwen2.5 Instruct GGUF (Q4_K_M, ~1.9 GB) — official Qwen repo
hf download Qwen/Qwen2.5-3B-Instruct-GGUF \
  --include "qwen2.5-3b-instruct-q4_k_m.gguf" \
  --local-dir models/qwen2.5-3b-instruct
```

**Run STT** (sherpa-onnx, VAD simulated streaming):

```bash
# Offline transcription of a recording
cargo run -p myna-stt -- --model models/parakeet-tdt-0.6b-v3-int8 --input recordings/meeting.wav

# Live mic transcription (silero-vad segmentation, emits partial results)
cargo run -p myna-stt -- --model models/parakeet-tdt-0.6b-v3-int8 --vad-model models/silero-vad/silero_vad.onnx --stream --input mic
```

**Run LLM** (llama.cpp, embedded — no background service):

```bash
# One-shot summarization from a template
cargo run -p myna-llm -- summarize \
  --model models/qwen2.5-3b-instruct/qwen2.5-3b-instruct-q4_k_m.gguf \
  --template templates/key-points.json \
  --transcript recordings/meeting.txt

# Dev-only: llama-server for interactive prompt testing
llama-server -m models/qwen2.5-3b-instruct/qwen2.5-3b-instruct-q4_k_m.gguf -c 32768 --port 8080
```

## Capture Sources

Myna supports three recording modes (set via `start_recording { "source": "..." }`):
- `"mic"` — microphone only.
- `"system"` — system audio only (macOS 14.4+; silently degrades to mic on unsupported versions).
- `"mixed"` — microphone + system audio as separate 16 kHz mono tracks with speaker attribution (macOS 14.4+; degrades to mic if permission denied).

The `source` parameter is optional; default is `"mic"`.

Each meeting produces up to three audio files (stored in `~/myna/meetings/{id}/`):
- **`audio.wav`** — device-native stereo format (typically 48 kHz, ~920 MB/h), listenable and exportable to other meeting tools.
- **`track-mic.wav`** — 16 kHz mono, retained permanently for STT and future speaker diarization; absent if only system audio was captured.
- **`track-system.wav`** — 16 kHz mono, retained permanently for STT and future speaker diarization; absent if only microphone was captured.

Transcription format: the synthesized transcript uses speaker labels (`"Me"` for the user, `"Others"` for remote participants, no label for unknown). These are preserved in summaries and notes (see [ADR 0008](docs/adr/0008-dual-track-audio-with-speaker-attribution.md)). Re-transcription of old meetings (pre-Phase-6) falls back to `audio.wav` if track files are missing, stamped as unknown source.

System audio capture uses **Core Audio process taps** (see [ADR 0007](docs/adr/0007-core-audio-taps.md)) and requires `kTCCServiceAudioCapture` permission. Live audio tests are gated by `MYNA_LIVE_AUDIO_TESTS` and must run serially (`--test-threads=1`).

## Conventions

- **`models/`** is gitignored — downloaded artifacts (`.gguf`, `.onnx`) are never committed; fetched once via `./scripts/download-models.sh` and stored locally.
- **`templates/`** is user-extensible JSON — same files drive both the CLI and the GUI; add new summary types without recompiling.
- **`data/`** is machine-local runtime data (gitignored) — never commit recordings, transcripts, or caches.
- **`~/myna`** is the data root (recordings, transcripts, summaries). Override with `MYNA_DATA_DIR` environment variable. Note: the directory is **not** `~/.myna` (no dot prefix).

## Verification

Run these commands to verify the build:

```bash
# Ensure Rust is on the path (cargo is not in the non-interactive shell PATH by default)
export PATH="$HOME/.cargo/bin:$PATH"

# Format and lint
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings

# Build and test
cargo build --workspace --locked
cargo test --workspace --locked

# Integration tests (requires models downloaded via ./scripts/download-models.sh)
cargo test --workspace --release --locked -- --ignored
```

**UI verification** (Angular with Vitest):

```bash
cd ui && npm run lint && npx tsc -p tsconfig.json --noEmit && npm run build && npm test -- --watch=false
```

**App verification** (Tauri):

```bash
npx tauri info && npx tauri dev && npx tauri build --no-bundle
```

**Important**: The `huggingface-cli` is deprecated and no longer works. Always use the `hf` command (from `huggingface_hub` Python package) for model downloads. Verify installation with `hf --version`.

## Hard-Won Lessons

### Verification: a green build is not proof

- **Verify the packaged artefact, not just the dev build.** `npx tauri dev` and the bundled `Myna.app` differ in ways that break the app. Two real bugs shipped this way: (a) Angular's production critical-CSS inlining rewrote the stylesheet `<link>` with an inline `onload` handler, which the Tauri CSP blocks, so the packaged app rendered with zero CSS while dev looked perfect; (b) model/template paths resolve repo-relative in dev but to the bundle resource dir in release, so the packaged app reported every model missing.
- **"Process is alive" ≠ "UI rendered."** A launched app that shows a black window still passes a `pgrep` check. Dump the DOM or inspect the built assets before declaring victory.
- **Beware stale build artefacts.** A `tauri build` "succeeded" once only because `target/release/myna` was cached; the broken link step never ran. Delete the binary (or force a relink) before trusting a release build.
- **Prove fixes at the layer they broke.** Prefer a test that fails before the fix. Regression tests that pass both before and after are worthless—verify the pre-fix failure and say so.
- **Green unit tests can hide DI wiring bugs.** 130 specs passed while the app rendered a blank screen, because every spec hand-wired its providers via `TestBed` and nothing exercised the real injector graph. Keep the routed integration spec that boots the real `app.routes` + `provideMeetings()`.
- **"Recording works live" ≠ "session survives reload."** Session state lived only in a `Mutex<Option<RecordingSession>>` (app/src-tauri/src/state.rs:100) and the UI derived it solely from fire-and-forget events, so a webview reload or kill mid-meeting left WAVs writing with no Stop button, 0-min duration, and "No transcript available" — a happy-path test never caught it. In-memory-only state + event-only UI state is unrecoverable by construction; the fix ([ADR 0011](docs/adr/0011-session-resilience.md)) is the invariant *manifest existence == recording in progress* (`session.json`, atomic 0600), finals journaled to `transcript-journal.jsonl` by the decode worker, and state re-derived at boot (query + startup recovery, not event replay).

### Angular / UI specifics for this repo

- Test runner is `@angular/build:unit-test` with **Vitest on jsdom** (Karma removed—no usable Chrome on this machine). **`vi.mock()` hoisting does not work**, and Angular's `fakeAsync`/`tick` fail with "Expected to be running in 'ProxyZone'". Use `TestBed` providers plus `vi.useFakeTimers()` / `vi.advanceTimersByTime()`.
- Stub the Tauri boundary with `infrastructure/tauri/testing/tauri-internals.stub.ts` (stubs `window.__TAURI_INTERNALS__`), not by mocking modules.
- **Never put `providedIn: 'root'` on `MeetingsStore` or `MeetingsFacade`.** They resolve ports bound at the lazy *route* injector; root scope can't see those and the whole app renders blank with `NG0201`.
- Only two files may import Tauri packages: `infrastructure/tauri/ipc.ts` (`@tauri-apps/api`) and `infrastructure/tauri/tauri-file-dialog.adapter.ts` (`@tauri-apps/plugin-dialog`). Keeps the Tauri boundary isolated. The updater plugin is registered **Rust-side only** (app/src-tauri/src/lib.rs:38) and the webview has no reachable path to it (no updater entry in `capabilities/default.json`), so even webview compromise cannot trigger update checks.
- Verify the import allowlist is enforced: `cargo test --test ui_tauri_import_allowlist`.
- Known quirk: a class field bound to a constant *imported from another module* rendered as `undefined` in templates; a method returning it works.
- The only working headless browser here is `~/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`. Other Chrome/Chromium installs hang or SIGTRAP.

### Audio / STT lessons

- **Never do heavy work in the audio callback.** Running STT decode inline in the CoreAudio callback blew the ~20 ms deadline (p50 707 ms, 35× realtime) and discarded ~97% of captured microphone audio—which presented as "the model is inaccurate". Decode on a worker thread behind a bounded, non-blocking channel; the callback now costs ~30 µs. A regression test guards this.
- **Diagnose before swapping models or APIs.** int8 vs fp32 measured 2.10% vs 1.94% WER—the model was never the problem. The VAD-segmented pipeline scores EN 1.27% / FR 1.85% once it actually receives the audio. Similarly, the ScreenCaptureKit-to-Core Audio migration was preceded by a spike that proved the approach worked on hardware before committing production effort.
- **Parakeet has no language parameter** (`OfflineTransducerModelConfig` is encoder/decoder/joiner only). Language pinning requires a different model family—Canary exposes `src_lang`/`tgt_lang`.
- Sherpa returns subword tokens where the word-boundary marker may arrive as a **plain leading space**, not `▁`. Assuming only `▁` collapsed every decode into one pseudo-word—invisible because embedded spaces still read correctly.
- Set VAD `min_silence` ≈ 0.5 s; 0.25 s splits sentences at ordinary mid-sentence pauses and each split costs a word plus capitalisation.
- Throttles must stamp their timestamp **after** the work, not before, or the cap never binds (this produced 40 decodes/sec against an intended 5).

### Environment / build

- **`cargo` is not on the non-interactive PATH.** Prefix every invocation with `export PATH="$HOME/.cargo/bin:$PATH"; `. Prevents "cargo: command not found" in non-login shells.
- `unsafe_code = "forbid"` is workspace-wide and has never needed an override—keep it that way; the chosen crates all expose safe APIs.
- Models live at `~/myna/models` (data root `~/myna`, `MYNA_DATA_DIR` / `MYNA_MODELS_DIR` overrides). Templates are bundled into the app as Tauri resources.
- Self-host fonts; never `@import` from a CDN. The CSP is `default-src 'self'` and the product promise is fully local.

### Working with the user

- The user's acceptance test is **using the app in a real meeting**, not a green pipeline. A feature that passes tests but breaks a real meeting is a failure.
- When they say the UI is bad, ask what they want before rebuilding—there was no UI spec in their history, and guessing twice wasted a full cycle.
- Don't fabricate data in the UI. Showing a speaker count or detected language we don't actually have is worse than omitting the field.
