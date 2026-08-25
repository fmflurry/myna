# Myna — Stack Proposal

> **Status**: Proposed · **Product**: Local-first AI meeting recorder/summarizer · **License**: MIT · **Targets**: macOS-first, Windows/Linux supported
>
> Eight decision areas, the Phase 2 repository layout, and the Phase 3 commands. No code, configs, or manifests are created by this document.

## 1. STT Model Runtime

- **Recommended**: **sherpa-onnx** (k2-fsa) running NVIDIA Parakeet-TDT ONNX models.
- **Rationale**: sherpa-onnx is the de-facto runtime for Parakeet-TDT in ONNX form: the project ships converted INT8 artifacts (e.g. `sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8`, plus a `v3` for 25 European languages), a Rust crate, C/C++ API, and prebuilt binaries for macOS/Windows/Linux. Inference is CPU-friendly via ONNX Runtime and runs fully offline. Licensed Apache-2.0 with model weights CC-BY-4.0 — permissive and compatible with an MIT app (attribution required). whisper.cpp cannot run Parakeet at all, so sherpa-onnx is the only serious option for the mandated model family.
- **Rejected alternatives**:
  - **whisper.cpp** — Whisper-family only; no Parakeet/NeMo transducer support; would force a model-family change.
  - **llama.cpp whisper support** — experimental, non-first-class STT, and still Whisper-only.

## 2. LLM Runtime for Qwen

- **Recommended**: **llama.cpp embedded in-process** (Rust `llama-cpp` bindings; `llama-server`/`llama-cli` for dev only) — no background service.
- **Rationale**: llama.cpp is the reference runtime for Qwen2.5 GGUF (the Qwen org publishes official GGUF repos and documents llama.cpp usage), with mature Q4_K_M quantization (~1.9 GB for 3B), Metal/CUDA backends, and the `qwen2.5` chat template built in. Embedding it keeps Myna a single local-first app with no daemon to install, start, or supervise — important for a recorder that must just work on launch. MIT-licensed.
- **Rejected alternatives**:
  - **Ollama** — easier CLI and model management, but adds a persistent background service and complicates in-process embedding; kept as fallback.
  - **Cloud LLM APIs** — violate the fully-local constraint.

## 3. Audio Capture

- **Recommended**: **cpal** (Rust).
- **Rationale**: cpal exposes one API across CoreAudio (macOS), WASAPI (Windows), and ALSA/PulseAudio (Linux) — exactly the target matrix — with low-latency stream callbacks that feed STT directly from the Rust core. It avoids webview permission prompts and keeps capture in the same process as the recognizer. Dual MIT/Apache-2.0.
- **Rejected alternatives**:
  - **Web Audio (getUserMedia) in the webview** — fallback only; permission UX and capture quirks make it unsuitable as primary.
  - **Native per-OS capture** (AVFoundation / WASAPI / ALSA) — three codebases to own for no benefit.

## 4. GUI Framework

- **Recommended**: **Tauri 2**.
- **Rationale**: Tauri 2's Rust core + system webview (WKWebView / WebView2 / WebKitGTK) yields a small binary, is macOS-first while supporting Windows and Linux, and sits naturally next to the all-Rust/C stack (cpal, sherpa-onnx, llama.cpp) via the command/IPC bridge. v2 stabilized multi-window and webview management. MIT/Apache-2.0 dual-licensed.
- **Rejected alternatives**:
  - **Electron** — mature but ships a full Chromium/Node runtime (~100 MB+); heavier to distribute and update.
  - **Native SwiftUI** — best macOS experience but macOS-only; ruled out by the Windows/Linux requirement.

## 5. Model Download

- **Recommended**: **Hugging Face Hub** (`hf` CLI / `huggingface_hub`) into a gitignored `models/` app-data directory.
- **Rationale**: Both model families are published on the Hub — Parakeet-TDT ONNX under `csukuangfj/sherpa-onnx-nemo-parakeet-tdt-*` (CC-BY-4.0) and Qwen2.5-Instruct GGUF under `Qwen/Qwen2.5-*-Instruct-GGUF` — so `hf download` gives resumable, checksummed, per-file downloads of exactly the artifacts we need. Storing them under `models/` (gitignored) keeps the repo clean and lets users pre-seed or swap models offline.
- **Rejected alternatives**:
  - **`ollama pull`** — couples the model store to the Ollama service rejected in decision 2.
  - **Direct curl of release URLs** — no resume, no checksums, brittle URLs.

