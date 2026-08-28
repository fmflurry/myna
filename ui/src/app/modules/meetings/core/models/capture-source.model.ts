/**
 * Mirrors the Rust `CaptureSource` (`#[serde(rename_all = "lowercase")]`,
 * `app/src-tauri/src/capture.rs`). Omitting the value on `start_recording`
 * defaults to `'microphone'`.
 */
export type CaptureSource = 'microphone' | 'system' | 'mixed';

/**
 * Mirrors the Rust `SystemAudioStatus` (`#[serde(tag = "kind")]`, variant
 * tags in snake_case, fields in camelCase). macOS caches the system-audio
 * permission check per process, so a freshly granted permission cannot flip
 * `permission_denied` back to `available` without a full app restart —
 * hence `restartRequired`.
 *
 * `unknown` is the NORMAL initial state on the Core Audio process-tap
 * backend: unlike the old ScreenCaptureKit path, there is no public
 * preflight API for `kTCCServiceAudioCapture`, so the backend genuinely
 * cannot tell whether the permission is granted until it attempts a
 * capture. `unknown` must never be treated as denied or unavailable — the
 * system/mixed capture options stay selectable so picking one is what lets
 * the OS permission prompt appear in the first place.
 */
export type SystemAudioStatus =
  | { readonly kind: 'available' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'permission_denied'; readonly restartRequired: boolean }
  | { readonly kind: 'unavailable'; readonly reason: string };
