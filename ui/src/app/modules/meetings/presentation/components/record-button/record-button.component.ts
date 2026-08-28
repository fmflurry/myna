import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import type { RecordingState } from '../../../core/models/recording-state.model';

/** Dumb control surface for start/stop/cancel — the page owns all facade calls. */
@Component({
  selector: 'app-record-button',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './record-button.component.html',
  styleUrl: './record-button.component.scss',
})
export class RecordButtonComponent {
  readonly state = input.required<RecordingState>();
  readonly disabled = input(false);
  /** True while the STT model is loading in response to a Record click — `state()` is still `'idle'` here. */
  readonly startingRecording = input(false);

  readonly recordClicked = output<void>();
  readonly stopClicked = output<void>();
  readonly cancelClicked = output<void>();
}
