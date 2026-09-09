# crates

Rust workspace crates per docs/stack-proposal.md:

- `myna-audio` — cpal capture + WAV.
- `myna-coreaudio-tap` — macOS Core Audio process taps for system audio
  (ADR 0007).
- `myna-stt` — sherpa-onnx Parakeet-TDT + Silero VAD + speaker
  diarization/centroid merge.
- `myna-llm` — embedded llama.cpp Qwen + JSON templates.
