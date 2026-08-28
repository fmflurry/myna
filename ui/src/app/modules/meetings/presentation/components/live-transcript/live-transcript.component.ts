import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  input,
  signal,
  viewChild,
} from '@angular/core';

import type { TranscriptSegment } from '../../../core/models/transcript.model';
import { formatMmSs } from '../../utils/format-display.util';

/** Pixel tolerance for treating the scroll position as "pinned to bottom". */
const BOTTOM_TOLERANCE_PX = 24;

/**
 * Finalized segments and the streaming partial are two explicit inputs —
 * never a single merged `Transcript` with a sentinel to tell them apart.
 * `finalizedSegments` only ever grows; `partialText` is transient and is
 * cleared by the store the moment the next final segment arrives.
 */
@Component({
  selector: 'app-live-transcript',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './live-transcript.component.html',
  styleUrl: './live-transcript.component.scss',
})
export class LiveTranscriptComponent {
  readonly finalizedSegments = input.required<readonly TranscriptSegment[]>();
  readonly partialText = input<string>('');

  readonly isEmpty = computed(
    () => this.finalizedSegments().length === 0 && !this.partialText(),
  );

  private readonly scrollContainer = viewChild<ElementRef<HTMLElement>>('scrollContainer');

  /** Whether the viewport should keep following new content to the bottom. */
  private readonly pinnedToBottom = signal(true);

  constructor() {
    afterRenderEffect(() => {
      // Reading both signals here re-runs this effect after every new final
      // or partial update renders, so the auto-scroll stays in sync with it.
      this.finalizedSegments();
      this.partialText();
      const element = this.scrollContainer()?.nativeElement;
      if (element && this.pinnedToBottom()) {
        element.scrollTop = element.scrollHeight;
      }
    });
  }

  /** Re-evaluates whether the user has scrolled away from the bottom. */
  onScroll(event: Event): void {
    const element = event.target as HTMLElement;
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    this.pinnedToBottom.set(distanceFromBottom <= BOTTOM_TOLERANCE_PX);
  }

  formatTimestamp(seconds: number): string {
    return formatMmSs(seconds);
  }
}
