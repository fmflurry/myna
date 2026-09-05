import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import type { CaptureSource } from '../../../core/models/capture-source.model';
import type { RecordingState } from '../../../core/models/recording-state.model';
import { RecordControlComponent } from './record-control.component';

// --- Stop-phase contract (defined by these tests; production code must grow to match) ---
// New inputs: `stopPhase` (StopPhase | null) and `recordingHealth`
// (RecordingHealthEvent | null). A 10 s watchdog escalates after 10 s without a
// phase change; it INFORMS only — it never offers a force-quit affordance.
// Split out from `record-control.component.spec.ts` to keep that file under
// the project's max-lines limit; the capture/recording-surface tests live there.
type StopPhase =
  | 'stopping-capture'
  | 'finalizing-transcript'
  | 'saving'
  | 'discarding'
  | 'recovering'
  | 'completed'
  | 'failed';

type RecordingHealthCategory = 'wav-write' | 'journal' | 'decode-drop' | 'tap-rebuild' | 'disk';
type RecordingHealthSeverity = 'warning' | 'error' | 'fatal';

interface RecordingHealthEvent {
  readonly category: RecordingHealthCategory;
  readonly severity: RecordingHealthSeverity;
  readonly message: string;
}

/**
 * Stop-phase UI contract (RED): the stopping state is no longer one generic
 * "Finalizing recording…" label. The component receives the backend's
 * `stopPhase` and renders phase-specific text; a 10 s watchdog (reset on every
 * phase change) escalates to a recovery-reassuring message WITHOUT ever
 * offering a force-quit; and the latest `recording://health` event renders
 * with severity-appropriate ARIA live semantics.
 */
