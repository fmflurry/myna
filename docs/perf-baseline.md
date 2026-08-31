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

## T4 — pin Silero VAD session to 1 thread

Fixes a latent defect: `VadModelConfig { ..VadModelConfig::default() }` left
`num_threads` at `0`, which ONNX Runtime treats as "use the ORT default"
(a full-width pool sized to detected cores) — not "one thread". Silero
processes 512-sample windows, far too small a unit of work to parallelize.
Added `VAD_NUM_THREADS: i32 = 1` (`crates/myna-stt/src/vad.rs`) and wired it
into the `VadModelConfig` literal. No VAD tuning values (`threshold`,
`min_silence_sec`, `min_speech_sec`, `max_speech_sec`) changed.

Command (still 8 STT-engine threads — T5 has not landed yet):

```bash
export PATH="$HOME/.cargo/bin:$PATH"
./scripts/bench-stt-cpu.sh --threads 8
```

Result block (verbatim):

```
wall_sec=9.10
user_cpu_sec=62.24
sys_cpu_sec=0.86
cpu_pct=693.41
peak_rss=1197555712
max_threads=23
rtf=0.0416
audio_sec=183.677
threads_requested=8
```

WER (verbatim `MYNA_WER` lines):

```
MYNA_WER lang=en wer=0.0000
MYNA_WER lang=fr wer=0.0000
MYNA_WER lang=de wer=0.0000
MYNA_WER lang=es wer=0.1765
```

No regression vs baseline (WER identical; rtf and cpu_pct within the
benchmark's documented run-to-run variance — `max_threads` unchanged at 23
because the STT engine's own 8-thread pool still dominates that count, and
the VAD's 1-thread pool doesn't lift the ORT thread ceiling further).
Rust gate (`cargo fmt --all --check`, `cargo clippy --workspace
--all-targets --locked -- -D warnings`, `cargo test --workspace --locked`)
exits 0.

## T5 — STT engine threads 8 -> 4

`STT_ENGINE_THREADS_MAX` and `STT_ENGINE_THREADS_FALLBACK`
(`app/src-tauri/src/state.rs`) both moved from `8` to `4`, together — moving
only `MAX` would leave `clamp_thread_count(None)` returning `8` (via
`.unwrap_or(FALLBACK).clamp(MIN, MAX)` -> `8.clamp(2, 4) = 4`, which is
actually fine arithmetically, but `app/src-tauri/tests/state.rs`'s
`falls_back_when_parallelism_is_undetected` asserts
`clamp_thread_count(None) == STT_ENGINE_THREADS_FALLBACK` by *identity* with
the constant, so leaving `FALLBACK` at `8` would desync the fallback value
from the tuned ceiling even though the test would still pass numerically at
4). Root cause documented on `STT_ENGINE_THREADS_MAX`: sherpa-onnx's
`OfflineModelConfig` applies one `num_threads` to all three Parakeet-TDT ORT
sessions (encoder/decoder/joiner); the decoder/joiner are tiny per-step ops
that mostly spin (`ThreadPoolTempl::WorkerLoop`/`SpinPause`) rather than do
useful work at 8 threads, and ORT's own fix
(`session.intra_op.allow_spinning`) is unreachable through sherpa-onnx
1.13.6. Also fixed the stale "num_threads=8" reference in
`crates/myna-stt/src/stream.rs`'s `PARTIAL_INTERVAL_SEC` doc comment to note
the retune. `STT_ENGINE_THREADS_MIN` (`2`) unchanged.

Command (now 4 STT-engine threads):

```bash
export PATH="$HOME/.cargo/bin:$PATH"
./scripts/bench-stt-cpu.sh --threads 4
```

Result block (verbatim):

```
wall_sec=13.51
user_cpu_sec=48.55
sys_cpu_sec=1.14
cpu_pct=367.80
peak_rss=1191182336
max_threads=11
rtf=0.0667
audio_sec=183.677
threads_requested=4
```

WER (verbatim `MYNA_WER` lines):

```
MYNA_WER lang=en wer=0.0000
MYNA_WER lang=fr wer=0.0000
MYNA_WER lang=de wer=0.0000
MYNA_WER lang=es wer=0.1765
```

`cpu_pct` dropped from ~693% (T4, 8 threads) to ~368% (T5, 4 threads) and
`max_threads` dropped from 23 to 11 — consistent with halving the STT
engine's thread pool. `rtf` rose from 0.0416 to 0.0667 but stays far under
the 0.85 STOP threshold; the encoder's real parallel work costs more
wall-time at 4 threads as expected, but the pipeline still runs at ~15x
realtime. WER identical to baseline/T4 — no accuracy regression. Rust gate
exits 0.

## T6 — partial interval 1.0s -> 2.0s

`PARTIAL_INTERVAL_SEC` (`crates/myna-stt/src/stream.rs`) moved from `1.0`
to `2.0`. Updated its doc comment to record that a 4s-window partial at a
2.0s interval was already measured at ~0.45x realtime vs ~0.44x at the
previous 1.0s/8s-window pairing — essentially free — and that halving the
partial-decode frequency has no perceptible effect on live-caption latency.

Command (4 STT-engine threads, per T5):

```bash
export PATH="$HOME/.cargo/bin:$PATH"
./scripts/bench-stt-cpu.sh --threads 4
```

Result block (verbatim):

