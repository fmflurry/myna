import { ChangeDetectionStrategy, Component, HostListener, computed, input, output, signal } from '@angular/core';

import type { AudioDevice, AudioLevel } from '../../../core/models/audio-device.model';
import type { AudioSource } from '../../../core/models/audio-source.model';
import type { CaptureSource, SystemAudioStatus } from '../../../core/models/capture-source.model';
import type { RecordingState } from '../../../core/models/recording-state.model';
import { CaptureSettingsComponent } from '../capture-settings/capture-settings.component';
import { LevelMeterComponent } from '../level-meter/level-meter.component';
import { RecordButtonComponent } from '../record-button/record-button.component';

/**
 * The single, always-visible record control living in the title bar. While
 * idle it surfaces a compact `app-capture-settings` trigger (device + source
 * collapsed behind a popover, never a permanently wide three-way control)
 * next to the Record button — new meetings are auto-named by the backend,
 * so no title input lives here; renaming happens inline in the detail-pane
 * heading once a meeting exists. While recording it collapses to a compact
 * live-status readout. Pure presentation: the owning page wires every
 * output to `MeetingsFacade`.
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
