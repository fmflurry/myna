# Myna

**Myna is an AI-powered meeting record & summarize app.** Capture meeting audio, get live transcripts, review key points, and remember takeaways — all on your own machine.

## Key features

- **Audio capture** — record meeting audio directly from the mic (or a file) via `cpal` in the Rust core.
- **Live transcription** — Parakeet-TDT (ONNX) via **sherpa-onnx**, with silero-VAD-segmented simulated streaming so captions appear in real time and final punctuated transcripts are emitted on VAD boundaries.
- **Local summarization** — Qwen2.5-Instruct (GGUF) via **llama.cpp**, embedded in-process — no background service to install or supervise.
- **Summary templates** — declarative JSON templates that drive summarization; built-ins include `key-points`, `action-items`, `meeting-notes`, and `decisions`, and users can add new types without recompiling.
- **Action item extraction** — pull concrete next steps out of a meeting transcript using the `action-items` template.

## Local-first privacy

Everything runs **locally**:

- Speech-to-text (Parakeet via sherpa-onnx) and summarization (Qwen via llama.cpp) both run on-device.
- **No meeting data is sent to the cloud.**
- Models are downloaded **once** from Hugging Face Hub (Parakeet STT + Qwen GGUF) and stored locally under `models/`.

## License

Myna is released under the **MIT** License — see [LICENSE](LICENSE).

Third-party model licenses:

- **Parakeet-TDT** model weights — CC-BY-4.0 (attribution required).
- **sherpa-onnx** runtime — Apache-2.0.
- **llama.cpp** runtime — MIT.

## Stack

See [docs/stack-proposal.md](docs/stack-proposal.md) for the full architecture and decision record. In brief:

- **Tauri 2** shell — Rust core + system webview (macOS-first; Windows/Linux supported).
- **Rust** core built on **cpal** (audio capture), **sherpa-onnx** (STT), and **llama.cpp** (LLM).
- **Webview UI** for the frontend.
- **Hugging Face Hub** (`hf`) for model downloads.

## Platform targets

- **macOS** — first-class target.
- **Windows** and **Linux** — supported.

## Repository layout

```
myna/
├── app/          # Tauri 2 shell: Rust core + window/webview wiring
├── crates/       # Rust workspace: myna-audio, myna-stt, myna-llm
├── ui/           # Webview frontend sources
├── templates/    # JSON summary templates (built-ins + user extensions)
├── models/       # Downloaded Parakeet + Qwen GGUF (gitignored)
├── scripts/      # download-models.sh + dev helpers
├── docs/         # This proposal, ADRs, usage docs
├── tests/        # Cross-crate integration / E2E tests
└── data/         # Machine-local runtime data (gitignored)
```

## Roadmap

- **Model download script** — `scripts/download-models.sh` (via `hf`) for Parakeet + Qwen.
- **STT crate** — `myna-stt`: offline + live (VAD-segmented) transcription.
- **LLM crate** — `myna-llm`: templated Qwen summarization.
- **Tauri shell** — wire the `app/` shell to the Rust core and webview UI.
