#!/usr/bin/env bash
# Builds, signs, and verifies the macOS release bundle for Myna.
#
# Signing identity resolution (first match wins):
#   1. APPLE_SIGNING_IDENTITY env var, if set.
#   2. The sole result of `security find-identity -v -p codesigning`, if
#      exactly one valid identity is installed.
#   3. Ad-hoc ("-"), with a loud warning: TCC grants (microphone) will NOT
#      survive rebuilds when signed this way. See docs/releasing-macos.md.
#
# When signing with a real identity, the app is re-signed after the initial
# `tauri build` with an explicit, pinned Designated Requirement (see
# app/src-tauri/Myna.requirements) naming the Apple Developer Team ID
# (APPLE_TEAM_ID), rather than trusting codesign's default DR — which would
# instead pin the certificate's Common Name, a value that changes on
# renewal. Once a signed build ships and users have granted TCC permissions,
# THIS EXPRESSION MUST NEVER CHANGE (see docs/releasing-macos.md).
#
# Notarization runs only when APPLE_ID, APPLE_PASSWORD, and APPLE_TEAM_ID are
# all present; otherwise it is skipped with a one-line notice. It is never
# required for this script to succeed.
set -euo pipefail

# --- Environment -------------------------------------------------------
export PATH="$HOME/.cargo/bin:$PATH"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAURI_DIR="$REPO_ROOT/app/src-tauri"
BUNDLE_DIR="$REPO_ROOT/target/release/bundle"
APP_PATH="$BUNDLE_DIR/macos/Myna.app"
DMG_DIR="$BUNDLE_DIR/dmg"
REQUIREMENTS_TEMPLATE="$TAURI_DIR/Myna.requirements"
BUNDLE_ID="app.myna.desktop"

CLEANUP_PATHS=()
cleanup() {
  for path in "${CLEANUP_PATHS[@]:-}"; do
    [ -n "$path" ] && rm -rf "$path" 2>/dev/null || true
  done
  if [ -n "${MOUNT_DIR:-}" ] && mount | grep -q "$MOUNT_DIR"; then
    hdiutil detach "$MOUNT_DIR" -quiet 2>/dev/null || true
  fi
}
trap cleanup EXIT

log() { printf '\n==> %s\n' "$*"; }
warn() { printf '\n!!! %s\n' "$*" >&2; }
fail() { printf '\nFAIL: %s\n' "$*" >&2; exit 1; }

# --- 1. Clean stale artifacts -------------------------------------------
# A prior `tauri build` once "succeeded" purely off a cached binary while the
# link step never ran. Never trust a leftover target/release tree.
log "Removing stale build artifacts"
rm -f "$REPO_ROOT/target/release/myna"
rm -rf "$BUNDLE_DIR"

if [ ! -d "$HOME/myna/models" ]; then
  warn "$HOME/myna/models does not exist — the packaged app will report every model missing at runtime."
fi

# --- 2. Resolve signing identity ----------------------------------------
log "Resolving signing identity"
IDENTITY=""
IDENTITY_SOURCE=""

if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
  IDENTITY="$APPLE_SIGNING_IDENTITY"
  IDENTITY_SOURCE="APPLE_SIGNING_IDENTITY env var"
