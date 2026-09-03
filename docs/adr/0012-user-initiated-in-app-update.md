# ADR 0012: User-Initiated In-App Update (Download + Install)

**Status**: Accepted  
**Date**: 2026-09-03  
**Builds on**: [ADR 0010: Opt-In Update Checks with Notify-Only Delivery](0010-opt-in-update-checks.md) and [ADR 0011: Disk-Backed Session State for Reload and Crash Recovery](0011-session-resilience.md)  
**Amends**: [ADR 0010](0010-opt-in-update-checks.md) — relaxes its *notify-only, never auto-install* stance to permit a **user-clicked, consent-gated, recording-gated** in-app install. The opt-in consent model, the static manifest endpoint, the fixed version-free `User-Agent`, and the Rust-side plugin gating all stand unchanged.

**Context**: ADR 0010 shipped update *checks* that surface a download link. In practice that link is the updater artifact's `Myna.app.tar.gz` URL (the `download_url` field on the check result, `app/src-tauri/src/commands/updates.rs:77`) — an archive a normal user cannot do anything with. The "notify-only" path therefore ends in a dead end: the user is told an update exists, handed a `.tar.gz`, and left to figure out the DMG themselves. ADR 0010 rejected *auto*-install for a real and still-valid reason: a **silent** replacement under ad-hoc signing changes the app's code identity, macOS TCC drops the microphone grant without re-prompting, and the user records their next meeting into silence. That rejection was about *silence*, not about *installing*. A user who clicks "Update" and sees an explicit caveat is not the failure mode ADR 0010 was guarding against.

## Decision

Turn the update notification into a working one-click update that **the user initiates**, without reintroducing the silent-replacement hazard:

- **User-clicked, never automatic** — install runs only after an explicit click. No background download-then-swap, no scheduled restart. The consent gate from ADR 0010 still governs whether Myna *checks*; this ADR governs what a *check result* can offer once the user is looking at it.
- **Curated Rust-side command (`install_update`)** — the UI calls a single purpose-built command that drives `tauri-plugin-updater`'s download-and-verify-and-install on the Rust side. The plugin's own webview IPC stays **capability-blocked**: `capabilities/default.json` gains **no** updater permission, so the renderer cannot invoke egress or install directly. **Rust owns the only call site** — the same gating that made the check safe in ADR 0010 makes the install safe here.
- **Recording-gated restart (`restart_app`)** — the restart that activates the new bundle refuses to proceed while a recording session is live, per the ADR 0011 manifest invariant (`session.json` present ⇒ recording in progress). The user is told to stop the recording first; the update is never allowed to truncate a meeting.
- **Explicit pre-restart caveat** — before restarting, the UI states plainly that **ad-hoc-signed builds will re-prompt for microphone permission** on next launch. The user consents to the re-prompt as part of the click; it is no longer a silent surprise. Once a Developer ID certificate ships, the caveat becomes moot (stable Designated Requirement — see [Releasing on macOS](../releasing-macos.md)) and the flow needs no code change.

## Rationale

### Why install on click, when ADR 0010 forbade auto-install?

ADR 0010's objection was specifically to *silent* replacement: the grant is dropped and the user never learns why, so the next meeting is silently lost. A user-initiated install inverts the hazard — the user asked for it, sees the caveat, and expects to re-grant. The privacy and permission reasoning is preserved; only the *trigger* changes from "the app decides" to "the user decides." The notify-only link that ADR 0010 shipped was already a compromise forced by having no install path at all; this closes that gap without abandoning the principle.

### Why a curated `install_update` command instead of exposing the plugin?

The whole security posture of ADR 0010 rests on the webview having no reachable path to the updater — the plugin is registered Rust-side only and the capability list omits it. Handing the renderer the plugin's IPC would undo that. A single Rust command that internally uses the plugin keeps the boundary intact: the UI can ask "install the update you already told me about," but cannot point the updater at an arbitrary endpoint or trigger it outside the consent/recording gates. The attack surface stays one audited call site instead of the plugin's full API.

### Why reuse `tauri-plugin-updater` rather than add an HTTP client?

The plugin already verifies the artifact's **minisign** signature against the pinned `pubkey` in `tauri.conf.json`. Minisign verification is **independent of Apple code signing** — it does not care whether the bundle is ad-hoc or Developer ID signed, only that the release was signed by the updater key. So the install path adds no new HTTP client, no new trust anchor, and no new egress surface beyond the check ADR 0010 already sanctioned. Verification is the safety property; Apple signing only affects what happens to TCC grants *after* install, which the caveat handles.

### Why verify-before-install means no rollback is needed

The updater verifies the signature and integrity of the downloaded bundle **before** it touches the running app. A failed or corrupt download therefore leaves the old bundle completely untouched — there is nothing to roll back to, because the current version was never modified. The escape hatch for the residual case (a *validly signed* but broken release) is the release-page link: the user can always fetch the DMG manually from GitHub Releases. Automatic rollback would add state and complexity to guard a window that verification already closes.

