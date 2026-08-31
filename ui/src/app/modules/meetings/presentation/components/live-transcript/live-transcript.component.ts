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

import {
  speakerAccentIndex,
  speakerDisplayName,
  speakerRole,
  type Speaker,
  type TranscriptSegment,
} from '../../../core/models/transcript.model';
import { formatMmSs } from '../../utils/format-display.util';

/** Pixel tolerance for treating the scroll position as "pinned to bottom". */
const BOTTOM_TOLERANCE_PX = 24;

/** Size of the fixed CSS accent palette; see `.speaker-accent-N` in the stylesheet. */
const SPEAKER_ACCENT_PALETTE_SIZE = 6;

/**
 * Finalized segments and the two streaming partials (one per speaker slot)
 * are explicit inputs — never a single merged `Transcript` with a sentinel
 * to tell them apart. `finalizedSegments` only ever grows; the partials are
 * transient and are cleared by the store the moment the next final segment
 * arrives.
 */
@Component({
  selector: 'app-live-transcript',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './live-transcript.component.html',
  styleUrl: './live-transcript.component.scss',
})
export class LiveTranscriptComponent {
  readonly finalizedSegments = input.required<readonly TranscriptSegment[]>();
  readonly partialTextMe = input<string>('');
  readonly partialTextOthers = input<string>('');

  readonly isEmpty = computed(
    () => this.finalizedSegments().length === 0 && !this.partialTextMe() && !this.partialTextOthers(),
  );

  private readonly scrollContainer = viewChild<ElementRef<HTMLElement>>('scrollContainer');

  /** Whether the viewport should keep following new content to the bottom. */
  private readonly pinnedToBottom = signal(true);

  constructor() {
    afterRenderEffect(() => {
      // Reading all three signals here re-runs this effect after every new
      // final or partial update renders, so the auto-scroll stays in sync.
      this.finalizedSegments();
      this.partialTextMe();
      this.partialTextOthers();
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

  /** `''` for `unknown` — renderers must never fabricate attribution the app doesn't have. */
  speakerLabel(speaker: Speaker): string {
    return speakerDisplayName(speaker);
  }

  /** Whether `speaker` carries real attribution chrome should render for. */
  hasSpeakerLabel(speaker: Speaker): boolean {
    return speakerRole(speaker) !== 'unknown';
  }

  /** Stable CSS accent class for `speaker`, from the fixed-size palette. */
  speakerAccentClass(speaker: Speaker): string {
    return `speaker-accent-${speakerAccentIndex(speaker, SPEAKER_ACCENT_PALETTE_SIZE)}`;
  }
}
