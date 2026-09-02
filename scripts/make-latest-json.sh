#!/usr/bin/env bash
# Generates and self-validates the static `latest.json` update manifest
# consumed by the Tauri updater plugin (see app/src-tauri/tauri.conf.json's
# plugins.updater.endpoints, which points at
# https://github.com/fmflurry/myna/releases/latest/download/latest.json).
#
# The manifest shape (version/notes/pub_date/platforms{url,signature}) and
# the RFC 3339 requirement on pub_date are fixed by the updater plugin's
# RemoteRelease deserializer — see docs/releasing-macos.md.
#
# Version is read from app/src-tauri/tauri.conf.json — the single source of
# truth — never from the git tag. The tag is instead checked *against* that
# version, so a mismatch (drift) fails loudly instead of silently publishing
# a manifest that advertises a version nobody built.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAURI_CONF="$REPO_ROOT/app/src-tauri/tauri.conf.json"

log() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nFAIL: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: make-latest-json.sh --app-tar-gz <path> [--tag <vX.Y.Z>] [--notes <text>] [--out <path>]

  --app-tar-gz   Path to the signed updater artifact (Myna.app.tar.gz).
                 Its sibling <path>.sig supplies the signature.
  --tag          Git tag being released, e.g. v0.1.0. Defaults to
                 $GITHUB_REF_NAME, then `git describe --tags --exact-match`.
                 Must equal "v<version>" read from tauri.conf.json.
  --notes        Release notes text. Defaults to a fixed pointer to the
                 GitHub release page for --tag.
  --out          Output path for latest.json. Defaults to the same
                 directory as --app-tar-gz.
EOF
}

APP_TAR_GZ=""
TAG="${GITHUB_REF_NAME:-}"
NOTES=""
OUT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --app-tar-gz) APP_TAR_GZ="${2:-}"; shift 2 ;;
    --tag) TAG="${2:-}"; shift 2 ;;
    --notes) NOTES="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; fail "Unknown argument: $1" ;;
  esac
done

[ -n "$APP_TAR_GZ" ] || { usage; fail "--app-tar-gz is required"; }
[ -f "$APP_TAR_GZ" ] || fail "Updater artifact not found: $APP_TAR_GZ"

SIG_PATH="$APP_TAR_GZ.sig"
[ -f "$SIG_PATH" ] || fail "Signature file not found: $SIG_PATH"

OUT="${OUT:-"$(dirname "$APP_TAR_GZ")/latest.json"}"

# --- 1. Version — single source of truth is tauri.conf.json ---------------
[ -f "$TAURI_CONF" ] || fail "tauri.conf.json not found at $TAURI_CONF"
VERSION="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['version'])" "$TAURI_CONF")"
[ -n "$VERSION" ] || fail "version read from $TAURI_CONF is empty"
log "Version (from tauri.conf.json): $VERSION"

# --- 2. Tag/version drift guard --------------------------------------------
if [ -z "$TAG" ]; then
  TAG="$(cd "$REPO_ROOT" && git describe --tags --exact-match 2>/dev/null || true)"
fi
[ -n "$TAG" ] || fail "Could not determine the tag being released (pass --tag, set \$GITHUB_REF_NAME, or run from an exact tag checkout)"
[ "$TAG" = "v$VERSION" ] || fail "Tag/version drift: tag is '$TAG' but tauri.conf.json version is '$VERSION' (expected tag 'v$VERSION')"
log "Tag matches version: $TAG"

# --- 3. Signature — whole content of the .sig file, verbatim --------------
SIGNATURE="$(cat "$SIG_PATH")"
[ -n "$SIGNATURE" ] || fail "$SIG_PATH is empty — cannot publish an unsigned updater manifest"
log "Signature loaded from $SIG_PATH (${#SIGNATURE} bytes)"

# --- 4. Notes ---------------------------------------------------------------
NOTES="${NOTES:-"See the release notes at https://github.com/fmflurry/myna/releases/tag/$TAG"}"

