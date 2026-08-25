# CLAUDE.md

## Project context

Myna is a **local-first AI meeting recorder/summarizer**: capture meeting audio, get live transcripts, review key points, and remember takeaways.

- **STT**: Parakeet-TDT (ONNX) via sherpa-onnx, with VAD-segmented simulated streaming.
- **Summarization**: Qwen2.5-Instruct (GGUF) via llama.cpp, templated.
- **Fully local**: STT and summaries run on-device; **no data is sent to the cloud**.
- **License**: MIT.
- **Targets**: macOS-first; Windows/Linux supported.

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

## Conventions

- **`models/`** is gitignored — downloaded artifacts (`.gguf`, `.onnx`) are never committed; fetched once via `hf` and stored locally.
- **`templates/`** is user-extensible JSON — same files drive both the CLI and the GUI; add new summary types without recompiling.
- **`data/`** is machine-local runtime data (gitignored) — never commit recordings, transcripts, or caches.
