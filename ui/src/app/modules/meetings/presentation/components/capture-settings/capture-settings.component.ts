import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

import type { AudioDevice } from '../../../core/models/audio-device.model';
import type { AudioSource } from '../../../core/models/audio-source.model';
import type { CaptureSource, SystemAudioStatus } from '../../../core/models/capture-source.model';
import { CaptureSourcePickerComponent } from '../capture-source-picker/capture-source-picker.component';
import { SearchableSelectComponent } from '../searchable-select/searchable-select.component';

/** Fallback label for the "all system output" source, shown when no specific app is picked. */
const ALL_SYSTEM_AUDIO_LABEL = 'System';

/**
 * Collapses the microphone-device select and the capture-source picker
 * behind a single compact "Audio ▾" trigger, so the title bar shows the
 * current source in short form instead of dedicating permanent width to a
 * three-way segmented control and a device dropdown. Pure presentation:
 * the owning page (via `RecordControlComponent`) wires every output to
 * `MeetingsFacade`.
 */
@Component({
  selector: 'app-capture-settings',
  imports: [CaptureSourcePickerComponent, SearchableSelectComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './capture-settings.component.html',
  styleUrl: './capture-settings.component.scss',
})
export class CaptureSettingsComponent {
  readonly devices = input<readonly AudioDevice[]>([]);
  readonly selectedDevice = input<AudioDevice | null>(null);
  readonly captureSource = input.required<CaptureSource>();
  readonly systemAudioStatus = input.required<SystemAudioStatus>();
  readonly audioSources = input<readonly AudioSource[]>([]);
  readonly selectedAudioSource = input<string>('');
  readonly disabled = input(false);

  readonly deviceChanged = output<string>();
  readonly sourceSelected = output<CaptureSource>();
  readonly audioSourceSelected = output<string>();
  readonly permissionRequested = output<void>();

  protected readonly expanded = signal(false);

  /**
   * Names the SPECIFIC selected system-audio source (e.g. "Teams") rather
   * than a generic "System" label whenever one is picked, so a fallback
   * (permission denied, or the requested app vanishing) reads clearly once
   * `selectedAudioSource` is later swapped for the effective source.
   */
  private readonly selectedAudioSourceName = computed(
    () => this.audioSources().find((source) => source.id === this.selectedAudioSource())?.name,
  );

  protected readonly triggerLabel = computed(() => {
    const source = this.captureSource();
    const sourceName = this.selectedAudioSourceName() ?? ALL_SYSTEM_AUDIO_LABEL;
    if (source === 'microphone') {
      return 'Audio: Mic only';
    }
    if (source === 'system') {
      return `Audio: ${sourceName}`;
    }
    return sourceName === ALL_SYSTEM_AUDIO_LABEL ? 'Audio: Mic + System' : `Audio: Mic + ${sourceName}`;
  });

  protected toggle(): void {
    this.expanded.update((value) => !value);
  }

  protected onDeviceChange(event: Event): void {
    this.deviceChanged.emit((event.target as HTMLSelectElement).value);
  }

  protected onSourceSelected(source: CaptureSource): void {
    this.sourceSelected.emit(source);
    this.expanded.set(false);
  }

  protected onAudioSourceChange(id: string): void {
    this.audioSourceSelected.emit(id);
  }
}
