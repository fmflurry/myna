# scripts

Dev helpers per `docs/stack-proposal.md`.

## download-models.sh

Fetches the local models Myna needs — Parakeet STT v3 (sherpa-onnx, int8),
Qwen2.5-7B-Instruct GGUF (Q4_K_M, two shards), and the silero VAD ONNX model — into
`~/myna/models` by default, the same location the packaged app reads from
(`paths::models_root()` in release builds). Idempotent — re-running skips
any artifact already present.

Override the destination with `MYNA_MODELS_DIR` (same env var the app
honours) or `--dest <dir>`.

Downloads use `curl` against each artifact's Hugging Face `resolve/main` URL
directly (the Qwen model is fetched as its two GGUF shards); no `hf` CLI is
required.

If you have an older checkout with weights already downloaded into the
repo's own `models/` directory, this script detects that and will **not**
re-download or duplicate the ~5.4 GB of weights — it prints the exact
`mv`/`ln -s` command to relocate them, or performs the move itself when you
pass `--migrate`.

```bash
# Fetch everything into ~/myna/models (skips artifacts already on disk)
scripts/download-models.sh

# Fetch into a custom destination
scripts/download-models.sh --dest /path/to/models
MYNA_MODELS_DIR=/path/to/models scripts/download-models.sh

# Fetch a single artifact
scripts/download-models.sh --only parakeet
scripts/download-models.sh --only qwen
scripts/download-models.sh --only vad

# Move weights already present in the repo's models/ dir into the new
# default location instead of just printing the relocation command
scripts/download-models.sh --migrate

# Check that all three artifacts are present at the resolved destination
# (used by app onboarding + CI); exits non-zero if any are missing
scripts/download-models.sh --check

# Show usage
scripts/download-models.sh --help
```

## generate-icons.sh

Regenerates the desktop/mobile app icon set in `app/src-tauri/icons/` from
`myna-brand-kit/myna-app-icon.svg`, respecting Apple's Big Sur+ icon safe
area (content inset to ~824x824 on the 1024x1024 canvas, i.e. a ~100px
transparent margin per side). Feeding a full-bleed 1024 render straight to
`tauri icon` makes the tile look oversized next to other Dock icons — this
script fixes that by rendering the source SVG at 824x824 and compositing it
centred onto a transparent 1024x1024 canvas before handing it to `tauri icon`.

Requires:
- ImageMagick (`magick`) — used for the transparent-canvas composite.
- A Playwright Chromium headless shell under
  `~/Library/Caches/ms-playwright/chromium_headless_shell-*` — used to
  render the SVG to PNG with a clean alpha channel. Install via
  `npx playwright install chromium-headless-shell` if missing.
- `npx` (for `tauri icon`), with `cargo` on `PATH` (the script prepends
  `$HOME/.cargo/bin` itself).

```bash
scripts/generate-icons.sh
```

The script fails loudly (non-zero exit, message on stderr) if a required
tool can't be found, rather than silently producing a bad icon.

## bench-stt-cpu.sh

Runs the `#[ignore]`d `stt_streaming_cpu_benchmark` test
(`tests/integration/tests/stt_cpu_bench.rs`) directly under `/usr/bin/time -l`
and samples the benchmark process's thread count every 500ms while it runs.
The benchmark decodes a fixed ~180s synthetic workload (the `en.wav` speech
fixture repeated with inserted silence so the VAD segments it naturally)
through `SimulatedStreamer` at maximum throughput (no artificial pacing), and
prints one machine-readable line with the audio duration, wall-clock time,
and real-time factor (RTF).

Requires downloaded models (see `download-models.sh` above) — the benchmark
self-skips, and this script then exits non-zero, if they're missing.

```bash
# Benchmark at the app's default 8 STT decode threads
scripts/bench-stt-cpu.sh

# Sweep thread count without rebuilding (forwarded as MYNA_BENCH_STT_THREADS)
scripts/bench-stt-cpu.sh --threads 4
```

Prints a final block of `wall_sec`, `user_cpu_sec`, `sys_cpu_sec`, `cpu_pct`
(`(user + sys) / wall * 100`), `peak_rss`, `max_threads`, and `rtf` — the
numbers to compare across thread-count or tuning-constant sweeps. The
underlying test binary is invoked directly rather than through `cargo test`
so `/usr/bin/time -l` and the thread sampler observe the actual worker
process, not the `cargo` wrapper process.

## verify.sh

See `verify.sh` for its own usage; owned separately from this script.
