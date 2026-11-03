#!/usr/bin/env bash
# Qwen must not be treated as downloaded unless both GGUF shards exist and
# each is at least the size published on Hugging Face.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/scripts/download-models.sh"
SHARD1_MIN=3993201344
SHARD2_MIN=689872288
SHARD1_NAME="qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf"
SHARD2_NAME="qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf"
DIR_NAME="qwen2.5-7b-instruct"

failures=0
sandboxes=()

pass() { printf 'PASS %s\n' "$1"; }
fail() {
  printf 'FAIL %s\n' "$1"
  if [[ -n "${2:-}" ]]; then
    printf '%s\n' "$2"
  fi
  failures=$((failures + 1))
}

cleanup() {
  if [[ ${#sandboxes[@]} -gt 0 ]]; then
    rm -rf "${sandboxes[@]}"
  fi
}
trap cleanup EXIT

new_sandbox() {
  local d
  d="$(mktemp -d)"
  mkdir -p "$d/scripts" "$d/bin" "$d/home"
  cp "$SRC" "$d/scripts/download-models.sh"
  # Real curl -o truncates the destination before any byte arrives.
  # -C - resumes instead. The stub does both, so a finished shard that is
  # passed to curl shows up shorter on disk as well as in the log.
  cat >"$d/bin/curl" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>"${CURL_LOG:?}"
out=""
resume=0
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then
    out=$arg
  fi
  if [ "$prev" = "-C" ] && [ "$arg" = "-" ]; then
    resume=1
  fi
  case "$arg" in
    -C-) resume=1 ;;
  esac
  prev=$arg
done
if [ -n "$out" ]; then
  if [ "$resume" -eq 0 ]; then
    : >"$out"
  fi
  printf x >>"$out"
fi
exit 0
EOF
  chmod +x "$d/bin/curl" "$d/scripts/download-models.sh"
  sandboxes+=("$d")
  printf '%s' "$d"
}

write_shard() {
  local path="$1" size="$2"
  mkdir -p "$(dirname "$path")"
  rm -f "$path"
  truncate -s "$size" "$path"
}

run_qwen() {
  local root="$1" dest="$2"
  shift 2
  local log out status
  log="$(mktemp)"
  set +e
  out="$(
    CURL_LOG="$log" \
      PATH="$root/bin:$PATH" \
      HOME="$root/home" \
      OLLAMA_MODELS="$root/missing-ollama" \
      timeout 20s bash "$root/scripts/download-models.sh" --dest "$dest" --only qwen "$@" 2>&1
  )"
  status=$?
  set -e
  RUN_OUT="$out"
  RUN_STATUS="$status"
  RUN_CURL="$(cat "$log" 2>/dev/null || true)"
  rm -f "$log"
}

assert_fetches() {
  local name="$1"
  if [[ "$RUN_OUT" != *"Fetching Qwen2.5-7B-Instruct GGUF"* ]]; then
    fail "$name should fetch the missing shard" "$RUN_OUT"
    return
  fi
  if [[ "$RUN_OUT" == *"SKIP (already present"* || "$RUN_OUT" == *"Not re-downloading"* ]]; then
    fail "$name should not treat a partial Qwen download as present" "$RUN_OUT"
    return
  fi
  if [[ "$RUN_CURL" != *"-fSL"* ]]; then
    fail "$name should download with curl" "$RUN_CURL"
    return
  fi
  if [[ "$RUN_STATUS" -eq 124 || "$RUN_STATUS" -eq 137 ]]; then
    fail "$name timed out" "$RUN_OUT"
    return
  fi
  pass "$name"
}

assert_skips() {
  local name="$1"
  if [[ "$RUN_OUT" != *"SKIP (already present"* ]]; then
    fail "$name should skip a complete Qwen download" "$RUN_OUT"
    return
  fi
  if [[ "$RUN_OUT" == *"Fetching Qwen2.5-7B-Instruct GGUF"* ]]; then
    fail "$name should not fetch" "$RUN_OUT"
    return
  fi
  if [[ -n "$RUN_CURL" ]]; then
    fail "$name should not call curl" "$RUN_CURL"
    return
  fi
  pass "$name"
}

assert_legacy_hint() {
  local name="$1"
  if [[ "$RUN_OUT" != *"Found existing"* || "$RUN_OUT" != *"Not re-downloading"* ]]; then
    fail "$name should point at the legacy copy" "$RUN_OUT"
    return
  fi
  if [[ -n "$RUN_CURL" ]]; then
    fail "$name should not download over a complete legacy copy" "$RUN_CURL"
    return
  fi
  pass "$name"
}

# --check lists both shards and fails when the second one is absent.
root="$(new_sandbox)"
dest="$root/out"
write_shard "$dest/$DIR_NAME/$SHARD1_NAME" 32
set +e
check_out="$(timeout 20s bash "$root/scripts/download-models.sh" --dest "$dest" --check 2>&1)"
check_status=$?
set -e
if [[ "$check_out" != *"$SHARD1_NAME"* || "$check_out" != *"$SHARD2_NAME"* ]]; then
  fail "--check should list both Qwen shards" "$check_out"
elif [[ "$check_status" -eq 0 ]]; then
  fail "--check should fail when the second Qwen shard is missing" "$check_out"
else
  pass "--check lists both Qwen shards"
fi

# Part 1 alone is not a finished download.
root="$(new_sandbox)"
dest="$root/out"
write_shard "$dest/$DIR_NAME/$SHARD1_NAME" "$SHARD1_MIN"
run_qwen "$root" "$dest"
assert_fetches "part 1 alone is not skipped"

# Both names exist, but part 1 is one byte short of the published size.
root="$(new_sandbox)"
dest="$root/out"
write_shard "$dest/$DIR_NAME/$SHARD1_NAME" $((SHARD1_MIN - 1))
write_shard "$dest/$DIR_NAME/$SHARD2_NAME" "$SHARD2_MIN"
run_qwen "$root" "$dest"
assert_fetches "undersized part 1 is not skipped"

# Part 2 one byte short.
root="$(new_sandbox)"
dest="$root/out"
write_shard "$dest/$DIR_NAME/$SHARD1_NAME" "$SHARD1_MIN"
write_shard "$dest/$DIR_NAME/$SHARD2_NAME" $((SHARD2_MIN - 1))
run_qwen "$root" "$dest"
assert_fetches "undersized part 2 is not skipped"

# A finished part 1 must not be passed to curl while part 2 is still short.
# curl -o would truncate that finished shard.
root="$(new_sandbox)"
dest="$root/out"
write_shard "$dest/$DIR_NAME/$SHARD1_NAME" "$SHARD1_MIN"
write_shard "$dest/$DIR_NAME/$SHARD2_NAME" $((SHARD2_MIN - 1))
run_qwen "$root" "$dest"
part1_size="$(wc -c <"$dest/$DIR_NAME/$SHARD1_NAME" | tr -d '[:space:]')"
part2_size="$(wc -c <"$dest/$DIR_NAME/$SHARD2_NAME" | tr -d '[:space:]')"
if [[ "$RUN_CURL" == *"$SHARD1_NAME"* ]]; then
  fail "finished part 1 must be absent from the curl log when part 2 is short" "$RUN_CURL"
elif [[ "$part1_size" != "$SHARD1_MIN" ]]; then
  fail "finished part 1 must keep its published size" "size=$part1_size"
elif [[ "$RUN_CURL" != *"$SHARD2_NAME"* ]]; then
  fail "short part 2 must be downloaded" "$RUN_CURL"
elif [[ "$RUN_CURL" != -q\ * ]]; then
  fail "curl must be invoked with -q first" "$RUN_CURL"
elif [[ "$RUN_CURL" != *"--proto =https"* || "$RUN_CURL" != *"--proto-redir =https"* ]]; then
  fail "curl must allow only https" "$RUN_CURL"
elif [[ "$RUN_CURL" != *"-C -"* || "$RUN_CURL" != *"--retry 3"* || "$RUN_CURL" != *"--retry-delay 2"* ]]; then
  fail "short part 2 must resume with retries" "$RUN_CURL"
elif [[ "$part2_size" -lt $((SHARD2_MIN - 1)) ]]; then
  fail "resuming part 2 must not truncate it" "size=$part2_size"
else
  pass "finished part 1 is not re-downloaded when part 2 is short"
fi

# A partial destination is resumed even when a complete legacy copy exists.
root="$(new_sandbox)"
dest="$root/out"
write_shard "$dest/$DIR_NAME/$SHARD1_NAME" "$SHARD1_MIN"
write_shard "$root/models/$DIR_NAME/$SHARD1_NAME" "$SHARD1_MIN"
write_shard "$root/models/$DIR_NAME/$SHARD2_NAME" "$SHARD2_MIN"
run_qwen "$root" "$dest"
assert_fetches "partial destination is not abandoned for a legacy copy"

# An incomplete legacy copy is not a reason to skip the download.
root="$(new_sandbox)"
dest="$root/out"
write_shard "$root/models/$DIR_NAME/$SHARD1_NAME" "$SHARD1_MIN"
run_qwen "$root" "$dest"
assert_fetches "incomplete legacy copy is not skipped"

# Both shards at the published size: skip, and do not call curl.
root="$(new_sandbox)"
dest="$root/out"
write_shard "$dest/$DIR_NAME/$SHARD1_NAME" "$SHARD1_MIN"
write_shard "$dest/$DIR_NAME/$SHARD2_NAME" "$SHARD2_MIN"
run_qwen "$root" "$dest"
assert_skips "both shards at the published size are skipped"

# A complete legacy copy is relocated with --migrate and not re-downloaded.
root="$(new_sandbox)"
dest="$root/out"
write_shard "$root/models/$DIR_NAME/$SHARD1_NAME" "$SHARD1_MIN"
write_shard "$root/models/$DIR_NAME/$SHARD2_NAME" "$SHARD2_MIN"
run_qwen "$root" "$dest" --migrate
if [[ ! -f "$dest/$DIR_NAME/$SHARD1_NAME" || ! -f "$dest/$DIR_NAME/$SHARD2_NAME" ]]; then
  fail "--migrate should move both Qwen shards" "$RUN_OUT"
elif [[ -e "$root/models/$DIR_NAME" ]]; then
  fail "--migrate should remove the legacy Qwen directory" "$RUN_OUT"
elif [[ -n "$RUN_CURL" ]]; then
  fail "--migrate should not download" "$RUN_CURL"
else
  pass "--migrate moves a complete legacy Qwen download"
fi

# A complete legacy copy without --migrate prints the relocation hint.
root="$(new_sandbox)"
dest="$root/out"
write_shard "$root/models/$DIR_NAME/$SHARD1_NAME" "$SHARD1_MIN"
write_shard "$root/models/$DIR_NAME/$SHARD2_NAME" "$SHARD2_MIN"
run_qwen "$root" "$dest"
assert_legacy_hint "complete legacy copy prints a relocation hint"

if [[ "$failures" -ne 0 ]]; then
  printf '%s failing check(s)\n' "$failures"
  exit 1
fi
printf 'ok\n'
