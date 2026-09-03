import type { MeetingsErrorCode } from './recording-state.model';

/**
 * Whether the user has opted in to automatic update checks. Mirrors the
 * Rust `UpdateConsent` (`#[serde(rename_all = "lowercase")]`).
 */
export type UpdateConsent = 'unset' | 'granted' | 'declined';

/**
 * Result of a check-for-update pass. A discriminated union on `status`:
 * `'skipped'` covers every reason the backend declined to check (no
 * consent yet, throttled, or a recording in progress), and `'failed'`
 * covers a check that ran but errored — both distinct from a genuine
 * `'up-to-date'` result.
 */
export type UpdateCheck =
  | { readonly status: 'up-to-date' }
  | { readonly status: 'available'; readonly version: string; readonly notes: string; readonly downloadUrl: string }
  | { readonly status: 'skipped'; readonly reason: 'no-consent' | 'throttled' | 'recording' }
  | { readonly status: 'failed'; readonly message: string };

/**
 * Terminal outcome of an `install_update` invoke, mirroring the Rust
 * `UpdateDonePayload` (the same value emitted on `update://done`).
 * `version` is the freshly-installed version on success; `message` is the
 * human-readable failure description — each `null` when the other side of
 * the seam had nothing to report. The no-op terminal is
 * `{success: true, version: null, message: 'up-to-date'}`.
 */
export interface UpdateInstallResult {
  readonly success: boolean;
  readonly version: string | null;
  readonly message: string | null;
}

/**
 * One-click update install state machine, discriminated on `status`:
 * `'idle'` (nothing in flight — also where the up-to-date no-op terminal
 * lands, so the banner hides instead of lying about an install),
 * `'downloading'` (`percent` is the 0..100 share when the server sent a
 * `Content-Length`, or `null` for genuinely indeterminate progress —
 * never a fabricated 0; monotonic across numbers, it never decreases),
 * `'ready'` (installed, awaiting restart; `version` is what was
 * installed), and `'failed'` (`message` is a human-readable, non-empty
 * description; `code` carries the stable machine-readable
 * {@link MeetingsErrorCode} when the rejection crossed the IPC seam as a
 * typed `MeetingsError` — e.g. `'BUSY'` for the recording gate — so the
 * UI never depends on message-sniffing alone).
 */
export type UpdateInstallState =
  | { readonly status: 'idle' }
  | { readonly status: 'downloading'; readonly percent: number | null }
  | { readonly status: 'ready'; readonly version: string }
  | { readonly status: 'failed'; readonly message: string; readonly code?: MeetingsErrorCode };
