# ADR 0004: Safe llama-cpp-2 Bindings (No Unsafe FFI)

**Status**: Decided (Phase 2)  
**Date**: 2026-08-25  
**Context**: Myna uses Qwen2.5-Instruct via llama.cpp for on-device LLM inference. The Rust ecosystem offers two main crates: `llama-cpp-sys-2` (low-level FFI bindings) and `llama-cpp-2` (safe wrapper over `-sys-2`). The project enforces `unsafe_code = "forbid"` workspace-wide for correctness.

## Decision

Use **`llama-cpp-2`** crate (safe Rust bindings):
- Wraps raw C FFI from `llama-cpp-sys-2`.
- Exposes safe async API: `LlamaContext`, `Session`, `InferenceRequest`, token streaming, cancellation.
- Compiles llama.cpp from source (C++, via cmake + bindgen); first build is ~2–3 minutes.
- No unsafe code exposed to application code; all `unsafe` blocks are contained in the crate.

## Rationale

1. **Workspace constraint**: `unsafe_code = "forbid"` is enforced at the workspace level. Using `llama-cpp-sys-2` directly would require a wrapper crate to hide unsafe FFI. Using `llama-cpp-2` eliminates that work.

2. **Type safety**: `llama-cpp-2` provides Rust abstractions (Sessions, inference builders) that prevent common FFI bugs (double-free, invalid pointers, memory corruption). The compiler enforces correctness.

3. **Async/await support**: `llama-cpp-2` has async inference methods compatible with Tokio. No blocking the Tauri main thread.

4. **Token streaming and cancellation**: Built-in support for partial results and early termination. Important for responsive UI ("stop generating" button).

5. **Maintainability**: One code path to maintain. If llama.cpp upstream APIs change, `llama-cpp-2` maintainers absorb the FFI translation; the app code remains stable.

## Options Considered

### llama-cpp-sys-2 (raw C FFI)
- **Pros**: Direct control, no wrapper overhead, lightweight.
- **Cons**: Every use of llama.cpp requires `unsafe` blocks. Violates workspace `unsafe_code = "forbid"`. Error-prone (buffer management, lifetime errors).
- **Rejected**: Violates the workspace constraint and adds maintenance burden (unsafe blocks in every caller).

### Ollama (background service)
- **Pros**: Easy setup, model management, multi-language client libraries.
- **Cons**: Adds a persistent background process; "just works" requirement harder to meet. Multi-binary distribution.
- **Rejected**: Stack proposal section 2 mandates in-process embedding. Ollama is fallback only.

### Cloud LLM APIs (OpenAI, Anthropic, etc.)
- **Pros**: State-of-the-art models, no local compute.
- **Cons**: Requires internet, violates "no data sent to the cloud" mandate.
- **Rejected**: Fully-local requirement precludes cloud APIs.

## Consequences

### Positive
- Workspace constraint (`unsafe_code = "forbid"`) is satisfied; all unsafe FFI is hidden.
- Compiler enforces memory safety; FFI errors are caught at compile-time or runtime (panic), not silent corruption.
- Async/await integration with Tauri/Tokio is seamless.
- Token streaming and cancellation support are first-class; no manual polling.

### Negative
- **First build is slow**: llama.cpp is compiled from C++ source on first `cargo build`. Subsequent builds are fast (cached). CI pipelines should pre-build or cache the llama.cpp compilation step.
- **Build dependencies**: Requires a C++ compiler and cmake on the build machine. macOS (clang + Xcode command-line tools), Linux (gcc/clang + build-essential), Windows (MSVC or MinGW) are all supported.
- **Binary size**: Embedding llama.cpp in the app binary (~30 MB for the static library) is larger than downloading a prebuilt binary. Mitigated by app size (Tauri already bundles a system webview, so the delta is modest).

## Implementation Notes

- **Crate addition**: Add `llama-cpp-2` to `app/src-tauri/Cargo.toml`.
- **Context initialization**:
  ```rust
  let model = LlamaModel::load_from_file(
      &model_path,
      LlamaModelParams::default()
  )?;
  let mut context = model.create_context(
      LlamaContextParams::default().with_n_ctx(32768)
  )?;
  ```
- **Async inference**:
  ```rust
  let mut session = context.create_session()?;
  let response = session.infer_async::<Standard>(
      &mut inference_request
  ).await?;
  ```
- **Streaming tokens**:
  ```rust
  for token in session.infer_stream(&mut request)? {
      // Emit partial results to UI
  }
  ```
- **CI optimization**: Cache the llama.cpp build artifact across CI runs (e.g., GitHub Actions cache), or pre-build and upload a static library as a release artifact.

## References

- `llama-cpp-2` crate: https://crates.io/crates/llama-cpp-2
- `llama-cpp-sys-2` (low-level FFI): https://crates.io/crates/llama-cpp-sys-2
- Stack proposal section 2 (LLM Runtime): ../stack-proposal.md
- Workspace `unsafe_code = "forbid"`: `Cargo.toml` `[lints.rust]` section
