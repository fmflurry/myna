import { isDevMode } from '@angular/core';

/**
 * Dev-only gate for the screenshot harness route (`?screenshot=<scene>`).
 *
 * Returns false in production builds, so the lazy screenshot chunk is never
 * loaded outside development and the production bundle path is unaffected.
 * Match is query-param based — the scene value itself is read by
 * `readScreenshotScene`, which falls back to a seeded scene for unknowns.
 */
export function screenshotCanMatch(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  if (!isDevMode()) {
    return false;
  }
  return new URLSearchParams(window.location.search).get('screenshot') !== null;
}
