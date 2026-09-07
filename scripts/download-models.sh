#!/usr/bin/env bash
# Fetches the local models Myna needs: Parakeet STT (v3), Qwen2.5-7B-Instruct
# GGUF, and the silero VAD ONNX model. Idempotent: re-running skips any
# artifact whose marker file already exists on disk.
#
# Downloads to the fixed models location `~/myna/models` by default
# (matching `paths::models_root()` in release builds), overridable via
# `MYNA_MODELS_DIR` or `--dest` only. `MYNA_DATA_DIR` and the Settings
# storage location never affect this destination — they move
# meetings/preferences/folders only.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Fixed models root: MYNA_MODELS_DIR wins when set, else ~/myna/models.
# MYNA_DATA_DIR never applies here — it moves meetings only.
DEFAULT_DEST="${MYNA_MODELS_DIR:-$HOME/myna/models}"
LEGACY_DEST="$REPO_ROOT/models"

PARAKEET_DIR_NAME="parakeet-tdt-0.6b-v3-int8"
PARAKEET_MARKER_NAME="encoder.int8.onnx"

QWEN_DIR_NAME="qwen2.5-7b-instruct"
QWEN_MARKER_NAME="qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf"
QWEN_MARKER_NAME_2="qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf"

VAD_DIR_NAME="silero-vad"
VAD_MARKER_NAME="silero_vad.onnx"

# Optional: speaker diarization (segmentation + speaker embedding). Not
# fetched by default — pass `--only diarization` to fetch both. The app
# works without them, degrading to unlabelled speakers.
PYANNOTE_DIR_NAME="pyannote-segmentation-3-0"
PYANNOTE_MARKER_NAME="sherpa-onnx-pyannote-segmentation-3-0/model.int8.onnx"

TITANET_DIR_NAME="nemo-titanet"
TITANET_MARKER_NAME="nemo_en_titanet_small.onnx"

# Optional (experimental) alternative speaker embedding: ERes2Net/ECAPA via
# sherpa-onnx Wespeaker release. NOT the default embedding model — TitaNet
# remains the default (no default-model switch yet; A/B decides later).
# NOTE: sherpa-onnx Wespeaker release asset name is UNCONFIRMED. If the URL
# 404s, fetch_eres2net skips soft (keeps TitaNet) instead of failing the run.
# Only MIT/Apache-2.0 licensed artifacts may be vendored; anything else
# aborts the ERes2Net fetch and keeps TitaNet.
ERES2NET_DIR_NAME="wespeaker-eres2net"
ERES2NET_MARKER_NAME="sherpa-onnx-wespeaker-eres2net/model.onnx"
ERES2NET_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/sherpa-onnx-wespeaker-eres2net.tar.bz2"

