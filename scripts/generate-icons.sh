#!/usr/bin/env bash
#
# generate-icons.sh — regenerate the macOS/Windows/Linux app icon set from the
# brand-kit SVG, respecting Apple's Big Sur+ icon safe area.
#
# Apple renders app icons on a 1024x1024 canvas but expects the visual content
# (the squircle) inset to roughly 80% of the canvas, i.e. an ~824x824 content
# area centred with a ~100px transparent margin on every side. Feeding a
# full-bleed 1024x1024 render straight into `tauri icon` produces a tile that
# looks oversized/heavier than neighbouring macOS apps in the Dock.
#
# Pipeline:
#   1. Render myna-brand-kit/myna-app-icon.svg at 824x824 (transparent bg).
#   2. Composite that render centred onto a fully transparent 1024x1024 canvas
#      (100px margin per side).
#   3. Feed the composited 1024x1024 PNG to `npx tauri icon` to regenerate the
#      full icon set in app/src-tauri/icons/.
#
# The source SVG (myna-app-icon.svg) already draws its own dark rounded-square
# background (#0F1115, rx=112 on a 512 viewBox) with the bird mark inside it.
# That means insetting the *whole* rendered square is correct: the result is a
# smaller squircle centred on transparency, exactly like other macOS app
# icons — not a glyph floating on empty canvas.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SVG_SRC="${REPO_ROOT}/myna-brand-kit/myna-app-icon.svg"
ICONS_DIR="${REPO_ROOT}/app/src-tauri/icons"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/myna-icon-gen.XXXXXX")"

CANVAS_SIZE=1024
CONTENT_SIZE=824
MARGIN=$(( (CANVAS_SIZE - CONTENT_SIZE) / 2 ))

CONTENT_PNG="${WORK_DIR}/content-${CONTENT_SIZE}.png"
FINAL_PNG="${WORK_DIR}/icon-source-${CANVAS_SIZE}.png"

cleanup() {
  rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

require_tool() {
  local name="$1"
  local path="$2"
  if [ ! -x "${path}" ]; then
    echo "error: required tool '${name}' not found or not executable at: ${path}" >&2
    echo "       install it or update the path in $(basename "${BASH_SOURCE[0]}")" >&2
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

MAGICK_BIN="$(command -v magick || true)"
if [ -z "${MAGICK_BIN}" ] && [ -x "/opt/homebrew/bin/magick" ]; then
  MAGICK_BIN="/opt/homebrew/bin/magick"
fi
require_tool "ImageMagick (magick)" "${MAGICK_BIN:-/nonexistent}"

CHROME_HEADLESS_SHELL="$(find_chrome_headless_shell || true)"
if [ -z "${CHROME_HEADLESS_SHELL}" ]; then
  echo "error: could not locate a Playwright chrome-headless-shell binary under" >&2
  echo "       ${HOME}/Library/Caches/ms-playwright" >&2
  echo "       install Playwright's chromium headless shell (npx playwright install chromium-headless-shell)" >&2
  exit 1
fi
require_tool "chrome-headless-shell" "${CHROME_HEADLESS_SHELL}"

if [ ! -f "${SVG_SRC}" ]; then
  echo "error: source SVG not found: ${SVG_SRC}" >&2
  exit 1
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "error: npx not found on PATH (needed to run 'tauri icon')" >&2
  exit 1
fi

echo "==> Rendering ${SVG_SRC} at ${CONTENT_SIZE}x${CONTENT_SIZE} (transparent background)"
"${CHROME_HEADLESS_SHELL}" \
  --no-sandbox \
  --disable-gpu \
  --window-size="${CONTENT_SIZE},${CONTENT_SIZE}" \
  --default-background-color=00000000 \
  --screenshot="${CONTENT_PNG}" \
  --user-data-dir="${WORK_DIR}/chrome-profile" \
  "file://${SVG_SRC}" >/dev/null 2>&1

if [ ! -s "${CONTENT_PNG}" ]; then
  echo "error: chrome-headless-shell did not produce a screenshot at ${CONTENT_PNG}" >&2
  exit 1
fi

echo "==> Compositing onto a ${CANVAS_SIZE}x${CANVAS_SIZE} transparent canvas (margin ${MARGIN}px per side)"
"${MAGICK_BIN}" -size "${CANVAS_SIZE}x${CANVAS_SIZE}" xc:none \
  "${CONTENT_PNG}" -geometry "+${MARGIN}+${MARGIN}" -composite \
  "${FINAL_PNG}"

echo "==> Generating icon set via tauri icon"
export PATH="${HOME}/.cargo/bin:${PATH}"
( cd "${REPO_ROOT}" && npx tauri icon "${FINAL_PNG}" --output "${ICONS_DIR}" )

echo "==> Done. Icons written to ${ICONS_DIR}"
