import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import type { Transcript } from '../../../core/models/transcript.model';
import { formatMmSs } from '../../utils/format-display.util';
import { EditableSegmentComponent } from '../editable-segment/editable-segment.component';

/** An inline edit committed for the segment at `index` in the current transcript. */
export interface TranscriptSegmentEdit {
  readonly index: number;
  readonly text: string;
}

/**
 * Rendering of a persisted meeting transcript with mm:ss timestamps. Each
 * segment's text is inline-editable via `EditableSegmentComponent` unless
 * `editable` is false (e.g. while the meeting is still recording).
 */
@Component({
  selector: 'app-transcript-view',
  imports: [EditableSegmentComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './transcript-view.component.html',
  styleUrl: './transcript-view.component.scss',
})
export class TranscriptViewComponent {
  readonly transcript = input<Transcript | undefined>(undefined);
  readonly editable = input(true);

  readonly segmentEdited = output<TranscriptSegmentEdit>();

  formatTimestamp(seconds: number): string {
    return formatMmSs(seconds);
  }

  protected onSegmentEdited(index: number, text: string): void {
    this.segmentEdited.emit({ index, text });
  }
}
