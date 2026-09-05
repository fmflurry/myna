import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { routes } from '../../app.routes';
import { MeetingsFacade } from './application/facades/meetings.facade';
import { FINAL_BATCH_MS } from './application/stores/meetings-store-wiring.support';
import { toMeetingId } from './core/models/meeting.model';
import type { TauriInternalsStub } from './infrastructure/tauri/testing/tauri-internals.stub';
import {
  flushMicrotasks,
  installTauriInternalsStub,
  uninstallTauriInternalsStub,
} from './infrastructure/tauri/testing/tauri-internals.stub';

interface GetMeetingArgs {
  readonly id: string;
}

interface GetLiveTranscriptArgs {
  readonly meetingId: string;
}

const meetingTitles: Readonly<Record<string, string>> = {
  m1: 'Meeting One',
  m2: 'Meeting Two',
};

/** A recording is live at boot: `elapsedSec: 125` renders as `02:05`. */
const LIVE_STATE = { state: 'recording', meetingId: 'm1', effectiveSystemSource: null, elapsedSec: 125 };

/** Wire shape of `TranscriptDto` (`#[serde(rename_all = "camelCase")]`). */
const LIVE_JOURNAL = {
  segments: [
    { startSec: 0, endSec: 4, text: 'Welcome everyone.', speaker: 'me' },
    { startSec: 5, endSec: 9, text: 'Thanks for joining.', speaker: 'others' },
  ],
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
/** Wire shape of `ModelsStatusDto` — all present so the detail pane renders content, not onboarding. */
const MODELS_READY = {
  parakeet: { present: true, path: '/models/parakeet', expectedFiles: [] },
  qwen: { present: true, path: '/models/qwen', expectedFiles: [] },
  silero: { present: true, path: '/models/silero', expectedFiles: [] },
  allPresent: true,
};

describe('meetings routing integration', () => {
  let tauri: TauriInternalsStub;

  beforeEach(() => {
    tauri = installTauriInternalsStub((cmd, args) => {
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
      if (cmd === 'update_consent') {
        // ngOnInit's launch-time `loadConsent()` — 'unset' means no launch check ever fires here.
        return 'unset';
      }
      if (cmd === 'models_status') {
        return MODELS_READY;
      }
      // ADR 0011: a recording is live at boot. `elapsedSec: 125` → 02:05.
      if (cmd === 'recording_state') {
        return LIVE_STATE;
      }
      if (cmd === 'get_live_transcript') {
        const { meetingId } = args as GetLiveTranscriptArgs;
        return meetingId === 'm1' ? LIVE_JOURNAL : null;
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

  // The ADR 0011 Phase-2 incident: a webview reload mid-meeting left the UI
  // with no Stop button, a 0-min timer, and an empty transcript, because the
  // session state lived only in events that had already fired. Boot must
  // re-derive it from the two query commands instead. Removing the
  // `resumeActiveRecording()` call from `ngOnInit` fails every assertion
  // below — that is the regression this block exists to catch.
  it(
    're-attaches a live recording on boot: Stop branch, seeded timer, journaled finals',
    async () => {
      // `/meetings` (no :id) is the worst case: the route subscription clears
      // the selection synchronously, so only a resume landing afterwards can
      // restore the live meeting.
      const harness = await RouterTestingHarness.create('/meetings');
      await flushMicrotasks();
      harness.fixture.detectChanges();
      await flushMicrotasks();
      harness.fixture.detectChanges();

      const facade = harness.routeDebugElement!.injector.get(MeetingsFacade);
      expect(facade.recordingState()).toBe('recording');
      expect(facade.activeRecording()).toEqual({ meetingId: toMeetingId('m1'), elapsedSec: 125 });
      expect(facade.selectedMeeting()?.id).toBe('m1');
      expect(facade.finalizedSegments().map((segment) => segment.text)).toEqual([
        'Welcome everyone.',
        'Thanks for joining.',
      ]);

      const root = harness.routeNativeElement!;
      // The missing Stop button was the headline symptom: WAVs kept writing
      // with no way to end the session.
      expect(root.querySelector('button.stop')).toBeTruthy();
      expect(root.querySelector('button.record')).toBeNull();
      // Timer seeded from the backend's clock, not 00:00.
      expect(root.querySelector('.timer')?.textContent?.trim()).toBe('02:05');
      // Journaled finals replayed into the live transcript.
      expect(transcriptTexts(root)).toEqual(['Welcome everyone.', 'Thanks for joining.']);
    },
    15000,
  );

  it('keeps appending post-boot finals to the replayed journal', async () => {
    // Fake timers BEFORE the harness builds the route injector (which
    // constructs the store and subscribes its finals batch window): the
    // `bufferTime(FINAL_BATCH_MS)` flush timer must live on the fake clock.
    // `flushMicrotasks()` cannot be used here — its real `setTimeout(0)`
    // would never fire — so `advanceTimersByTimeAsync(0)` serves as the
    // macrotask hop that drains the `listen()` promise chains.
    vi.useFakeTimers();
    try {
      const harness = await RouterTestingHarness.create('/meetings');
      await vi.advanceTimersByTimeAsync(0);
      harness.fixture.detectChanges();
      await vi.advanceTimersByTimeAsync(0);
      harness.fixture.detectChanges();

      // A final the backend decodes AFTER boot appends through the live event
      // stream — resume restores the past, events own the future.
      tauri.emit('transcript://final', {
        meetingId: 'm1',
        segment: { start_sec: 10, end_sec: 13, text: 'Decoded after reload.', speaker: 'me' },
      });
      await vi.advanceTimersByTimeAsync(FINAL_BATCH_MS);
      harness.fixture.detectChanges();

      expect(transcriptTexts(harness.routeNativeElement!)).toEqual([
        'Welcome everyone.',
        'Thanks for joining.',
        'Decoded after reload.',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never offers playback of the un-finalized recording', async () => {
    const harness = await RouterTestingHarness.create('/meetings');
    await flushMicrotasks();
    harness.fixture.detectChanges();
    await flushMicrotasks();
    harness.fixture.detectChanges();

    // Mid-recording `audio.wav` carries a 0-byte data chunk; rendering the
    // player over it produced the "Playback error" banner.
    const facade = harness.routeDebugElement!.injector.get(MeetingsFacade);
    expect(facade.recordingState()).toBe('recording');
    expect(harness.routeNativeElement?.querySelector('app-audio-player')).toBeNull();
  });

  it('routes a real menu://settings event through the TauriMenuAdapter to the facade and opens the settings modal', async () => {
    const harness = await RouterTestingHarness.create('/meetings');
    await flushMicrotasks();

    const facade = harness.routeDebugElement!.injector.get(MeetingsFacade);
    let requestCount = 0;
    const subscription = facade.settingsRequests().subscribe(() => {
      requestCount += 1;
    });
    // `onEvent` registers its listener asynchronously — the emit below only
    // reaches the adapter once the `listen()` promise chain has drained.
    await flushMicrotasks();

    expect(harness.routeNativeElement?.querySelector('app-settings')).toBeNull();

    tauri.emit('menu://settings', null);
    await flushMicrotasks();
    harness.fixture.detectChanges();

    expect(requestCount).toBe(1);
    // The shell's own subscription (registered at component construction)
    // fans out from the same event and opens the settings modal.
    expect(harness.routeNativeElement?.querySelector('app-settings')).toBeTruthy();
    subscription.unsubscribe();
  });
});

const transcriptTexts = (root: Element): readonly string[] =>
  Array.from(root.querySelectorAll('app-live-transcript .final .text') as NodeListOf<Element>).map(
    (node) => node.textContent?.trim() ?? '',
  );
