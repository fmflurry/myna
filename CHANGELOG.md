# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-09-01

### Added

- **Local speech-to-text** — transcribe offline via Parakeet-TDT v3
  (ONNX, 25 European languages).
- **Local LLM summarization** — generate summaries with
  Qwen2.5-3B-Instruct (GGUF via embedded llama.cpp); no cloud
  service required.
- **Dual-track audio capture** — record microphone and system
  audio separately (macOS 14.4+), with speaker attribution for
  user vs. remote participants.
- **Graceful audio fallback** — older macOS versions automatically
  fall back to microphone-only capture.
- **Transcript editing** — fix transcription errors by editing
  segments directly in the transcript view.
- **Speaker management** — rename and manage speaker labels in
  transcripts and summaries.
- **Meeting library** — browse, search, rename, and delete past
  recordings; view transcripts and summaries.
- **Template-driven summaries** — four built-in templates (Key
  Points, Action Items, Meeting Notes, Decisions) plus
  user-extensible JSON templates.
- **Multi-language summaries** — generate summaries in your choice
  of language (same AI model handles translation).
- **In-app model download** — fetch Parakeet-TDT, Qwen2.5, and
  Silero VAD with live progress and cancel support (~2.6 GB, one
  time).
- **Tauri 2 desktop shell** — native macOS webview, Rust backend,
  small binary, no JavaScript/Electron overhead.
- **100% local, zero cloud** — transcripts, summaries, and
  recordings live only on your disk (`~/myna/`); no telemetry, no
  data collection.
- **MIT-licensed** — fully open-source; read and modify the code.

### Known Limitations

- **Unsigned build** — v0.1.0 is ad-hoc signed but not notarized
  by Apple (Developer ID pending). macOS will quarantine the app
  on first download. Users must run
  `xattr -dr com.apple.quarantine /Applications/Myna.app` to allow
  execution. See README for details.
- **Opt-in update checks, no auto-install** — v0.1.0 includes optional update checks
  (off by default; once per 24 h if enabled). Myna notifies you when a new version
  exists but never downloads or installs updates automatically. This is because
  the ad-hoc signing changes code identity per release, which revokes macOS
  microphone permissions. Once Developer ID certificate is obtained, auto-install
  can be revisited.
- **macOS 14.4+ only** — system audio capture (dual-track and
  mixed modes) requires macOS 14.4 or newer. Older versions fall
  back to microphone-only recording.
- **Code identity changes per release** — because builds are
  ad-hoc signed, the code-identity changes with each release.
  macOS will re-prompt for microphone permission after each
  update.
- **Windows & Linux unverified** — Tauri 2 and the codebase
  support cross-platform builds, but only macOS has been tested.
  Windows and Linux builds are not recommended for production use
  yet.