describe('RecordControlComponent stop-phase contract', () => {
  const createFixture = (recordingState: RecordingState = 'idle') => {
    const fixture = TestBed.createComponent(RecordControlComponent);
    fixture.componentRef.setInput('recordingState', recordingState);
    fixture.componentRef.setInput('captureSource', 'microphone' satisfies CaptureSource);
    fixture.componentRef.setInput('systemAudioStatus', { kind: 'available' });
    fixture.detectChanges();
    return fixture;
  };

  /** Feeds the not-yet-declared `stopPhase` / `recordingHealth` inputs. */
  const setStopInputs = (
    fixture: ReturnType<typeof createFixture>,
    inputs: { stopPhase?: StopPhase | null; recordingHealth?: RecordingHealthEvent | null },
  ): void => {
    const ref = fixture.componentRef as unknown as { setInput(name: string, value: unknown): void };
    if ('stopPhase' in inputs) {
      ref.setInput('stopPhase', inputs.stopPhase);
    }
    if ('recordingHealth' in inputs) {
      ref.setInput('recordingHealth', inputs.recordingHealth);
    }
  };

  const phaseLabels: readonly (readonly [StopPhase, string])[] = [
    ['stopping-capture', 'Stopping capture'],
    ['finalizing-transcript', 'Finalizing transcript'],
    ['saving', 'Saving'],
    ['discarding', 'Discarding'],
    ['recovering', 'Recovering'],
  ];

  for (const [phase, label] of phaseLabels) {
    it(`shows the phase-specific "${label}" text while stopping in phase "${phase}"`, () => {
      const fixture = createFixture('stopping');
      setStopInputs(fixture, { stopPhase: phase });
      fixture.detectChanges();

      const status = fixture.nativeElement.querySelector('.finalizing');
      expect(status).toBeTruthy();
      expect(status.textContent).toContain(label);
      expect(status.getAttribute('aria-live')).toBe('polite');
    });
  }

  it('falls back to the generic finalizing label before the first stop-progress event arrives', () => {
    const fixture = createFixture('stopping');
    fixture.detectChanges();

    const status = fixture.nativeElement.querySelector('.finalizing');
    expect(status).toBeTruthy();
    expect(status.textContent).toContain('Finalizing recording');
  });

  it('disables the Stop and Cancel controls while the stop is in progress', () => {
    const fixture = createFixture('stopping');
    setStopInputs(fixture, { stopPhase: 'finalizing-transcript' });
    fixture.detectChanges();

    const stopButton = fixture.nativeElement.querySelector('app-record-button .stop') as HTMLButtonElement;
    const cancelButton = fixture.nativeElement.querySelector('app-record-button .cancel') as HTMLButtonElement;
    expect(stopButton.disabled).toBe(true);
    expect(cancelButton.disabled).toBe(true);
  });

  describe('10 s stall watchdog', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('escalates after 10 s without a phase change, reassuring recovery and offering no force-quit', () => {
      vi.useFakeTimers();
      const fixture = createFixture('stopping');
      setStopInputs(fixture, { stopPhase: 'finalizing-transcript' });
      fixture.detectChanges();

      vi.advanceTimersByTime(9_999);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.stalled')).toBeNull();

      vi.advanceTimersByTime(1);
      fixture.detectChanges();
      const stalled = fixture.nativeElement.querySelector('.stalled');
      expect(stalled).toBeTruthy();
      expect(stalled.textContent).toContain(
        'Still finalizing; your recording remains recoverable',
      );
      expect(stalled.getAttribute('role')).toBe('status');
      expect(stalled.getAttribute('aria-live')).toBe('polite');

      // The watchdog informs, never offers an escape hatch: no force/quit control.
      const buttons: HTMLButtonElement[] = Array.from(
        fixture.nativeElement.querySelectorAll('button'),
      );
      expect(
        buttons.some((button) => /force|quit|kill/i.test(button.textContent ?? '')),
      ).toBe(false);
    });

    it('resets on every phase change: the clock restarts from the new phase', () => {
      vi.useFakeTimers();
      const fixture = createFixture('stopping');
      setStopInputs(fixture, { stopPhase: 'finalizing-transcript' });
      fixture.detectChanges();

      vi.advanceTimersByTime(10_000);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.stalled')).toBeTruthy();

      setStopInputs(fixture, { stopPhase: 'saving' });
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.stalled')).toBeNull();

      vi.advanceTimersByTime(9_999);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.stalled')).toBeNull();

      vi.advanceTimersByTime(1);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.stalled')).toBeTruthy();
    });

    it('never escalates while actively recording — the watchdog is stop-phase only', () => {
      vi.useFakeTimers();
      const fixture = createFixture('recording');
      setStopInputs(fixture, { stopPhase: null });
      fixture.detectChanges();

      vi.advanceTimersByTime(60_000);
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('.stalled')).toBeNull();
    });
  });

  describe('recording health display', () => {
    it('renders nothing when no health event has been received', () => {
      const fixture = createFixture('recording');
      setStopInputs(fixture, { recordingHealth: null });
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('.recording-health')).toBeNull();
    });

    it('renders a warning-severity health event with a polite live region', () => {
      const fixture = createFixture('recording');
      setStopInputs(fixture, {
        recordingHealth: {
          category: 'disk',
          severity: 'warning',
          message: 'Less than 1 GB free on the recordings volume',
        },
      });
      fixture.detectChanges();

      const health = fixture.nativeElement.querySelector('.recording-health');
      expect(health).toBeTruthy();
      expect(health.classList.contains('warning')).toBe(true);
      expect(health.textContent).toContain('Less than 1 GB free on the recordings volume');
      expect(health.getAttribute('aria-live')).toBe('polite');
    });

    it('promotes error and fatal severity to an assertive alert while stopping', () => {
      const fixture = createFixture('stopping');
      setStopInputs(fixture, {
        recordingHealth: {
          category: 'journal',
          severity: 'error',
          message: 'Transcript journal write failed',
        },
      });
      fixture.detectChanges();

      let health = fixture.nativeElement.querySelector('.recording-health');
      expect(health).toBeTruthy();
      expect(health.classList.contains('error')).toBe(true);
      expect(health.getAttribute('role')).toBe('alert');

      setStopInputs(fixture, {
        recordingHealth: {
          category: 'wav-write',
          severity: 'fatal',
          message: 'Audio capture stalled',
        },
      });
      fixture.detectChanges();

      health = fixture.nativeElement.querySelector('.recording-health');
      expect(health.classList.contains('fatal')).toBe(true);
      expect(health.getAttribute('role')).toBe('alert');
      expect(health.textContent).toContain('Audio capture stalled');
    });
  });
});