### Why dev builds refuse to install

A debug build lives in `target/debug/` and is rebuilt constantly. An in-place updater install against such a bundle would rewrite the developer's build directory out from under the toolchain — a footgun, not a feature. Under `cfg(debug_assertions)` the `install_update` command refuses and directs the developer to rebuild normally. The updater path is a release-only affordance.

## Options Considered

### Keep the notify-only `.tar.gz` link (status quo)
- **Pros**: Zero new code; ADR 0010 unchanged.
- **Cons**: The link points at an artifact users cannot use; the update flow dead-ends and adoption stays low. This is the bug this ADR exists to fix.
- **Rejected**: It ships a notification with no working action.

### Download the DMG and open it
- **Pros**: Uses the artifact users recognize; no in-app install code.
- **Cons**: Still fully manual — quit, drag to Applications, relaunch — i.e. *more* steps than one click, and the browser/Gatekeeper quarantine adds friction on top. It does not actually reduce the user's labor versus the link.
- **Rejected**: It preserves the manual dance the click was meant to eliminate.

### Silent auto-install (background download + swap)
- **Pros**: Zero user action.
- **Cons**: The exact hazard ADR 0010 rejected — under ad-hoc signing it drops the microphone grant with no warning and silently ruins the next meeting.
- **Rejected**: Unchanged from ADR 0010. The user-click + caveat is the difference that makes install acceptable here.

## Consequences

### Positive
- One-click update: a check result leads to an actual install instead of a dead-end archive link.
- No new HTTP client and no new trust anchor — reuses `tauri-plugin-updater`, whose minisign verification is independent of Apple ad-hoc signing.
- The webview still cannot reach the updater: `capabilities/default.json` gains no updater permission, Rust owns the only call site.
- A meeting is never truncated by an update — `restart_app` refuses while a session is live (ADR 0011).
- The TCC consequence is surfaced, not hidden: the user sees the re-prompt caveat before restarting.
- When Developer ID lands, grants become stable and the caveat simply stops applying — **no code change** required.

### Negative
- Under ad-hoc signing the user still re-grants microphone permission after an in-place update — identical to the DMG path, because the Designated Requirement changes the same way. The click does not remove the re-prompt; it only makes it expected.
- No automatic rollback: a validly-signed-but-broken release is recovered by manually fetching the DMG from the release page, not by the app reverting itself.
- A new curated command (`install_update`) and a restart gate (`restart_app`) add surface to audit, even though they are deliberately narrow. `restart_app` has no consent gate — a compromised renderer can force an idle restart (it is refused during recording, so it can never truncate a session).

## Implementation Notes

- **Command**: `install_update` (Rust) drives `tauri-plugin-updater`'s download → verify → install; it is the sole updater entry point reachable from the UI.
- **Capability gating**: `app/src-tauri/capabilities/default.json` remains without an updater permission — the plugin's webview IPC is never granted.
- **Restart gate**: `restart_app` checks the ADR 0011 `session.json` invariant and refuses while recording is in progress.
- **Caveat copy**: the pre-restart dialog states the ad-hoc re-prompt consequence; it becomes inert once builds are Developer ID signed (stable DR — see [Releasing on macOS](../releasing-macos.md)).
- **Dev guard**: `install_update` is a no-op that returns a "rebuild instead" error under `cfg(debug_assertions)`.
- **Verification**: minisign against the pinned `pubkey` in `app/src-tauri/tauri.conf.json`; verify precedes install, so a failed download leaves the running bundle untouched.

## References

- **Amended decision**: [ADR 0010: Opt-In Update Checks with Notify-Only Delivery](0010-opt-in-update-checks.md)
- **Recording invariant relied on by `restart_app`**: [ADR 0011: Disk-Backed Session State](0011-session-resilience.md)
- **Update check command & `download_url`**: `app/src-tauri/src/commands/updates.rs`
- **Updater plugin registration (Rust-side only)**: `app/src-tauri/src/lib.rs`
- **Capability list (no updater entry)**: `app/src-tauri/capabilities/default.json`
- **Signing / TCC / Developer ID**: [Releasing on macOS](../releasing-macos.md)

## Revision History

- **2026-09-03**: Accepted. Amends ADR 0010's notify-only stance to allow a user-clicked, consent-gated, recording-gated in-app install via the curated `install_update` command; webview IPC stays capability-blocked, `restart_app` refuses during live sessions, and an explicit ad-hoc re-prompt caveat precedes restart. Reuses `tauri-plugin-updater` minisign verification (no new HTTP client); verify-before-install obviates rollback; dev builds refuse install under `cfg(debug_assertions)`.
