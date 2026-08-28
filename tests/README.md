# tests

Cross-crate integration tests for the full record -> transcribe -> summarize
pipeline, in `tests/integration/` (`myna-integration-tests` workspace
member).

## Running

```bash
# Fast path — no models required. Exercises myna-audio <-> myna-stt
# resampling, WAV recording, and level metering.
cargo test --workspace

# Full path — requires the models below to be downloaded first via
# scripts/download-models.sh. Exercises real Parakeet-TDT decode,
# VAD-segmented simulated streaming, and Qwen2.5 summarization.
cargo test --workspace -- --ignored
```

Model-backed tests are marked `#[ignore]` and self-skip (pass trivially,
printing why) when the required models are not present on disk, or when
`MYNA_SKIP_MODEL_TESTS=1` is set. Run them in `--release`: a debug build of
llama.cpp / sherpa-onnx is drastically slower and may look like a hang.

```bash
cargo test -p myna-integration-tests --release --locked -- --ignored
```

## Layout

- `tests/integration/src/lib.rs` — fixture-path helpers (model directories,
  the speech fixture, `models_present()`).
- `tests/integration/tests/audio_roundtrip.rs` — always-on `myna-audio` <->
  `myna-stt` tests (resampling, WAV recording, RMS metering). No models
  needed.
- `tests/integration/tests/stt_pipeline.rs` — `#[ignore]`d offline decode and
  simulated streaming tests against the real Parakeet-TDT and Silero VAD
  models.
- `tests/integration/tests/summarize_pipeline.rs` — `#[ignore]`d
  summarization tests against the real Qwen2.5 GGUF, covering every
  built-in template plus mid-generation cancellation.
