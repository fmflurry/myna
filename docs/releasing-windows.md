# Releasing on Windows

This describes `scripts/release-windows.ps1`: build, sign, and verify the
Windows release bundle (NSIS `*-setup.exe` plus MSI). It is the companion
to [releasing-macos.md](releasing-macos.md) — same updater-key rules, same
`latest.json` manifest, platform-shaped signing (Authenticode via
`signtool` instead of `codesign`; no notarization step, which is
Apple-only).

## What it does

1. Deletes stale `target/release/myna.exe` and `target/release/bundle` — a
   cached binary once let a broken link step pass silently.
2. Warns when `%USERPROFILE%\myna\models` is missing — the packaged app
   would report every model missing at runtime.
3. Fails loudly when `TAURI_SIGNING_PRIVATE_KEY` is unset while
   `bundle.createUpdaterArtifacts` is true — never ships an unsigned
   updater artifact.
4. Runs `tauri build --bundles nsis,msi --ci`, then asserts at least one
   installer (`*-setup.exe` and/or `*.msi`, excluding uninstallers) exists
   and is non-empty.
5. Signs every installer with `signtool sign /fd SHA256` plus an RFC 3161
   timestamp, then re-verifies with `signtool verify /pa`.
6. Asserts the updater `.sig` sidecars exist and are non-empty.
7. Prints a summary: Authenticode yes/no, installer and signature paths.

## Signing: self-signed dev vs trusted ship

Without a certificate (`WINDOWS_CERT_PATH` + `WINDOWS_CERT_PASSWORD`, or
`WINDOWS_CERT_THUMBPRINT`) the build ships **unsigned** with a loud
warning, mirroring the macOS ad-hoc fallback — and Windows SmartScreen
flags unsigned installers on launch.

A self-signed or internal-dev certificate is enough for local builds, but
SmartScreen still warns: it carries no reputation. For ship, use a
publicly-trusted certificate — EV preferred (immediate SmartScreen
reputation), OV acceptable once install reputation accrues. The RFC 3161
timestamp (`/tr … /td SHA256`) keeps the signature valid after the
certificate itself expires, so always sign with it.

## Updater signing key backup

The Tauri updater key (`TAURI_SIGNING_PRIVATE_KEY`, content or path;
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` when the key has one) is shared with
macOS: the same minisign pair signs every platform's updater artifact, and
the public key is pinned in `app/src-tauri/tauri.conf.json`.

**Losing this private key strands every existing install** on both
platforms — installed copies validate against the pinned `pubkey` and
cannot fetch an update signed with a key they don't trust. Back it up
somewhere durable and access-controlled (password manager or secrets
vault), never in the repo.

## The `latest.json` platforms map

`scripts/make-latest-json.sh` emits one static manifest for both
platforms (one entry per platform key, so version comparison stays
local):

- The macOS key (`darwin-aarch64`, `darwin-x86_64`, `darwin-universal`)
  is determined empirically with `lipo` on the built binary.
- The Windows key is the fixed `windows-x86_64` — always an x64 build off
  `windows-latest`, with no PE inspection on the macOS manifest job.
- The NSIS `*-setup.exe` (+ `.sig`) is the Windows updater URL; the
  `.msi` (+ `.sig`) is a manual-download release asset only, never an
  updater URL.

## Live audio tests

Live audio tests are gated by `MYNA_LIVE_AUDIO_TESTS` and must run
serially (`--test-threads=1`): concurrent capture creation within one
process is rejected by the OS audio stack, so parallel test threads fail
for platform reasons, not test bugs.

## Environment variables

| Variable | Required for | Purpose |
| --- | --- | --- |
| `WINDOWS_CERT_PATH` + `WINDOWS_CERT_PASSWORD` | Signed builds | Path to a `.pfx` and its password; `signtool sign /f … /p …`. |
| `WINDOWS_CERT_THUMBPRINT` | Signed builds (alt) | SHA-1 thumbprint of a store certificate; `signtool sign /sha1 …`. Either this or the `.pfx` pair — never both. |
| `TAURI_SIGNING_PRIVATE_KEY` | Required (updater artifacts) | Same shared minisign key as macOS (see above). The script fails loudly if unset. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Required if the key has a password | Password for `TAURI_SIGNING_PRIVATE_KEY`. |

## CI: tag-triggered releases

`.github/workflows/release.yml` runs `scripts/release-windows.ps1` on
`windows-latest` whenever a `v*` tag is pushed (matrix with `macos-14`,
`fail-fast: false` so one broken leg never cancels the other), uploads
the NSIS/MSI installers plus `.sig` sidecars to the GitHub Release, and
stashes the NSIS pair for the trailing `updater-manifest` job — which
merges both platforms into a single `latest.json` via
`scripts/make-latest-json.sh --windows-nsis …`.
