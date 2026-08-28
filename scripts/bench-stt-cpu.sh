#!/usr/bin/env bash
# Runs the `#[ignore]`d `stt_streaming_cpu_benchmark` test
# (tests/integration/tests/stt_cpu_bench.rs) under `/usr/bin/time -l` and
# samples the benchmark process's thread count every 50ms while it runs,
# so a single invocation reports wall-clock, CPU time, peak memory, and
# thread-count metrics alongside the benchmark's own audio-seconds/RTF
# numbers.
#
# Poll interval tightened from 500ms to 50ms for finer-grained sampling of
# ORT's decode-thread ramp-up. That alone did not explain a run measured to
# report `max_threads=1` while the ORT thread pool actually held steady at
# 23 threads for the whole decode phase — see the `pgrep -P ... -f ...`
# comment below for the actual bug that caused that: the sampler resolved
# the wrong PID (the `/usr/bin/time` wrapper or its `tee` child, both
# single-threaded) instead of the benchmark worker itself.
#
# The benchmark test binary is invoked directly (not via `cargo test`) so
# `/usr/bin/time -l` and the thread sampler observe the actual worker
# process, not the `cargo` process that would otherwise wrap it.
#
# Usage:
#   scripts/bench-stt-cpu.sh [--threads N]
#
# `--threads N` forwards to the benchmark as `MYNA_BENCH_STT_THREADS`,
# letting one binary sweep e.g. 8 vs 4 STT decode threads with no rebuild
# (default: 8, matching `STT_ENGINE_THREADS_FALLBACK` in
# `app/src-tauri/src/state.rs`).
#
# Requires downloaded models (see scripts/download-models.sh) — the
# benchmark self-skips (and this script then fails loudly) otherwise.
set -euo pipefail

export PATH="$HOME/.cargo/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

THREADS=8
SAMPLE_INTERVAL_SEC=0.05

while [[ $# -gt 0 ]]; do
    case "$1" in
        --threads)
            THREADS="$2"
            shift 2
            ;;
        *)
            echo "Unknown argument: $1" >&2
            echo "Usage: $0 [--threads N]" >&2
            exit 1
            ;;
    esac
done

export MYNA_BENCH_STT_THREADS="$THREADS"

WORK_DIR="$(mktemp -d)"
STDOUT_LOG="${WORK_DIR}/stdout.log"
TIME_LOG="${WORK_DIR}/time.log"
trap 'rm -rf "${WORK_DIR}"' EXIT

echo "==> building stt_cpu_bench (release, --threads=${THREADS})"
BUILD_OUTPUT="$(cargo test -p myna-integration-tests --release --locked \
    --test stt_cpu_bench --no-run 2>&1)"
echo "${BUILD_OUTPUT}"

BENCH_BIN="$(printf '%s\n' "${BUILD_OUTPUT}" \
    | grep -E 'Executable.*stt_cpu_bench' \
    | sed -E 's/.*\(([^)]+)\).*/\1/' \
    | head -1)"

if [[ -z "${BENCH_BIN}" || ! -x "${BENCH_BIN}" ]]; then
    echo "error: could not locate stt_cpu_bench test binary in build output" >&2
    exit 1
fi
echo "==> benchmark binary: ${BENCH_BIN}"

echo "==> running stt_streaming_cpu_benchmark"
/usr/bin/time -l "${BENCH_BIN}" --ignored --nocapture stt_streaming_cpu_benchmark \
    > >(tee "${STDOUT_LOG}") 2> "${TIME_LOG}" &
TIME_PID=$!

MAX_THREADS=0
while kill -0 "${TIME_PID}" 2>/dev/null; do
    # Resolve the benchmark's PID by combining *child of the `/usr/bin/time`
    # wrapper* (`-P "${TIME_PID}"`) with *command line matches the binary*
    # (`-f "${BENCH_BIN}"`). Either alone picks the wrong process: `-f`
    # alone also matches the `/usr/bin/time -l "${BENCH_BIN}" ...` wrapper
    # itself (1 thread, constant) since its own command line contains
    # `${BENCH_BIN}` as an argument; `-P` alone also matches the `tee
    # "${STDOUT_LOG}"` process substitution below (another direct child of
    # the wrapper, also 1 thread). Either false match sorts before the real
    # worker often enough that `head -1` silently produced `max_threads=1`
    # regardless of poll interval.
    BENCH_PID="$(pgrep -P "${TIME_PID}" -f "${BENCH_BIN}" | head -1 || true)"
    if [[ -n "${BENCH_PID}" ]]; then
        THREAD_COUNT="$(ps -M -p "${BENCH_PID}" 2>/dev/null | tail -n +2 | wc -l | tr -d ' ' || true)"
        if [[ -n "${THREAD_COUNT}" && "${THREAD_COUNT}" -gt "${MAX_THREADS}" ]]; then
            MAX_THREADS="${THREAD_COUNT}"
        fi
    fi
    sleep "${SAMPLE_INTERVAL_SEC}"
done

set +e
wait "${TIME_PID}"
BENCH_EXIT=$?
set -e

cat "${TIME_LOG}" >&2

if [[ ${BENCH_EXIT} -ne 0 ]]; then
    echo "error: stt_streaming_cpu_benchmark exited with status ${BENCH_EXIT}" >&2
    exit "${BENCH_EXIT}"
fi

BENCH_LINE="$(grep '^MYNA_BENCH' "${STDOUT_LOG}" || true)"
if [[ -z "${BENCH_LINE}" ]]; then
    echo "error: benchmark produced no MYNA_BENCH output — models missing? see scripts/download-models.sh" >&2
    exit 1
fi

AUDIO_SEC="$(printf '%s' "${BENCH_LINE}" | grep -oE 'audio_sec=[0-9.]+' | cut -d= -f2)"
RTF="$(printf '%s' "${BENCH_LINE}" | grep -oE 'rtf=[0-9.]+' | cut -d= -f2)"

TIME_LINE="$(grep -E '^\s*[0-9.]+ +real +[0-9.]+ +user +[0-9.]+ +sys' "${TIME_LOG}" || true)"
if [[ -z "${TIME_LINE}" ]]; then
    echo "error: could not parse /usr/bin/time -l output" >&2
    exit 1
fi
WALL_SEC="$(printf '%s' "${TIME_LINE}" | awk '{print $1}')"
USER_CPU_SEC="$(printf '%s' "${TIME_LINE}" | awk '{print $3}')"
SYS_CPU_SEC="$(printf '%s' "${TIME_LINE}" | awk '{print $5}')"
PEAK_RSS="$(grep 'maximum resident set size' "${TIME_LOG}" | awk '{print $1}')"

CPU_PCT="$(awk -v u="${USER_CPU_SEC}" -v s="${SYS_CPU_SEC}" -v w="${WALL_SEC}" \
    'BEGIN { if (w > 0) { printf "%.2f", (u + s) / w * 100 } else { print "0.00" } }')"

echo "=================================================="
echo "wall_sec=${WALL_SEC}"
echo "user_cpu_sec=${USER_CPU_SEC}"
echo "sys_cpu_sec=${SYS_CPU_SEC}"
echo "cpu_pct=${CPU_PCT}"
echo "peak_rss=${PEAK_RSS}"
echo "max_threads=${MAX_THREADS}"
echo "rtf=${RTF}"
echo "audio_sec=${AUDIO_SEC}"
echo "threads_requested=${THREADS}"
