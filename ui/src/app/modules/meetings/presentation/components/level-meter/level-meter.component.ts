import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { AudioLevel } from '../../../core/models/audio-device.model';

const PERCENT_MIN = 0;
const PERCENT_MAX = 100;

/** Renders the live input level as a horizontal bar, driven by `AudioLevel.rms`. */
@Component({
  selector: 'app-level-meter',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './level-meter.component.html',
  styleUrl: './level-meter.component.scss',
})
export class LevelMeterComponent {
  readonly level = input<AudioLevel | undefined>(undefined);

  readonly percent = computed(() => {
    const rms = this.level()?.rms ?? PERCENT_MIN;
    return Math.min(PERCENT_MAX, Math.max(PERCENT_MIN, rms * PERCENT_MAX));
  });
}
