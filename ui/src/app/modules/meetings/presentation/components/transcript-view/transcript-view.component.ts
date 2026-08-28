import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import type { Transcript } from '../../../core/models/transcript.model';
import { formatMmSs } from '../../utils/format-display.util';

/** Read-only rendering of a persisted meeting transcript with mm:ss timestamps. */
@Component({
  selector: 'app-transcript-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './transcript-view.component.html',
  styleUrl: './transcript-view.component.scss',
})
export class TranscriptViewComponent {
  readonly transcript = input<Transcript | undefined>(undefined);

  formatTimestamp(seconds: number): string {
    return formatMmSs(seconds);
  }
}
