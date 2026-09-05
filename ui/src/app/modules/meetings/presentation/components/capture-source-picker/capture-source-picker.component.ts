import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import type { AudioDevice } from '../../../core/models/audio-device.model';
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

/** Substrings (lowercased) identifying a Bluetooth/HFP input — mirrors `myna_audio::is_bluetooth_input`. */
const BLUETOOTH_INPUT_NEEDLES: readonly string[] = [
  'airpod',
  'bluetooth',
  'hands-free',
  'handsfree',
  'hands free',
  'hfp',
];

/** Name parts (lowercased) marking a built-in microphone — mirrors the Rust fallback preference. */
const BUILTIN_MIC_NEEDLES: readonly string[] = [
  'built-in',
  'builtin',
  'built in',
  'macbook',
  'internal',
];

function isBluetoothInput(name: string): boolean {
  const lower = name.toLowerCase();
  return BLUETOOTH_INPUT_NEEDLES.some((needle) => lower.includes(needle));
}

function isBuiltinMic(name: string): boolean {
  const lower = name.toLowerCase();
  return BUILTIN_MIC_NEEDLES.some((needle) => lower.includes(needle));
}

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
  readonly selectedDeviceName = input<string | null>(null);
  readonly devices = input<readonly AudioDevice[]>([]);
  readonly disabled = input(false);

  readonly sourceSelected = output<CaptureSource>();
  readonly fallbackMicSelected = output<string>();
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

  /**
   * Opening a Bluetooth/HFP mic flips most headsets (e.g. AirPods) from
   * A2DP music quality to SCO call quality, so live output goes quiet. Warn
   * whenever the selected input looks like BT and the source would open it
   * (`system` never touches the input side).
   */
  protected readonly showBluetoothHint = computed(() => {
    const name = this.selectedDeviceName();
    return name !== null && isBluetoothInput(name) && this.captureSource() !== 'system';
  });

  /**
   * Non-BT mic the "Switch" button offers, preferring built-in — `null`
   * when no alternative exists (then only "Use system only" is offered).
   */
  protected readonly fallbackMicName = computed<string | null>(() => {
    const selected = this.selectedDeviceName();
    const nonBt = this.devices().filter(
      (device) => !isBluetoothInput(device.name) && device.name !== selected,
    );
    return nonBt.find((device) => isBuiltinMic(device.name))?.name ?? nonBt[0]?.name ?? null;
  });

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

  protected onUseSystemOnly(): void {
    this.onSelect('system');
  }

  protected onUseFallbackMic(): void {
    const fallback = this.fallbackMicName();
    if (fallback !== null) {
      this.fallbackMicSelected.emit(fallback);
    }
  }
}
