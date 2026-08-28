import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import type { CaptureSource, SystemAudioStatus } from '../../../core/models/capture-source.model';

interface CaptureSourceOption {
  readonly value: CaptureSource;
  readonly label: string;
}

const CAPTURE_SOURCE_OPTIONS: readonly CaptureSourceOption[] = [
  { value: 'microphone', label: 'Microphone only' },
  { value: 'system', label: 'System audio only' },
  { value: 'mixed', label: 'Both' },
];

/**
 * Pure presentation: takes the current selection and system-audio status as
 * inputs, emits the user's intent as outputs. Injects nothing — the owning
 * page wires every output to `MeetingsFacade`.
 */
@Component({
  selector: 'app-capture-source-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './capture-source-picker.component.html',
  styleUrl: './capture-source-picker.component.scss',
})
export class CaptureSourcePickerComponent {
  readonly captureSource = input.required<CaptureSource>();
  readonly systemAudioStatus = input.required<SystemAudioStatus>();
  readonly disabled = input(false);

  readonly sourceSelected = output<CaptureSource>();
  readonly permissionRequested = output<void>();

  protected readonly options = CAPTURE_SOURCE_OPTIONS;

  /**
   * `unknown` is selectable, NOT disabled: it is the normal initial state
   * now that there is no preflight API for the audio permission, and the
   * only way to learn the real status is to let the user pick "System" or
   * "Both" and attempt a capture (which is what surfaces the OS prompt).
   * Only `unavailable` and `permission_denied` actually block selection.
   */
  protected readonly systemAudioSelectable = computed(() => {
    const kind = this.systemAudioStatus().kind;
    return kind === 'available' || kind === 'unknown';
  });

  protected readonly unavailableReason = computed<string | null>(() => {
    const status = this.systemAudioStatus();
    if (status.kind === 'unavailable') {
      return status.reason;
    }
    if (status.kind === 'permission_denied') {
      return 'System audio permission was denied.';
    }
    return null;
  });

  protected readonly showGrantPermission = computed(
    () => this.systemAudioStatus().kind === 'permission_denied'
  );

  protected readonly restartRequired = computed(() => {
    const status = this.systemAudioStatus();
    return status.kind === 'permission_denied' && status.restartRequired;
  });

  protected readonly showHeadphonesHint = computed(() => this.captureSource() === 'mixed');

  protected isOptionDisabled(value: CaptureSource): boolean {
    if (this.disabled()) {
      return true;
    }
    return value !== 'microphone' && !this.systemAudioSelectable();
  }

  protected onSelect(value: CaptureSource): void {
    if (this.isOptionDisabled(value)) {
      return;
    }
    this.sourceSelected.emit(value);
  }

  protected onRequestPermission(): void {
    this.permissionRequested.emit();
  }
}
