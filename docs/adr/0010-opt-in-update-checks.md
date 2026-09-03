# ADR 0010: Opt-In Update Checks with Notify-Only Delivery

**Status**: Decided (Phase 1)  
**Date**: 2026-09-01  
**Amended by**: [ADR 0012: User-Initiated In-App Update](0012-user-initiated-in-app-update.md) — relaxes the *notify-only, never auto-install* stance below to permit a user-clicked, consent-gated, recording-gated in-app install.  
**Context**: Myna launched as 0.1.0 with a zero-egress guarantee: no network crates in Rust, no fetch/XHR/WebSocket/beacon in the UI, CSP `default-src 'self'`, no telemetry, self-hosted fonts. Users deserved to know when a new version ships. The need to balance that convenience against the privacy commitment prompted this decision.

## Decision

Add **opt-in update checks** that:
- **Off by default** — unset consent, no check until the user opts in.
- **Notify-only, never auto-install** — download and install are user-initiated; Myna presents a link and a choice, never silently replaces itself.
- **One request per 24 hours** — checked once on launch and then throttled; never triggered while recording.
- **Static manifest endpoint** — no URL templating (Tauri supports `{{target}}/{{arch}}/{{current_version}}` but we deliberately omit it); every user fetches the same public file and version comparison happens locally.
- **Minimal disclosure** — the HTTP request sends only:
  - **IP address** (to `github.com` and its redirect target `objects.githubusercontent.com`)
  - **TLS SNI hostname** (the DNS name of the server being contacted)
  - **User-Agent: Myna** (fixed, version-free, to avoid fingerprinting)
  - **Nothing else** — no meeting data, no transcript, no usage statistics, no OS version, no architecture, no user identifier, no TCC permission status.
- **Plugin gated in Rust** — the update-check plugin is registered only in the Rust backend (app/src/main.rs); the Tauri JS plugin API is not wired to the webview. Capabilities in `capabilities/default.json` omit the updater entry, so even if the renderer were compromised, no JS code can invoke egress.
- **Key custody: one-time setup cost** — the private key for signing manifests lives at `~/.tauri/` (never in the repo, CI secrets only). Losing the key permanently disables updates for all existing installs; a new key forces every user to manually re-download. This is the tradeoff for ad-hoc signing and is documented in the Known Limitations.

## Rationale

### Why opt-in, off by default?

Users installing v0.1.0 explicitly chose Myna because it makes no outbound calls. Changing that default would violate that expectation. Opt-in preserves the zero-egress guarantee for anyone who doesn't explicitly consent.

### Why notify-only, no auto-install?