# --- 5. pub_date (RFC 3339) -------------------------------------------------
PUB_DATE="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
RFC3339_REGEX='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
[[ "$PUB_DATE" =~ $RFC3339_REGEX ]] || fail "Generated pub_date '$PUB_DATE' does not match RFC 3339"
log "pub_date: $PUB_DATE"

# --- 6. Platform key — determined empirically from the built binary -------
# Never assume darwin-aarch64 vs darwin-universal; inspect what tauri build
# actually produced. Getting this wrong makes the updater's check() silently
# find nothing for real users, with no error anywhere.
EXTRACT_DIR="$(mktemp -d -t myna-latest-json)"
trap 'rm -rf "$EXTRACT_DIR"' EXIT
tar xzf "$APP_TAR_GZ" -C "$EXTRACT_DIR"
APP_BUNDLE="$(find "$EXTRACT_DIR" -maxdepth 1 -name '*.app' | head -1)"
[ -n "$APP_BUNDLE" ] || fail "No .app bundle found inside $APP_TAR_GZ"

EXECUTABLE_NAME="$(python3 -c "import plistlib,sys; print(plistlib.load(open(sys.argv[1],'rb'))['CFBundleExecutable'])" "$APP_BUNDLE/Contents/Info.plist")"
EXECUTABLE_PATH="$APP_BUNDLE/Contents/MacOS/$EXECUTABLE_NAME"
[ -f "$EXECUTABLE_PATH" ] || fail "Main executable not found at $EXECUTABLE_PATH"

ARCHS="$(lipo -archs "$EXECUTABLE_PATH" 2>&1)" || fail "lipo -archs failed on $EXECUTABLE_PATH: $ARCHS"
log "Architectures in $EXECUTABLE_PATH: $ARCHS"

HAS_ARM64=0
HAS_X86_64=0
case " $ARCHS " in *" arm64 "*) HAS_ARM64=1 ;; esac
case " $ARCHS " in *" x86_64 "*) HAS_X86_64=1 ;; esac

if [ "$HAS_ARM64" -eq 1 ] && [ "$HAS_X86_64" -eq 1 ]; then
  PLATFORM_KEY="darwin-universal"
elif [ "$HAS_ARM64" -eq 1 ]; then
  PLATFORM_KEY="darwin-aarch64"
elif [ "$HAS_X86_64" -eq 1 ]; then
  PLATFORM_KEY="darwin-x86_64"
else
  fail "Unrecognized architecture set '$ARCHS' in $EXECUTABLE_PATH — expected arm64, x86_64, or both"
fi
log "Platform key (empirically determined): $PLATFORM_KEY"

URL="https://github.com/fmflurry/myna/releases/download/$TAG/Myna.app.tar.gz"

# --- 7. Emit + self-validate ------------------------------------------------
python3 - "$OUT" "$VERSION" "$NOTES" "$PUB_DATE" "$PLATFORM_KEY" "$URL" "$SIGNATURE" <<'PYEOF'
import json
import sys

out, version, notes, pub_date, platform_key, url, signature = sys.argv[1:8]

manifest = {
    "version": version,
    "notes": notes,
    "pub_date": pub_date,
    "platforms": {
        platform_key: {
            "url": url,
            "signature": signature,
        }
    },
}

with open(out, "w") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
PYEOF

[ -s "$OUT" ] || fail "Failed to write $OUT"
python3 -c "import json; json.load(open('$OUT'))" >/dev/null || fail "$OUT is not valid JSON"

log "Wrote $OUT"
log "Summary"
echo "  Version:      $VERSION"
echo "  Tag:          $TAG"
echo "  Platform key: $PLATFORM_KEY"
echo "  URL:          $URL"
echo "  pub_date:     $PUB_DATE"
echo "  Signature:    ${SIGNATURE:0:24}... (${#SIGNATURE} bytes)"
echo "  Output:       $OUT"
