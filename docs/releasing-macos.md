# Releasing on macOS

This describes `scripts/release-macos.sh`: build, sign, verify, and
(optionally) notarize the macOS release bundle.

## Why this exists

macOS ties TCC permission grants (microphone / `kTCCServiceAudioCapture`) to
an app's **Designated Requirement (DR)**, not to its bundle ID or path. Per
Apple TN3127: *"macOS records an app's DR in its database of apps authorized
to access privacy-protected resources… Each time the app accesses the
resource, macOS checks that the current version satisfies the original DR."*

Ad-hoc signing (no certificate, `signingIdentity: "-"`) produces a DR that is
a bare `cdhash` — the hash of that exact build. Every rebuild is "different
code" as far as the DR is concerned, so the microphone grant silently dies
on the next build. Worse, System Settings still shows the toggle **ON**,
with no way to re-prompt the user.

Signing with *any* certificate — even one that isn't yet trusted by Apple —
gives the DR a stable anchor: it can name the certificate instead of a
per-build hash. Certificate **trust** is irrelevant to DR *evaluation*
(only an explicit `anchor trusted` clause in the requirement consults trust
settings), so a self-issued Apple Development cert is enough to get a stable
DR for local/internal builds.

The catch: codesign's *default* DR for a certificate-signed app pins
`leaf[subject.CN]` (the certificate's Common Name), whose value can change
when the certificate is renewed. So this script pins the DR explicitly to
`leaf[subject.OU]` (the Apple Developer **Team ID**, which does not change)
— see `app/src-tauri/Myna.requirements`. TN3127 warns that default DRs
across identity types are *"not mutually compatible"*, and changing a DR
after grants exist puts users in an unrecoverable silent-denial state.

**Once a signed build has shipped, the DR expression in
`app/src-tauri/Myna.requirements` must never change.**

## One-time setup: get a signing certificate

1. Open Xcode → **Settings** → **Accounts**.
2. Select your Apple ID (add it if not already present).
3. Click **Manage Certificates…**.
4. Click **+** → **Apple Development**.
5. Xcode creates the certificate and installs it (with its private key) in
   your login keychain.

Find your Team ID (needed below) via Xcode's Accounts pane, or:

```bash
security find-identity -v -p codesigning
# "Apple Development: Your Name (ABCDE12345)" — ABCDE12345 is the Team ID
```

## Environment variables

| Variable | Required for | Purpose |
| --- | --- | --- |
| `APPLE_SIGNING_IDENTITY` | Optional | Explicit codesign identity (name or hash). If unset, the script auto-detects the sole installed codesigning identity, or falls back to ad-hoc (`-`). |
| `APPLE_TEAM_ID` | Required when signing with a real identity | Your Apple Developer Team ID. Baked into the pinned DR — never hardcode this in the repo (it's public). |
| `APPLE_ID` | Notarization only | Apple ID used to submit for notarization. |
| `APPLE_PASSWORD` | Notarization only | App-specific password for `APPLE_ID` (not your Apple ID password). |

Notarization runs only when `APPLE_ID`, `APPLE_PASSWORD`, and
`APPLE_TEAM_ID` are **all** set; otherwise it is skipped with a one-line
notice, and the script still exits 0.

## Running it

```bash
# Ad-hoc (no cert installed, or you want an unsigned dev build):
scripts/release-macos.sh

# Signed, auto-detected identity (works only if exactly one is installed):
APPLE_TEAM_ID=ABCDE12345 scripts/release-macos.sh

# Signed, explicit identity + notarization:
APPLE_SIGNING_IDENTITY="Apple Development: Your Name (ABCDE12345)" \
APPLE_TEAM_ID=ABCDE12345 \
APPLE_ID=you@example.com \
APPLE_PASSWORD=app-specific-password \
scripts/release-macos.sh
```

## What it does

1. Deletes stale `target/release/myna` and `target/release/bundle` — a
   cached binary once let a broken link step pass silently.
2. Resolves the signing identity (env var → sole installed identity →
   ad-hoc, with a loud warning in the ad-hoc case).
3. If signing for real: renders `app/src-tauri/Myna.requirements` (a
   template with an `__APPLE_TEAM_ID__` placeholder) into a concrete DR
   using `APPLE_TEAM_ID`.
4. Runs `tauri build --bundles app,dmg`, which builds and does an initial
   sign of the `.app` and packages a `.dmg`.
5. If signing for real: re-signs the `.app` with `--requirements` pinned to
   the explicit DR and `--options runtime`, then **rebuilds the dmg from
   that re-signed app** (reusing tauri's generated `bundle_dmg.sh`) —
   never the other way around, or the shipped dmg would carry the old
   signature.
6. Verifies the `.app`: `codesign -dv --verbose=2` (sealed resources v2,
   bound Info.plist), `codesign --verify --deep --strict`, and
   `codesign -d -r-` — asserting the DR contains a `certificate` clause
   (not a bare `cdhash`) when signed for real. Runs `spctl -a -t exec -vv`
   and treats `rejected` (unnotarized-but-assessable) as expected; only a
   *resource* error fails the build.
7. **Mounts the built dmg and re-verifies the app inside it** — the
   artifact users actually receive, not just the pre-bundling copy.
8. Notarizes and staples only when fully configured; otherwise skips with a
   notice.
9. Prints a summary: identity used, DR, artifact paths and sizes.

## After switching signing identity: reset TCC grants

Switching signing identity (ad-hoc → certificate, or between certificates)
changes the DR, which invalidates any existing microphone grant for
`app.myna.desktop`. Before first launching a newly-identity-signed build:

```bash
sudo tccutil reset All app.myna.desktop
```

Otherwise the app is silently denied microphone access with no prompt, and
it will look like a regression rather than an expected consequence of
re-signing.
