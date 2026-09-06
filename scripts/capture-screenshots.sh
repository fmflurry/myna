#!/usr/bin/env bash
#
# capture-screenshots.sh — serve ui/ and capture the 5 README showcase PNGs.
#
# No models, no microphone, no Tauri/Rust required: screenshots come from the
# Angular dev server plus the screenshot harness at
#   http://localhost:<port>/?screenshot=<scene>
# (see ui/src/app/screenshot/*), rendered with the known-good Playwright
# chrome-headless-shell binary.
#
# Scenes (all states of the single-window MeetingsShellPage, not routes):
#   hero | recording | transcription | summaries | library
#
# Usage:
#   ./scripts/capture-screenshots.sh [--port <port>]
#   PORT=4210 ./scripts/capture-screenshots.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UI_DIR="${REPO_ROOT}/ui"
SCREENSHOT_DIR="${REPO_ROOT}/docs/screenshots"

PORT="${PORT:-4209}"
TIMEOUT_MS="${SCREENSHOT_TIMEOUT_MS:-30000}"
VIRTUAL_TIME_BUDGET_MS="${SCREENSHOT_VIRTUAL_TIME_BUDGET_MS:-10000}"

if [ "${1:-}" = "--port" ]; then
  PORT="${2:-}"
  if [ -z "${PORT}" ]; then
    echo "error: --port requires a value" >&2
    exit 1
  fi
  shift 2
fi
if [ "$#" -gt 0 ]; then
  echo "error: unexpected arguments: $*" >&2
  echo "usage: $(basename "${BASH_SOURCE[0]}") [--port <port>]" >&2
  exit 1
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/myna-screenshots.XXXXXX")"
SERVER_LOG="${WORK_DIR}/ng-serve.log"
SERVER_PID=""

cleanup() {
  if [ -n "${SERVER_PID}" ] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    kill "${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
  fi
  rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

require_tool() {
  local name="$1"
  local path="$2"
  if [ ! -x "${path}" ]; then
    echo "error: required tool '${name}' not found or not executable at: ${path}" >&2
    exit 1
  fi
}

find_chrome_headless_shell() {
  local candidate
  candidate="$(find "${HOME}/Library/Caches/ms-playwright" -maxdepth 2 -type d -name 'chromium_headless_shell-*' 2>/dev/null | sort -V | tail -n 1)"
  if [ -z "${candidate}" ]; then
    return 1
  fi
  find "${candidate}" -type f -name 'chrome-headless-shell' 2>/dev/null | head -n 1
}

if ! command -v node >/dev/null 2>&1; then
  echo "error: node not found on PATH (needed to run the Angular dev server)" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "error: npm not found on PATH (needed to run the Angular dev server)" >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "error: curl not found on PATH (needed for the dev-server ready check)" >&2
  exit 1
fi

CHROME_HEADLESS_SHELL="$(find_chrome_headless_shell || true)"
if [ -z "${CHROME_HEADLESS_SHELL}" ]; then
  echo "error: could not locate a Playwright chrome-headless-shell binary under" >&2
  echo "       ${HOME}/Library/Caches/ms-playwright" >&2
  echo "       install Playwright's chromium headless shell (npx playwright install chromium-headless-shell)" >&2
  exit 1
fi
require_tool "chrome-headless-shell" "${CHROME_HEADLESS_SHELL}"

mkdir -p "${SCREENSHOT_DIR}"

# Clean-checkout support: install UI deps when node_modules is absent.
# No model downloads, no Tauri build — just the npm dependency tree.
if [ ! -d "${UI_DIR}/node_modules" ]; then
  echo "==> Installing ui/ dependencies (clean checkout, no models required)"
  if [ -f "${UI_DIR}/package-lock.json" ]; then
    ( cd "${UI_DIR}" && npm ci )
  else
    ( cd "${UI_DIR}" && npm install )
  fi
fi

echo "==> Starting Angular dev server on port ${PORT}"
( cd "${REPO_ROOT}" && npm --prefix ui run start -- --port "${PORT}" >"${SERVER_LOG}" 2>&1 & echo $! >"${WORK_DIR}/server.pid" )
SERVER_PID="$(cat "${WORK_DIR}/server.pid")"

echo "==> Waiting for dev server at http://localhost:${PORT}/"
ready=0
for _ in $(seq 1 90); do
  if curl -fsS "http://localhost:${PORT}/" >/dev/null 2>&1; then
    ready=1
    break
  fi
  # Bail out early if the server died.
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    echo "error: Angular dev server exited during startup; last 30 lines of ${SERVER_LOG}:" >&2
    tail -n 30 "${SERVER_LOG}" >&2 || true
    exit 1
  fi
  sleep 1
done
if [ "${ready}" != "1" ]; then
  echo "error: dev server did not become ready at http://localhost:${PORT}/ within 90s" >&2
  echo "       last 30 lines of ${SERVER_LOG}:" >&2
  tail -n 30 "${SERVER_LOG}" >&2 || true
  exit 1
fi

capture_scene() {
  local scene="$1"
  local size="$2"
  local out="${SCREENSHOT_DIR}/${scene}.png"
  local url="http://localhost:${PORT}/?screenshot=${scene}"
  echo "==> Capturing ${scene} (${size}) -> ${out}"
  "${CHROME_HEADLESS_SHELL}" \
    --no-sandbox \
    --disable-gpu \
    --hide-scrollbars \
    --force-device-scale-factor=2 \
    --window-size="${size}" \
    --timeout="${TIMEOUT_MS}" \
    --virtual-time-budget="${VIRTUAL_TIME_BUDGET_MS}" \
    --user-data-dir="${WORK_DIR}/chrome-profile-${scene}" \
    --screenshot="${out}" \
    "${url}" >/dev/null 2>&1
  if [ ! -s "${out}" ]; then
    echo "error: screenshot for scene '${scene}' missing or empty: ${out}" >&2
    exit 1
  fi
}

# Hero is full-window 1280x800; cards render at 900x700 (README displays hero
# at 800 wide, cards at 400 wide).
capture_scene "hero" "1280,800"
capture_scene "recording" "900,700"
capture_scene "transcription" "900,700"
capture_scene "summaries" "900,700"
capture_scene "library" "900,700"

echo "==> Verifying ${SCREENSHOT_DIR}/*.png"
for png in "${SCREENSHOT_DIR}"/hero.png "${SCREENSHOT_DIR}"/recording.png "${SCREENSHOT_DIR}"/transcription.png "${SCREENSHOT_DIR}"/summaries.png "${SCREENSHOT_DIR}"/library.png; do
  if [ ! -s "${png}" ]; then
    echo "error: expected non-empty PNG missing: ${png}" >&2
    exit 1
  fi
done

echo "==> Done. Screenshots written to ${SCREENSHOT_DIR}"
