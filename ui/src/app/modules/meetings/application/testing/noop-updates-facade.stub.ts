/**
 * Minimal `MeetingsFacade.updates` stand-in for shell-page specs whose
 * `facadeStub` predates the update-check feature and is unrelated to it.
 * `MeetingsShellPage.ngOnInit` unconditionally calls `loadUpdatesOnLaunch`,
 * so every hand-rolled `facadeStub` needs SOMETHING here — this resolves to
 * `'unset'` consent, so the launch check never fires and no other
 * `updates.*` member needs to do anything beyond not throwing.
 */
export const NOOP_UPDATES_FACADE_STUB = {
  consent: () => 'unset' as const,
  lastCheck: () => undefined,
  checking: () => false,
  dismissedVersion: () => null,
  loadConsent: async () => undefined,
  grantConsent: async () => undefined,
  declineConsent: async () => undefined,
  checkForUpdate: async () => undefined,
  dismissBanner: () => undefined,
};
