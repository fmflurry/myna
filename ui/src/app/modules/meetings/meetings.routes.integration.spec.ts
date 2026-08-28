import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { routes } from '../../app.routes';
import { MeetingsFacade } from './application/facades/meetings.facade';
import {
  flushMicrotasks,
  installTauriInternalsStub,
  uninstallTauriInternalsStub,
} from './infrastructure/tauri/testing/tauri-internals.stub';

interface GetMeetingArgs {
  readonly id: string;
}

const meetingTitles: Readonly<Record<string, string>> = {
  m1: 'Meeting One',
  m2: 'Meeting Two',
};

/**
 * Routed integration spec exercising the REAL application injector graph —
 * real `meetingsRoutes`, real `provideMeetings()`, real Tauri adapters, real
 * `MeetingsStore`, real `MeetingsFacade`. Only the outermost boundary
 * (`window.__TAURI_INTERNALS__`) is stubbed.
 *
 * This is deliberately NOT a `TestBed`-hand-wired-providers spec: those hide
 * the exact DI-scope bug this test exists to catch (a root-scoped service
 * depending on a route-scoped provider throws `NG0201` only through the
 * real router/injector chain, never through a spec that wires providers
 * itself).
 */
describe('meetings routing integration', () => {
  beforeEach(() => {
    installTauriInternalsStub((cmd, args) => {
      if (cmd === 'list_meetings') {
        return [];
      }
      if (cmd === 'get_meeting') {
        const { id } = args as GetMeetingArgs;
        return {
          id,
          title: meetingTitles[id] ?? id,
          createdAt: new Date(2026, 7, 27, 10, 0).toISOString(),
          durationSec: 60,
          audioPath: null,
          transcript: null,
          summaries: [],
        };
      }
      throw new Error(`Unexpected command in routing integration spec: ${cmd}`);
    });

    TestBed.configureTestingModule({
      providers: [provideRouter(routes)],
    });
  });

  afterEach(() => {
    uninstallTauriInternalsStub();
  });

  it(
    'activates the single-window meetings route and renders the real two-pane shell',
    async () => {
      const harness = await RouterTestingHarness.create('/meetings');

      const shell = harness.routeNativeElement?.querySelector('.meetings-shell');
      expect(shell).toBeTruthy();
      expect(harness.routeNativeElement?.querySelector('app-meeting-sidebar')).toBeTruthy();
      expect(harness.routeNativeElement?.querySelector('app-meeting-detail-pane')).toBeTruthy();
    },
    15000,
  );

  it('resolves MeetingsFacade -> MeetingsStore -> all ports without NG0201', async () => {
    await expect(RouterTestingHarness.create('/meetings')).resolves.toBeDefined();
  });

  it(
    'updates the detail pane every time the sidebar selection changes, including reselecting a prior meeting',
    async () => {
      const harness = await RouterTestingHarness.create('/meetings/meeting/m1');
      await flushMicrotasks();
      const facade = harness.routeDebugElement!.injector.get(MeetingsFacade);

      expect(facade.selectedMeeting()?.id).toBe('m1');

      // Both `meeting/:id` activations share the SAME route config, so
      // Angular's default reuse strategy keeps `MeetingsShellPage` alive
      // across this navigation instead of recreating it — the exact
      // condition that let `ngOnInit`'s one-time snapshot read silently
      // stop tracking the route param after the first selection.
      await harness.navigateByUrl('/meetings/meeting/m2');
      await flushMicrotasks();
      expect(facade.selectedMeeting()?.id).toBe('m2');

      await harness.navigateByUrl('/meetings/meeting/m1');
      await flushMicrotasks();
      expect(facade.selectedMeeting()?.id).toBe('m1');
    },
    15000,
  );
});
