# ADR 0002: Parakeet-TDT v3 (Multilingual) over v2 (English-only)

**Status**: Decided (Phase 2)  
**Date**: 2026-08-25  
**Context**: Myna uses sherpa-onnx for speech-to-text. The k2-fsa/sherpa-onnx project publishes both Parakeet-TDT v2 and v3 variants; they differ in language coverage but are otherwise architecturally identical.

## Decision

Use **Parakeet-TDT v3** (`csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8`).

- **Language coverage**: English + 24 European languages (German, French, Spanish, Italian, Portuguese, Dutch, Polish, Czech, Romanian, Greek, Hungarian, Finnish, Swedish, Norwegian, Danish, Bulgarian, Croatian, Lithuanian, Slovene, Slovak, Estonian, Latvian, Icelandic, Faroese).
- **Model artifacts**: `encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx`, `tokens.txt` (same filenames as v2; swap only the repo ID).
- **Test fixtures**: v3 ships `test_wavs/{de,en,es,fr}.wav` (German, English, Spanish, French); v2 shipped `test_wavs/0.wav` (English-only). Update test fixture references accordingly.

## Rationale

1. **Same architecture, same inference cost**: v3 is a retrained variant of v2 on a multilingual corpus. Runtime inference path, quantization (INT8), and latency are identical. No "pay extra" for language coverage.

2. **Supports European markets**: If Myna expands beyond English-speaking users (e.g., German-speaking teams, French companies), v3 is ready without a model swap. v2 would require switching models and retraining CI/deployment.

3. **Backward compatible API**: Same sherpa-onnx C++ / Rust API; the encoder/decoder/joiner architecture is unchanged. Only the model weights differ.

4. **No build-time cost**: Models are downloaded at runtime via Hugging Face Hub, not compiled. Model swap is a 1-line path change.

5. **Test coverage**: v3 ships with multilingual test wavs, so we can verify non-English transcription end-to-end in tests.

## Options Considered

### Parakeet-TDT v2 (English-only)
- **Pros**: Slightly smaller download (~5% smaller, negligible).
- **Cons**: Monolingual; expansion to other languages requires a model swap and test rewrite.
- **Rejected**: v3 costs the same at inference; the minimal download saving doesn't justify locking Myna to English-only.

### Whisper (OpenAI, multilingual)
- **Pros**: 99-language coverage, widely adopted.
- **Cons**: Larger models (base ~140 MB, not INT8 quantized); architecturally different from Parakeet (requires different sherpa-onnx code path or whisper.cpp entirely).
- **Rejected**: Parakeet-TDT is mandated in the stack proposal (section 1). Whisper would require pivoting off sherpa-onnx.

## Consequences

### Positive
- Multilingual support out-of-the-box; users recording in any supported European language get high-quality transcripts.
- No technical debt around "we'll add more languages later" — it's already here.
- Test fixtures validate multiple languages in the test suite itself.

### Negative
- Slightly larger model download (640 MB vs ~615 MB; negligible).
- Users recording in unsupported non-European languages (e.g., Mandarin, Arabic) still get English-only results (Parakeet doesn't support them, v2 or v3).

## Implementation Notes

- **Model path**: Change all references from `models/parakeet-tdt-0.6b-v2-int8` to `models/parakeet-tdt-0.6b-v3-int8`.
- **HF repo ID**: `csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8`.
- **Test fixtures**: Update any hardcoded test wav paths from `test_wavs/0.wav` to one of the v3 fixtures: `test_wavs/en.wav`, `test_wavs/de.wav`, `test_wavs/es.wav`, `test_wavs/fr.wav`.
- **CI/download scripts**: Ensure `scripts/download-models.sh` fetches the v3 repo ID, not v2.

## References

- Parakeet-TDT v3 announcement: k2-fsa/sherpa-onnx GitHub releases.
- Stack proposal section 1 (STT Model Runtime): ../stack-proposal.md
