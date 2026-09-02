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