Ad-hoc signing (v0.1.0's build mode before a Developer ID certificate ships) changes the app's code identity on every release. macOS TCC (Transparency, Consent & Control) permission grants are tied to code identity; when the identity changes, the grant is revoked. A silent auto-update would:
1. Replace Myna with a new binary (new code identity).
2. macOS drops the microphone permission without re-prompting.
3. User records their next meeting and hears silence.

The tradeoff is explicit: users get a notification to download and manually re-install, re-granting microphone permission in the process. Once a Developer ID certificate ships and builds are signed with it, auto-install is possible and can be revisited; that decision is not being made today.

### Why static manifest, no URL templating?

Templated endpoints (e.g., `.../releases/latest/download/{version}-{arch}.json`) leak OS, architecture, and version in the URL. A static endpoint means everyone fetches the same file, so no metadata about the requestor is in the URL. This is a deliberate privacy choice.

### Why version comparison on-device?

If the server were to return only the version number or a yes/no decision, the server learns which version a user is running. By returning the entire manifest (name, version, notes, pub_date, signature) to every request, the server learns nothing — every user's request is identical and the server's response is identical.

### Cadence: once per 24 hours, never while recording

Polling more frequently than once per 24 hours creates unnecessary network chatter. Checking while recording would create a race: if an update is available and the user is mid-transcription, notifications could distract or interrupt the workflow. Once recording stops, the next check (if 24 hours have passed) is fair game.

### Why the User-Agent is fixed?

`User-Agent: Myna` without a version number prevents the user-agent string from acting as a fingerprint. TLS SNI and IP are already disclosed; keeping the user-agent static means at least that vector doesn't leak extra info.

## Options Considered

### No update checks at all
- **Pros**: Preserves zero-egress guarantee; no implementation cost.
- **Cons**: Users must manually visit GitHub Releases and figure out if a new version exists; updates have low visibility, adoption is slow.
- **Rejected**: The privacy promise still holds for users who don't opt in; skipping updates entirely is overly conservative.

### Auto-check, show notification
- **Pros**: Same as this decision, plus no user action to enable.
- **Cons**: Violates the zero-egress default; users who chose Myna for privacy feel betrayed.
- **Rejected**: Opt-in is the right respect for user expectations.

### Auto-download + auto-install
- **Pros**: Easiest for users; no manual re-install friction.
- **Cons**: Breaks microphone permissions (see Rationale). Would require a Developer ID certificate to ship safely.
- **Rejected**: Deferring this until Developer ID is in hand.

### URL-templated manifest (e.g., `.../myna-{version}-{arch}.json`)
- **Pros**: Smaller response body; version and arch in URL make server-side filtering possible (if needed later).
- **Cons**: Leaks OS, architecture, version to GitHub in the URL; every user's request is unique and fingerprintable.
- **Rejected**: Static endpoint is simpler and more private.

## Consequences

### Positive
- Users who don't opt in see zero network activity; the zero-egress guarantee is preserved for them.
- Opt-in users get update notifications without the privacy cost of auto-check (e.g., no version leakage, no architecture fingerprint).
- Notify-only prevents the TCC permission revocation bug.
- Rust-side plugin gating means the webview can never be exploited to trigger egress.
- Cadence (once per 24h, not while recording) keeps network overhead negligible (~1 KB per request).

### Negative
- Users accustomed to "install and forget" auto-update workflows will need to manually re-download and re-install.
- Lost private key (`~/.tauri/`) permanently disables updates for that installation; users must re-download from GitHub.
- Manual re-install means re-granting microphone permission (until Developer ID arrives).

## Implementation Notes

- **Preferences storage**: Consent is persisted in `~/myna/preferences.json` (mode 0600, inside the 0700 data root).
- **Manifest endpoint**: `https://github.com/fmflurry/myna/releases/latest/download/latest.json`
- **Public key for verification**: `2F5B0A7CF74DCBAA` (in `tauri.conf.json`).
- **Bundling**: `bundle.createUpdaterArtifacts: true` in `tauri.conf.json` ensures release builds create `latest.json`.
- **Validation**: `scripts/make-latest-json.sh` enforces that version, signature, and pub_date are present and consistent before a manifest is published.
- **Consent prompt**: On first opt-in, users see the "Check for updates?" dialog (exact copy in `ui/src/app/modules/meetings/presentation/components/update-consent-dialog/update-consent-dialog.component.html`). Future opt-out/opt-in is accessible in About → Updates.

## Testing

- Rust-side: unit tests for the update-check plugin verify that requests are rate-limited to ≤1 per 24h and that recording blocks checks.
- UI: component tests verify the consent dialog renders with accurate copy and that clicking "Turn on" and "No thanks" persist the preference correctly.
- Integration: end-to-end test verifies that a user who opted in sees a notification when a newer version is available on GitHub.

## References

- **Tauri updater docs**: https://tauri.app/v1/guides/features/updater
- **Consent dialog**: `ui/src/app/modules/meetings/presentation/components/update-consent-dialog/`
- **Preferences**: `~/myna/preferences.json` (user-local; never committed)
- **Manifest builder**: `scripts/make-latest-json.sh`
- **Release signing**: `.tauri/` (dev machine local; CI uses secrets only)