else
  IDENTITY_LINES="$(security find-identity -v -p codesigning | grep -E '^[[:space:]]*[0-9]+\)' || true)"
  IDENTITY_COUNT="$(printf '%s\n' "$IDENTITY_LINES" | grep -c . || true)"

  if [ "$IDENTITY_COUNT" -eq 1 ]; then
    IDENTITY="$(printf '%s\n' "$IDENTITY_LINES" | sed -E 's/.*"([^"]+)".*/\1/')"
    IDENTITY_SOURCE="sole codesigning identity in keychain"
  else
    IDENTITY="-"
    IDENTITY_SOURCE="ad-hoc fallback"
  fi
fi

if [ "$IDENTITY" = "-" ]; then
  warn "Signing ad-hoc (no certificate). TCC permission grants (microphone /"
  warn "kTCCServiceAudioCapture) will NOT survive rebuilds signed this way —"
  warn "every ad-hoc build has a different Designated Requirement (a bare"
  warn "cdhash). See docs/releasing-macos.md for the one-time certificate"
  warn "setup needed to ship stable, upgradeable builds."
else
  log "Using signing identity: $IDENTITY ($IDENTITY_SOURCE)"
fi

# --- 3. Build the explicit Designated Requirement, if signing for real --
REQUIREMENTS_FILE=""
if [ "$IDENTITY" != "-" ]; then
  if [ -z "${APPLE_TEAM_ID:-}" ]; then
    fail "APPLE_TEAM_ID must be set when signing with a real identity — it is baked into the pinned Designated Requirement (app/src-tauri/Myna.requirements) and must never be guessed."
  fi
  REQUIREMENTS_FILE="$(mktemp -t myna-dr)"
  CLEANUP_PATHS+=("$REQUIREMENTS_FILE")
  sed "s/__APPLE_TEAM_ID__/$APPLE_TEAM_ID/" "$REQUIREMENTS_TEMPLATE" | grep -v '^//' > "$REQUIREMENTS_FILE"
  log "Pinned DR for Team ID $APPLE_TEAM_ID: $(cat "$REQUIREMENTS_FILE")"
fi

# --- 4. Build ------------------------------------------------------------
# Build app + dmg once via tauri (this also produces the dmg bundler's
# support scripts under target/release/bundle/dmg/, which we reuse below).
# tauri build does NOT accept a custom --requirements, so when signing for
# real we re-sign the .app afterward with the pinned DR and rebuild the dmg
# from that re-signed app — never the other way around.
log "Building (tauri build --bundles app,dmg)"
(
  cd "$REPO_ROOT"
  APPLE_SIGNING_IDENTITY="$IDENTITY" npx tauri build --bundles app,dmg --ci
)

[ -d "$APP_PATH" ] || fail "Expected app bundle not found at $APP_PATH"

if [ "$IDENTITY" != "-" ]; then
  log "Re-signing with pinned Designated Requirement and hardened runtime"
  codesign --force --deep \
    --sign "$IDENTITY" \
    --requirements "=designated => $(cat "$REQUIREMENTS_FILE")" \
    --options runtime \
    "$APP_PATH"

  DMG_SCRIPT="$DMG_DIR/bundle_dmg.sh"
  [ -x "$DMG_SCRIPT" ] || fail "Expected dmg bundler script not found at $DMG_SCRIPT (tauri build should have produced it)"

  EXISTING_DMG="$(find "$DMG_DIR" -maxdepth 1 -name '*.dmg' | head -1)"
  [ -n "$EXISTING_DMG" ] || fail "No dmg produced by initial tauri build in $DMG_DIR"
  DMG_NAME="$(basename "$EXISTING_DMG")"
  rm -f "$EXISTING_DMG"

  STAGE_DIR="$(mktemp -d -t myna-dmg-stage)"
  CLEANUP_PATHS+=("$STAGE_DIR")
  ditto "$APP_PATH" "$STAGE_DIR/Myna.app"

  log "Rebuilding dmg from the re-signed app: $DMG_NAME"
  "$DMG_SCRIPT" \
    --volname "Myna" \
    --icon-size 128 \
    --window-size 500 350 \
    --icon "Myna.app" 125 175 \
    --app-drop-link 375 175 \
    --hdiutil-quiet \
    "$DMG_DIR/$DMG_NAME" \
    "$STAGE_DIR"

  DMG_PATH="$DMG_DIR/$DMG_NAME"
else
  DMG_PATH="$(find "$DMG_DIR" -maxdepth 1 -name '*.dmg' | head -1)"
  [ -n "$DMG_PATH" ] || fail "No dmg produced by tauri build in $DMG_DIR"
fi

# --- 5. Verify the .app ---------------------------------------------------
log "Verifying app bundle: $APP_PATH"

[ -d "$APP_PATH/Contents/_CodeSignature" ] || fail "_CodeSignature directory missing from $APP_PATH"

DV_OUTPUT="$(codesign -dv --verbose=2 "$APP_PATH" 2>&1)"
printf '%s\n' "$DV_OUTPUT"
printf '%s\n' "$DV_OUTPUT" | grep -q "Sealed Resources version=2" || fail "codesign -dv did not report Sealed Resources version=2"
printf '%s\n' "$DV_OUTPUT" | grep -Eq "Info\.plist entries=[0-9]+" || fail "codesign -dv did not report a bound Info.plist (entries=<n>)"
printf '%s\n' "$DV_OUTPUT" | grep -q "Info.plist=not bound" && fail "Info.plist reported as not bound"

codesign --verify --deep --strict "$APP_PATH" || fail "codesign --verify --deep --strict failed on $APP_PATH"
log "codesign --verify --deep --strict: OK"

DR_OUTPUT="$(codesign -d -r- "$APP_PATH" 2>&1)"
printf '%s\n' "$DR_OUTPUT"
if [ "$IDENTITY" != "-" ]; then
  printf '%s\n' "$DR_OUTPUT" | grep -q "certificate" || fail "Expected DR to contain a certificate clause when signed with a real identity, got: $DR_OUTPUT"
  printf '%s\n' "$DR_OUTPUT" | grep -q '^designated => cdhash' && fail "DR is a bare cdhash despite signing with a real identity — DR pinning failed"
  log "DR verified: pinned to certificate (Team ID $APPLE_TEAM_ID), not a per-build cdhash"
else
  printf '%s\n' "$DR_OUTPUT" | grep -q "cdhash" || fail "Expected ad-hoc DR to be a bare cdhash, got: $DR_OUTPUT"
  warn "DR is a bare cdhash (expected for ad-hoc signing) — TCC grants will not survive the next rebuild."
fi

SPCTL_OUTPUT="$(spctl -a -t exec -vv "$APP_PATH" 2>&1 || true)"
printf '%s\n' "$SPCTL_OUTPUT"
if printf '%s\n' "$SPCTL_OUTPUT" | grep -qi "resource"; then
  fail "spctl reported a resource error (not just an unnotarized rejection): $SPCTL_OUTPUT"
fi
log "spctl: rejected-but-assessable (unnotarized) is expected and acceptable, or accepted if already notarized/trusted"

# --- 6. Verify the app inside the mounted dmg -----------------------------
log "Mounting dmg to verify the shipped app: $DMG_PATH"
MOUNT_DIR="$(mktemp -d -t myna-dmg-mount)"
CLEANUP_PATHS+=("$MOUNT_DIR")
hdiutil attach -nobrowse -readonly -mountpoint "$MOUNT_DIR" "$DMG_PATH"

MOUNTED_APP="$MOUNT_DIR/Myna.app"
[ -d "$MOUNTED_APP" ] || fail "Myna.app not found inside mounted dmg at $MOUNTED_APP"
codesign --verify --deep --strict "$MOUNTED_APP" || fail "codesign --verify --deep --strict failed on the app inside the dmg"
log "App inside mounted dmg: codesign --verify --deep --strict OK"

hdiutil detach "$MOUNT_DIR" -quiet
MOUNT_DIR=""

# --- 7. Notarize, only if fully configured --------------------------------
NOTARIZED=0
if [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
  log "Notarizing $DMG_PATH"
  xcrun notarytool submit "$DMG_PATH" \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_PASSWORD" \
    --team-id "$APPLE_TEAM_ID" \
    --wait
  xcrun stapler staple "$DMG_PATH"
  xcrun stapler validate "$DMG_PATH" || fail "stapler validate failed after notarization"
  NOTARIZED=1
else
  log "Skipping notarization — APPLE_ID, APPLE_PASSWORD, and APPLE_TEAM_ID are not all set."
fi

# --- 8. Summary ------------------------------------------------------------
log "Release summary"
echo "  Bundle ID:        $BUNDLE_ID"
echo "  Signing identity: $IDENTITY ($IDENTITY_SOURCE)"
if [ "$IDENTITY" != "-" ]; then
  echo "  Designated Req.:  anchor apple generic and certificate leaf[subject.OU] = \"$APPLE_TEAM_ID\""
else
  echo "  Designated Req.:  cdhash (ad-hoc — unstable across rebuilds)"
fi
echo "  Notarized:         $([ "$NOTARIZED" -eq 1 ] && echo yes || echo no)"
echo "  App:               $APP_PATH ($(du -sh "$APP_PATH" | cut -f1))"
echo "  Dmg:                $DMG_PATH ($(du -sh "$DMG_PATH" | cut -f1))"

log "Done."
