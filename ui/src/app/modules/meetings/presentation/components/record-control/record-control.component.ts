import { ChangeDetectionStrategy, Component, HostListener, computed, effect, input, output, signal } from '@angular/core';

import type { AudioDevice, AudioLevel } from '../../../core/models/audio-device.model';
import type { AudioSource } from '../../../core/models/audio-source.model';
import type { CaptureSource, SystemAudioStatus } from '../../../core/models/capture-source.model';
import type { RecordingHealthEvent, StopPhase } from '../../../core/models/recording-lifecycle.model';
import type { RecordingState } from '../../../core/models/recording-state.model';
import { CaptureSettingsComponent } from '../capture-settings/capture-settings.component';
import { LevelMeterComponent } from '../level-meter/level-meter.component';
import { RecordButtonComponent } from '../record-button/record-button.component';

/** User-facing text per stop phase; the stopping state is never one generic label. */
const STOP_PHASE_LABELS: Readonly<Record<StopPhase, string>> = {
  'stopping-capture': 'Stopping capture',
  'finalizing-transcript': 'Finalizing transcript',
  saving: 'Saving',
  discarding: 'Discarding',
  recovering: 'Recovering',
  completed: 'Completed',
  failed: 'Failed',
};

/** Generic stopping label before the first `recording://stop-progress` event. */
const GENERIC_FINALIZING_LABEL = 'Finalizing recording…';

/**
 * How long a stop phase may sit unchanged before the UI reassures the user.
 * The watchdog INFORMS only — it never offers a force/quit/kill affordance,
 * because the recording stays durable (journal + manifest) and recoverable
 * regardless of how long finalization takes.
 */
const STALL_WATCHDOG_MS = 10_000;

/**
 * The single, always-visible record control living in the title bar. While
 * idle it surfaces a compact `app-capture-settings` trigger (device + source
 * collapsed behind a popover, never a permanently wide three-way control)
 * next to the Record button — new meetings are auto-named by the backend,
 * so no title input lives here; renaming happens inline in the detail-pane
 * heading once a meeting exists. While recording it collapses to a compact
 * live-status readout. While stopping it renders the backend's current
 * {@link StopPhase}, escalates via a stall watchdog, and surfaces the latest
 * {@link RecordingHealthEvent}. Pure presentation: the owning page wires
 * every output to `MeetingsFacade`.
 */
@Component({
  selector: 'app-record-control',
  imports: [CaptureSettingsComponent, LevelMeterComponent, RecordButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './record-control.component.html',
  styleUrl: './record-control.component.scss',
})
export class RecordControlComponent {
  readonly recordingState = input.required<RecordingState>();
  readonly devices = input<readonly AudioDevice[]>([]);
  readonly selectedDevice = input<AudioDevice | null>(null);
  readonly captureSource = input.required<CaptureSource>();
  readonly systemAudioStatus = input.required<SystemAudioStatus>();
  readonly audioSources = input<readonly AudioSource[]>([]);
  readonly selectedAudioSource = input<string>('');
  readonly effectiveSystemSource = input<AudioSource | null>(null);
  readonly level = input<AudioLevel | undefined>(undefined);
  readonly elapsedLabel = input('00:00');
  readonly disabled = input(false);
  /** True while the STT model is loading in response to a Record click — `recordingState()` is still `'idle'` here. */
  readonly startingRecording = input(false);
  /** Current `recording://stop-progress` phase of the in-flight stop; `null` until the first event of a stop. */
  readonly stopPhase = input<StopPhase | null>(null);
  /** Latest `recording://health` event; `null` while the recording stays healthy. */
  readonly recordingHealth = input<RecordingHealthEvent | null>(null);

  readonly deviceChanged = output<string>();
  readonly sourceSelected = output<CaptureSource>();
  readonly audioSourceSelected = output<string>();
  readonly permissionRequested = output<void>();
  readonly recordClicked = output<void>();
  readonly stopClicked = output<void>();
  readonly cancelClicked = output<void>();

  /**
   * True when the user asked for system or mixed audio but the recorder
   * reports no effective system source — i.e. the Core Audio tap silently
   * fell back to microphone-only (permission refused, or the tap failed).
   * This is now the main way a user learns the audio permission wasn't
   * granted, since there is no preflight API to warn them beforehand.
   */
  protected readonly degradedToMicOnly = computed(
    () => this.captureSource() !== 'microphone' && this.effectiveSystemSource() === null,
  );

  /** Phase-specific stopping label; the generic finalizing text before the first stop-progress event. */
  protected readonly stopPhaseLabel = computed(() => {
    const phase = this.stopPhase();
    return phase === null ? GENERIC_FINALIZING_LABEL : STOP_PHASE_LABELS[phase];
  });

  /** True once the current stop phase has sat unchanged for {@link STALL_WATCHDOG_MS}. */
  protected readonly stalled = signal(false);

  constructor() {
    // 10 s stop-phase watchdog: re-arms on every phase change and only ever
    // runs while stopping with a known phase. Actively recording is never
    // escalated. The escalation informs (role=status, polite) and offers no
    // escape hatch — the recording is recoverable either way.
    effect((onCleanup) => {
      this.stalled.set(false);
      if (this.recordingState() !== 'stopping' || this.stopPhase() === null) {
        return;
      }
      const timer = setTimeout(() => this.stalled.set(true), STALL_WATCHDOG_MS);
      onCleanup(() => clearTimeout(timer));
    });
  }

  /** Inline two-step confirm for the header cancel — mirrors `MeetingListItemComponent.confirmingDelete`. */
  protected readonly confirmingCancel = signal(false);

  /** Intercepts the child record-button's cancel click; the discard only happens once confirmed. */
  onCancelClicked(): void {
    this.confirmingCancel.set(true);
  }

  confirmCancel(event: Event): void {
    event.stopPropagation();
    this.confirmingCancel.set(false);
    this.cancelClicked.emit();
  }

  dismissCancel(event: Event): void {
    event.stopPropagation();
    this.confirmingCancel.set(false);
  }

  /** Escape backs out of the cancel confirmation without discarding anything. */
  @HostListener('keydown.escape', ['$event'])
  onEscapeKey(event: Event): void {
    if (!this.confirmingCancel()) {
      return;
    }
    this.dismissCancel(event);
  }
}
