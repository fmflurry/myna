# STT performance & accuracy baseline

Fresh baseline captured before any VAD/streaming tuning work, so later
changes to `myna-stt` (VAD thresholds, partial-commit timing, thread pool
sizing, resampling, ...) can be measured against a known-good starting
point. Do not treat these numbers as targets to hit — they are the
"before" side of a before/after comparison.

## Machine & revision

- Machine: Apple M5 Pro, 15 cores
- macOS: 26.5.2 (build 25F84), via `sw_vers`
- Git revision: `6c29c35aa5f957b48c01cffd6276127350cdbff0`, via `git rev-parse HEAD`

## CPU / real-time-factor benchmark (T1, 8 threads)

Command:

```bash
export PATH="$HOME/.cargo/bin:$PATH"
./scripts/bench-stt-cpu.sh --threads 8
```

Result block (verbatim):

```
wall_sec=20.32
user_cpu_sec=95.31
sys_cpu_sec=12.83
cpu_pct=532.19
peak_rss=967901184
max_threads=23
rtf=0.0997
audio_sec=183.677
threads_requested=8
```

### Caveat: `cpu_pct` is a max-throughput figure, not the live-recording number

`bench-stt-cpu.sh` pushes the fixture audio through the pipeline back-to-back
with **no sleep pacing** — it processes 183.677 s of audio in ~20 s wall
time (rtf≈0.10), so `cpu_pct` (532%) reflects how much CPU the pipeline
*can* consume when run flat-out, not how much it uses while decoding audio
paced at real-time speed during an actual meeting. Use this number only as
a **relative before/after metric** across tuning changes measured with this
same script, on this same machine.

The number that matters for real usage was measured separately: during a
live recording with the packaged app, CPU usage was **~250-270%**, with
21-23 ORT threads active. That is the figure future tuning phases (thread
pool sizing, batching, etc.) are meant to reduce — not the benchmark's
`cpu_pct`.

Run-to-run variance is expected on this benchmark (a prior run at the same
`--threads 8` measured `cpu_pct=672.67`, `rtf=0.0477`); treat single runs as
indicative, not exact.

## Accuracy (word error rate) benchmark

Command:

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cargo test -p myna-integration-tests --release --locked -- --ignored streaming_wer --nocapture
```

Result (verbatim `MYNA_WER` lines from `tests/integration/tests/stt_accuracy.rs`):

```
MYNA_WER lang=en wer=0.0000
MYNA_WER lang=fr wer=0.0000
MYNA_WER lang=de wer=0.0000
MYNA_WER lang=es wer=0.1765
```

Per-language WER budgets enforced by the test (`WER_BUDGETS` in
`tests/integration/tests/stt_accuracy.rs`): `en=0.05`, `fr=0.05`, `de=0.05`,
`es=0.20`. The `es` budget is intentionally wider than the others — see
"Known gaps" below — and may only ever be lowered, never raised, without a
written justification in that file.

## Known gaps

- **Spanish first-word loss (VAD-segmented streaming only).** The
  VAD-segmented simulated streaming path drops the leading word ("No") and
  loses accents (`qué` -> `que`) on the `es` fixture. An offline,
  full-context decode of the same audio gets both right, so this is a real
  streaming-onset defect in the VAD-segmented pipeline, not a model
  accuracy limit. It is tracked as follow-up VAD tuning work and is
  deliberately *not* fixed in this baseline change — a naive leading-silence
  pad was already shown unstable (some pad values fixed `es` but broke
  `fr`, and a 1.0 s pad crashed the ONNX encoder with
  `Invalid input shape: {0,128}`).
- **No tuning change has been applied yet.** The CPU/RTF and WER numbers
  above are the pre-tuning baseline; no VAD threshold, partial-commit
  timing, thread pool, or resampling change has landed since this baseline
  was captured.