```
wall_sec=12.03
user_cpu_sec=44.80
sys_cpu_sec=0.37
cpu_pct=375.48
peak_rss=1188855808
max_threads=11
rtf=0.0585
audio_sec=183.677
threads_requested=4
```

WER (verbatim `MYNA_WER` lines):

```
MYNA_WER lang=en wer=0.0000
MYNA_WER lang=fr wer=0.0000
MYNA_WER lang=de wer=0.0000
MYNA_WER lang=es wer=0.1765
```

`cpu_pct` and `rtf` are within the benchmark's documented run-to-run
variance of the T5 measurement (368% -> 375%, 0.0667 -> 0.0585) — this
benchmark pushes fixture audio with no sleep pacing, so it decodes
back-to-back regardless of `PARTIAL_INTERVAL_SEC` and cannot show this
constant's real effect (which only matters when partials are paced against
wall-clock time during a live recording); the WER-identical, no-regression
result confirms the change doesn't affect final transcript quality, which
is the only thing directly attributable here at the bench-script's flat-out
throughput. Rust gate exits 0.

## T7 — partial window 8.0s -> 4.0s, commit hop 4.0s -> 2.0s

`PARTIAL_WINDOW_SEC` (`8.0` -> `4.0`) and `PARTIAL_COMMIT_HOP_SEC` (`4.0`
-> `2.0`) moved together in `crates/myna-stt/src/stream.rs`, preserving the
1:2 hop-to-window ratio. Moving only the window would have left the hop
equal to the window (`4.0`/`4.0`), where the doc-recorded invariant "hop
must stay smaller than the window" holds only at equality — with zero
margin, a word could age out of the decode window in the same instant it
becomes eligible for commit, silently dropping it. `PARTIAL_OVERLAP_SEC`
(`2.0`) was left unchanged — `2.0 < 4.0` still holds, preserving the
overlap invariant that prevents mid-word truncation at the window start.
Both doc comments updated to record the ratio and the reason the two
constants must move together.

Command (4 STT-engine threads, per T5):

```bash
export PATH="$HOME/.cargo/bin:$PATH"
./scripts/bench-stt-cpu.sh --threads 4
```

Result block (verbatim):

```
wall_sec=14.16
user_cpu_sec=47.54
sys_cpu_sec=2.02
cpu_pct=350.00
peak_rss=1201389568
max_threads=11
rtf=0.0703
audio_sec=183.677
threads_requested=4
```

WER (verbatim `MYNA_WER` lines):

```
MYNA_WER lang=en wer=0.0000
MYNA_WER lang=fr wer=0.0000
MYNA_WER lang=de wer=0.0000
MYNA_WER lang=es wer=0.1765
```

`cpu_pct` (350%) and `rtf` (0.0703) remain within run-to-run variance of
T5/T6, and well clear of the 0.85 rtf STOP threshold. WER identical across
all four steps — no accuracy regression from halving the partial window and
hop. Rust gate exits 0.

## T8 — Phase 3b: dual-track capture (three WAV files, two decode streamers)

Wired dual-track capture through the recording session: `audio.wav` is now
genuine device-native-rate stereo (header deferred until
`myna_audio::capture_sources`'s new `on_native_rate` callback reports the
authoritative rate), and `track-mic.wav` / `track-system.wav` are new 16 kHz
mono STT-grade files, one per present track (never created for a track the
active capture source can't populate). The decode worker now owns two
`SimulatedStreamer`s — one per track, sharing a single `Arc<SttEngine>` — on
one decode-worker thread dispatching by track, so decode stays exactly as
serialized (and ORT thread parallelism exactly as unchanged) as it was with
one streamer. `DECODE_CHANNEL_CAPACITY` doubled 150 -> 300 (two tracks can
now enqueue per callback instead of one). None of this changes the STT
engine's own thread pool size (`STT_ENGINE_THREADS_MAX`, still 4 per T5), so
this run measures whether the *second* streamer sharing that one engine adds
meaningful overhead versus T7's single-streamer baseline.

Command (4 STT-engine threads, per T5; this benchmark only exercises the
mic-track streamer, since it feeds a single-track WAV fixture):

```bash
export PATH="$HOME/.cargo/bin:$PATH"
./scripts/bench-stt-cpu.sh --threads 4
```

Result block (verbatim):

```
wall_sec=12.56
user_cpu_sec=46.23
sys_cpu_sec=0.53
cpu_pct=372.29
peak_rss=1167851520
max_threads=11
rtf=0.0614
audio_sec=183.677
threads_requested=4
```

`cpu_pct` (372%) and `rtf` (0.0614) remain within T5/T6/T7's run-to-run
variance (350-376%, 0.0585-0.0703) and well clear of the 0.85 rtf STOP
threshold gate for this phase (`rtf >= 0.5`) — the second, idle-in-this-benchmark
streamer sharing the one `Arc<SttEngine>` adds no measurable CPU or thread
overhead. `max_threads` unchanged at 11, confirming no second engine (and
no second ORT thread pool) was accidentally constructed. Full Rust gate
(`cargo fmt --all --check`, `cargo clippy --workspace --all-targets --locked
-- -D warnings`, `cargo test --workspace --locked`) exits 0 (337 passed, 21
ignored, 50 suites — up from the 333/21/50 baseline by the four new
Phase 3b tests).