usage() {
  cat <<'EOF'
Usage: scripts/download-models.sh [--dest <dir>]
                                   [--only parakeet|qwen|vad|diarization]
                                   [--migrate] [--check] [--help]

Fetches local models into <dest> (default: $MYNA_MODELS_DIR, or ~/myna/models
if that's unset — the fixed location the packaged app reads from).
MYNA_DATA_DIR and the Settings storage location never affect <dest>;
they move meetings/preferences/folders only:
  - Parakeet STT v3 (sherpa-onnx, int8)
  - Qwen2.5-7B-Instruct GGUF (Q4_K_M)
  - silero VAD (ONNX)
  - [optional] speaker diarization: pyannote segmentation-3-0 + NeMo TitaNet
    speaker embedding. Only needed for speaker labels/detection; the app
    works fine without them, degrading to unlabelled speakers. NOT fetched
    by default — pass `--only diarization` to fetch both (they are useless
    apart). `--only diarization` also attempts the experimental Wespeaker
    ERes2Net alternative embedding (fail-soft: skipped with a message when
    its release URL 404s; only MIT/Apache-2.0 licensed artifacts vendored,
    LICENSE preserved as evidence; TitaNet stays the default).

Idempotent: already-present artifacts (detected via marker file) are skipped.

If an artifact is already present under the repo's own models/ directory
(the pre-migration layout) but missing from <dest>, this script will NOT
re-download it or duplicate the ~5.4 GB of weights. Instead it prints the
exact `mv`/`ln -s` command to relocate it — or performs the move itself when
--migrate is given.

Options:
  --dest <dir>                 Destination directory (default:
                                $MYNA_MODELS_DIR, else ~/myna/models).
  --only parakeet|qwen|vad|diarization
                                Fetch a single artifact (or, for
                                "diarization", both optional speaker models
                                together) instead of the default set.
  --migrate                     When an artifact exists under the repo's
                                models/ dir but not <dest>, move it into
                                <dest> instead of just printing the command.
  --check                       Report presence of all artifacts (including
                                the optional diarization models) under
                                <dest>; exit non-zero if any REQUIRED
                                artifact is missing. Fetches and migrates
                                nothing.
  --help                        Show this help and exit.
EOF
}

# marker_path <dest> <dir_name> <marker_name>
marker_path() {
  echo "$1/$2/$3"
}

# migration_hint prints the exact relocation commands for one artifact
# whose weights already exist in the repo's legacy models/ dir.
# migration_hint <name> <legacy_dir> <dest_dir>
migration_hint() {
  local name="$1" legacy_dir="$2" dest_dir="$3"
  echo "Found existing $name weights at: $legacy_dir"
  echo "  Not re-downloading or duplicating them. To relocate (recommended):"
  echo "    mkdir -p \"$(dirname "$dest_dir")\""
  echo "    mv \"$legacy_dir\" \"$dest_dir\""
  echo "  Or, to keep using the repo copy without moving it:"
  echo "    mkdir -p \"$(dirname "$dest_dir")\""
  echo "    ln -s \"$legacy_dir\" \"$dest_dir\""
  echo "  Re-run this script (or pass --migrate) afterwards."
}

# migrate_artifact moves a legacy artifact directory into <dest>, only when
# <dest> doesn't already have it. Never deletes/duplicates data blindly.
# migrate_artifact <legacy_dir> <dest_dir>
migrate_artifact() {
  local legacy_dir="$1" dest_dir="$2"
  if [[ -e "$dest_dir" ]]; then
    echo "SKIP migrate (already present at destination: $dest_dir)"
    return 0
  fi
  mkdir -p "$(dirname "$dest_dir")"
  echo "Moving $legacy_dir -> $dest_dir"
  mv "$legacy_dir" "$dest_dir"
}

# fetch_artifact orchestrates the marker/legacy/migrate/download decision
# for a single artifact.
# fetch_artifact <name> <dir_name> <marker_name> <fetch_cmd...>
fetch_artifact() {
  local name="$1" dir_name="$2" marker_name="$3"
  shift 3
  local dest_dir="$DEST/$dir_name"
  local dest_marker
  dest_marker="$(marker_path "$DEST" "$dir_name" "$marker_name")"
  local legacy_dir="$LEGACY_DEST/$dir_name"
  local legacy_marker
  legacy_marker="$(marker_path "$LEGACY_DEST" "$dir_name" "$marker_name")"

  if [[ -e "$dest_marker" ]]; then
    echo "SKIP (already present: $dest_marker) - $name"
    return 0
  fi

  if [[ "$dest_dir" != "$legacy_dir" && -e "$legacy_marker" ]]; then
    if [[ "$migrate" -eq 1 ]]; then
      migrate_artifact "$legacy_dir" "$dest_dir"
    else
      migration_hint "$name" "$legacy_dir" "$dest_dir"
    fi
    return 0
  fi

  echo "Fetching $name ..."
  "$@"
}

fetch_parakeet() {
  fetch_artifact "Parakeet STT v3" "$PARAKEET_DIR_NAME" "$PARAKEET_MARKER_NAME" \
    bash -c '
      set -euo pipefail
      dest_dir="$1"; base_url="$2"
      mkdir -p "$dest_dir"
      for f in encoder.int8.onnx decoder.int8.onnx joiner.int8.onnx tokens.txt; do
        curl -fSL -o "$dest_dir/$f" "$base_url/$f"
      done
    ' _ \
    "$DEST/$PARAKEET_DIR_NAME" \
    "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main"
}

fetch_qwen() {
  fetch_artifact "Qwen2.5-7B-Instruct GGUF" "$QWEN_DIR_NAME" "$QWEN_MARKER_NAME" \
    bash -c '
      set -euo pipefail
      dest_dir="$1"; base_url="$2"
      mkdir -p "$dest_dir"
      for f in qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf \
               qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf; do
        curl -fSL -o "$dest_dir/$f" "$base_url/$f"
      done
    ' _ \
    "$DEST/$QWEN_DIR_NAME" \
    "https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main"
}

fetch_vad() {
  fetch_artifact "silero VAD" "$VAD_DIR_NAME" "$VAD_MARKER_NAME" \
    bash -c 'mkdir -p "$(dirname "$1")" && curl -fSL -o "$1" "$2"' _ \
    "$DEST/$VAD_DIR_NAME/$VAD_MARKER_NAME" \
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx"
}

# fetch_pyannote downloads and extracts the pyannote speaker-segmentation
# tarball. Preserves the extracted LICENSE file alongside model.int8.onnx —
# that's the licence evidence (MIT, CNRS) and must not be deleted.
fetch_pyannote() {
  fetch_artifact "pyannote speaker segmentation (diarization, optional)" \
    "$PYANNOTE_DIR_NAME" "$PYANNOTE_MARKER_NAME" \
    bash -c '
      set -euo pipefail
      dest_dir="$1"; url="$2"
      mkdir -p "$dest_dir"
      tarball="$dest_dir/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
      curl -fSL -o "$tarball" "$url"
      tar -xjf "$tarball" -C "$dest_dir"
    ' _ \
    "$DEST/$PYANNOTE_DIR_NAME" \
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
}

# fetch_titanet downloads the NeMo TitaNet speaker-embedding model (bare
# .onnx, no archive).
fetch_titanet() {
  fetch_artifact "NeMo TitaNet speaker embedding (diarization, optional)" \
    "$TITANET_DIR_NAME" "$TITANET_MARKER_NAME" \
    bash -c 'mkdir -p "$(dirname "$1")" && curl -fSL -o "$1" "$2"' _ \
    "$DEST/$TITANET_DIR_NAME/$TITANET_MARKER_NAME" \
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx"
}

# fetch_eres2net downloads and extracts the Wespeaker ERes2Net/ECAPA speaker-
# embedding tarball, mirroring fetch_pyannote (mkdir, curl, tar extract, keep
# LICENSE). License gate: the extracted LICENSE file must mention MIT or
# Apache-2.0, otherwise the fetch aborts (partial output removed) and TitaNet
# stays the default embedding model. The LICENSE file is license evidence
# and must not be deleted. Fail-soft on HTTP 404 (uncertain release URL):
# prints a message, keeps TitaNet, exits 0.
fetch_eres2net() {
  fetch_artifact "Wespeaker ERes2Net speaker embedding (diarization, optional, experimental)" \
    "$ERES2NET_DIR_NAME" "$ERES2NET_MARKER_NAME" \
    bash -c '
      set -euo pipefail
      dest_dir="$1"; url="$2"
      mkdir -p "$dest_dir"
      tarball="$dest_dir/sherpa-onnx-wespeaker-eres2net.tar.bz2"
      if ! curl -fSL -o "$tarball" "$url"; then
        status=$?
        echo "SKIP ERes2Net (download unavailable at $url, curl exit $status) - keeping NeMo TitaNet default" >&2
        rm -f "$tarball"
        exit 0
      fi
      tar -xjf "$tarball" -C "$dest_dir"
      # License gate: preserve LICENSE as evidence; only MIT/Apache-2.0 may be vendored.
      license_file="$(find "$dest_dir" -maxdepth 2 -iname "LICENSE*" -print -quit)"
      if [[ -z "${license_file:-}" ]]; then
        echo "ERROR: ERes2Net tarball contains no LICENSE file - aborting ERes2Net fetch, keeping NeMo TitaNet default" >&2
        rm -rf "$dest_dir/sherpa-onnx-wespeaker-eres2net"
        rm -f "$tarball"
        exit 1
      fi
      if ! grep -qiE "MIT license|Apache(-2\.0| License.*2\.0)" "$license_file"; then
        echo "ERROR: ERes2Net license is not MIT/Apache-2.0 (see $license_file) - aborting ERes2Net fetch, keeping NeMo TitaNet default" >&2
        rm -rf "$dest_dir/sherpa-onnx-wespeaker-eres2net"
        rm -f "$tarball"
        exit 1
      fi
      echo "ERes2Net license evidence preserved at: $license_file"
    ' _ \
    "$DEST/$ERES2NET_DIR_NAME" \
    "$ERES2NET_URL"
}

human_size() {
  local path="$1"
  if [[ -e "$path" ]]; then
    du -h "$path" 2>/dev/null | cut -f1
  else
    echo "MISSING"
  fi
}

print_summary() {
  echo
  echo "Model summary (dest: $DEST):"
  printf '  %-24s %s (%s)\n' "Parakeet STT v3" \
    "$(human_size "$(marker_path "$DEST" "$PARAKEET_DIR_NAME" "$PARAKEET_MARKER_NAME")")" \
    "$(marker_path "$DEST" "$PARAKEET_DIR_NAME" "$PARAKEET_MARKER_NAME")"
  printf '  %-24s %s (%s)\n' "Qwen2.5-7B-Instruct" \
    "$(human_size "$(marker_path "$DEST" "$QWEN_DIR_NAME" "$QWEN_MARKER_NAME")")" \
    "$(marker_path "$DEST" "$QWEN_DIR_NAME" "$QWEN_MARKER_NAME")"
  printf '  %-24s %s (%s)\n' "silero VAD" \
    "$(human_size "$(marker_path "$DEST" "$VAD_DIR_NAME" "$VAD_MARKER_NAME")")" \
    "$(marker_path "$DEST" "$VAD_DIR_NAME" "$VAD_MARKER_NAME")"
  printf '  %-24s %s (%s) [optional: speaker diarization]\n' "pyannote segmentation" \
    "$(human_size "$(marker_path "$DEST" "$PYANNOTE_DIR_NAME" "$PYANNOTE_MARKER_NAME")")" \
    "$(marker_path "$DEST" "$PYANNOTE_DIR_NAME" "$PYANNOTE_MARKER_NAME")"
  printf '  %-24s %s (%s) [optional: speaker diarization]\n' "NeMo TitaNet" \
    "$(human_size "$(marker_path "$DEST" "$TITANET_DIR_NAME" "$TITANET_MARKER_NAME")")" \
    "$(marker_path "$DEST" "$TITANET_DIR_NAME" "$TITANET_MARKER_NAME")"
  printf '  %-24s %s (%s) [optional/experimental: speaker diarization alternative]\n' "Wespeaker ERes2Net" \
    "$(human_size "$(marker_path "$DEST" "$ERES2NET_DIR_NAME" "$ERES2NET_MARKER_NAME")")" \
    "$(marker_path "$DEST" "$ERES2NET_DIR_NAME" "$ERES2NET_MARKER_NAME")"
  echo
  echo "Parakeet weights are distributed under CC-BY-4.0. If you use or"
  echo "redistribute them, provide attribution to NVIDIA NeMo Parakeet-TDT"
  echo "and the sherpa-onnx project (csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8)."
  echo
  echo "Speaker diarization models (pyannote segmentation, NeMo TitaNet) are"
  echo "OPTIONAL — only needed for speaker labels/detection. The app works"
  echo "fully without them, degrading to unlabelled speakers. Fetch with:"
  echo "  scripts/download-models.sh --only diarization"
  echo
  echo "Wespeaker ERes2Net/ECAPA embedding is OPTIONAL and EXPERIMENTAL — an"
  echo "alternative to the default NeMo TitaNet embedding (no default switch"
  echo "yet). Fetched alongside --only diarization when its release URL is"
  echo "reachable (fail-soft 404 keeps TitaNet). Only MIT/Apache-2.0 licensed"
  echo "artifacts are vendored; the extracted LICENSE file is preserved as"
  echo "evidence alongside the model."
}

run_check() {
  local missing=0
  for marker in \
    "$(marker_path "$DEST" "$PARAKEET_DIR_NAME" "$PARAKEET_MARKER_NAME")" \
    "$(marker_path "$DEST" "$QWEN_DIR_NAME" "$QWEN_MARKER_NAME")" \
    "$(marker_path "$DEST" "$QWEN_DIR_NAME" "$QWEN_MARKER_NAME_2")" \
    "$(marker_path "$DEST" "$VAD_DIR_NAME" "$VAD_MARKER_NAME")"; do
    if [[ -e "$marker" ]]; then
      echo "OK    $marker"
    else
      echo "MISSING $marker"
      missing=1
    fi
  done
  # Optional diarization artifacts: reported, but never fail --check — the
  # app works without them (degrades to unlabelled speakers).
  for marker in \
    "$(marker_path "$DEST" "$PYANNOTE_DIR_NAME" "$PYANNOTE_MARKER_NAME")" \
    "$(marker_path "$DEST" "$TITANET_DIR_NAME" "$TITANET_MARKER_NAME")" \
    "$(marker_path "$DEST" "$ERES2NET_DIR_NAME" "$ERES2NET_MARKER_NAME")"; do
    if [[ -e "$marker" ]]; then
      echo "OK    $marker (optional — speaker diarization)"
    else
      echo "MISSING $marker (optional — speaker diarization; app works without it)"
    fi
  done
  return "$missing"
}

DEST="$DEFAULT_DEST"
only=""
check_only=0
migrate=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dest)
      DEST="${2:-}"
      if [[ -z "$DEST" ]]; then
        echo "ERROR: --dest requires an argument" >&2
        exit 1
      fi
      shift 2
      ;;
    --only)
      only="${2:-}"
      if [[ -z "$only" ]]; then
        echo "ERROR: --only requires an argument (parakeet|qwen|vad|diarization)" >&2
        exit 1
      fi
      shift 2
      ;;
    --migrate)
      migrate=1
      shift
      ;;
    --check)
      check_only=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

# Resolve DEST to an absolute path (may not exist yet) so downstream
# comparisons against LEGACY_DEST are reliable regardless of cwd.
case "$DEST" in
  /*) ;;
  *) DEST="$(pwd)/$DEST" ;;
esac

if [[ "$check_only" -eq 1 ]]; then
  run_check
  exit $?
fi

case "$only" in
  "")
    fetch_parakeet
    fetch_qwen
    fetch_vad
    ;;
  parakeet)
    fetch_parakeet
    ;;
  qwen)
    fetch_qwen
    ;;
  vad)
    fetch_vad
    ;;
  diarization)
    fetch_pyannote
    fetch_titanet
    fetch_eres2net
    ;;
  *)
    echo "ERROR: invalid --only value: $only (expected parakeet|qwen|vad|diarization)" >&2
    exit 1
    ;;
esac

print_summary