## 6. Live Transcription

- **Recommended**: **Parakeet-TDT via sherpa-onnx with VAD-segmented simulated streaming** — silero-vad splits the mic stream into speech segments, the offline recognizer decodes a sliding window, and partial results are emitted as the buffer grows; segments are finalized on VAD boundaries.
- **Rationale**: Evidence check (k2-fsa/sherpa-onnx#2918): sherpa-onnx's online/streaming recognizer does **not** support Parakeet — Parakeet-TDT is an offline transducer and true chunked streaming is not implemented for it. The officially demonstrated real-time pattern (their `parakeet-tdt-simulate-streaming-microphone` example) is VAD + sliding-window offline decode, which still delivers live captions and final punctuated transcripts. This satisfies the brief's "emitting partial results" while staying on the mandated Parakeet model. If true chunked streaming is ever required, sherpa-onnx supports it for zipformer/paraformer models — noted, not adopted.
- **Rejected alternatives**:
  - **True streaming with an online model** (zipformer/paraformer) — genuine chunked streaming, but abandons Parakeet, contradicting the product brief.
  - **Whole-file transcription after the call** — no live captions; two-phase UX.

## 7. Summarization

- **Recommended**: **Qwen2.5-Instruct GGUF via llama.cpp with templated prompts**.
- **Rationale**: Qwen2.5-3B-Instruct GGUF (Q4_K_M ≈ 1.9 GB) fits the fully-local, CPU/Metal-friendly constraint with 32K context — comfortably covering meeting transcripts — and llama.cpp supplies the official `qwen2.5` chat template. Templated prompts (decision 8) make summarization deterministic, testable, and user-adjustable without code changes.
- **Rejected alternatives**:
  - **Embedding-only retrieval** (no generation) — cannot produce prose summaries.
  - **Cloud LLM summarization** — violates the fully-local constraint.

## 8. Summary Templates

- **Recommended**: **JSON template files** — each carries a prompt template, a section schema, and placeholders (`{transcript}`, `{duration}`, `{title}`); stored under `templates/`; user-extensible. Built-ins: `key-points`, `action-items`, `meeting-notes`, `decisions`.
- **Rationale**: JSON is declarative, diffable, and parsed identically in Rust (serde) and the webview (native JSON), so the same files drive both the CLI and the GUI. Placeholders keep prompts reusable across meetings and locales; user-extensible templates add new summary types with zero recompiles.
- **Rejected alternatives**:
  - **Hard-coded prompts in Rust/TS** — every new summary type requires a rebuild.
  - **Markdown/YAML templates** — workable, but JSON avoids syntax-significant whitespace and extra parsers.

## Proposed Repository Layout

Phase 2 scaffolds these top-level directories verbatim:

```
myna/
├── app/          # Tauri 2 shell: src-tauri/ (Rust core) + window/webview wiring
├── crates/       # Rust workspace: myna-audio, myna-stt, myna-llm (independent crates)
├── ui/           # Webview frontend sources (HTML/CSS/TS; framework decided in Phase 2)
├── templates/    # JSON summary templates (built-ins + user extensions)
├── models/       # Downloaded Parakeet + Qwen GGUF (gitignored)
├── scripts/      # download-models.sh + dev helpers
├── docs/         # This proposal, ADRs, usage docs
└── tests/        # Cross-crate integration / E2E tests
```

## Commands

Phase 3 cites these in CLAUDE.md.

**Model download** (HF Hub; `hf` ships with `huggingface_hub`, older CLI: `huggingface-cli`):

```bash
# Parakeet STT (ONNX, int8) — sherpa-onnx HF mirror of the GitHub release artifact
hf download csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8 \
  --local-dir models/parakeet-tdt-0.6b-v2-int8

# Qwen2.5 Instruct GGUF (Q4_K_M, ~1.9 GB) — official Qwen repo
hf download Qwen/Qwen2.5-3B-Instruct-GGUF \
  --include "qwen2.5-3b-instruct-q4_k_m.gguf" \
  --local-dir models/qwen2.5-3b-instruct
```

**Run STT** (sherpa-onnx, VAD simulated streaming):

```bash
# Offline transcription of a recording
cargo run -p myna-stt -- --model models/parakeet-tdt-0.6b-v2-int8 --input recordings/meeting.wav

# Live mic transcription (silero-vad segmentation, emits partial results)
cargo run -p myna-stt -- --model models/parakeet-tdt-0.6b-v2-int8 --stream --input mic
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
