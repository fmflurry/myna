import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  type OnDestroy,
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

/** Maximum number of finalized rows retained in the live DOM. */
const LIVE_WINDOW_SIZE = 250;

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
export class LiveTranscriptComponent implements OnDestroy {
  readonly finalizedSegments = input.required<readonly TranscriptSegment[]>();
  readonly partialTextMe = input<string>('');
  readonly partialTextOthers = input<string>('');

  readonly isEmpty = computed(
    () => this.finalizedSegments().length === 0 && !this.partialTextMe() && !this.partialTextOthers(),
  );

  /** Start index selected by explicit earlier-page navigation. */
  private readonly selectedWindowStart = signal(0);

  /** Finalized rows in the current bounded live page; the complete input remains untouched. */
  readonly visibleFinalizedSegments = computed(() => {
    const segments = this.finalizedSegments();
    const tailStart = this.tailStart(segments.length);
    const windowStart = this.pinnedToBottom() ? tailStart : Math.min(this.selectedWindowStart(), tailStart);
    return segments.slice(windowStart, windowStart + LIVE_WINDOW_SIZE);
  });

  readonly canShowEarlier = computed(() => {
    const segments = this.finalizedSegments();
    const windowStart = this.pinnedToBottom()
      ? this.tailStart(segments.length)
      : Math.min(this.selectedWindowStart(), this.tailStart(segments.length));
    return windowStart > 0;
  });

  readonly canShowNewer = computed(() => !this.pinnedToBottom());

  private readonly scrollContainer = viewChild<ElementRef<HTMLElement>>('scrollContainer');

  /** Whether the viewport should keep following new content to the bottom. */
  private readonly pinnedToBottom = signal(true);

  /** Pending rAF handle, or `null` when no auto-scroll is coalesced for this frame. */
  private pendingScrollFrame: number | null = null;

  constructor() {
    afterRenderEffect(() => {
      // Reading all three signals here re-runs this effect after every new
      // final or partial update, so a burst of streaming updates coalesces
      // into ONE rAF callback — and thus at most one `scrollHeight` layout
      // read — per animation frame instead of one per update.
      this.finalizedSegments();
      this.partialTextMe();
      this.partialTextOthers();
      if (this.pinnedToBottom()) {
        this.scheduleScrollToBottom();
      }
    });
  }

  ngOnDestroy(): void {
    if (this.pendingScrollFrame !== null) {
      cancelAnimationFrame(this.pendingScrollFrame);
      this.pendingScrollFrame = null;
    }
  }

  /** Queues a single scroll-to-bottom for the next frame; repeat calls before the frame fires are no-ops. */
  private scheduleScrollToBottom(): void {
    if (this.pendingScrollFrame !== null) {
      return;
    }
    this.pendingScrollFrame = requestAnimationFrame(() => {
      this.pendingScrollFrame = null;
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
    const isPinnedToBottom = distanceFromBottom <= BOTTOM_TOLERANCE_PX;
    if (this.pinnedToBottom() && !isPinnedToBottom) {
      this.selectedWindowStart.set(this.tailStart(this.finalizedSegments().length));
    }
    this.pinnedToBottom.set(isPinnedToBottom);
  }

  showEarlier(): void {
    const currentStart = this.currentWindowStart();
    this.selectedWindowStart.set(Math.max(0, currentStart - LIVE_WINDOW_SIZE));
    this.pinnedToBottom.set(false);
  }

  showNewer(): void {
    this.selectedWindowStart.set(this.tailStart(this.finalizedSegments().length));
    this.pinnedToBottom.set(true);
  }

  private currentWindowStart(): number {
    const tailStart = this.tailStart(this.finalizedSegments().length);
    return this.pinnedToBottom() ? tailStart : Math.min(this.selectedWindowStart(), tailStart);
  }

  private tailStart(segmentCount: number): number {
    return Math.max(0, segmentCount - LIVE_WINDOW_SIZE);
  }

  formatTimestamp(seconds: number): string {
    return formatMmSs(seconds);
  }

  /**
   * `@for` identity: `TranscriptSegment` carries no id. The finalized list
   * is maintained by sorted insertion (`insertSegmentSorted`), so a
   * mid-list insert shifts the indices that follow it — the index +
   * start-time composite pins rows for the common append case, and any
   * row whose index or `startSec` changes is re-rendered rather than
   * patched in place with stale content.
   */
  trackBySegment(index: number, segment: TranscriptSegment): string {
    return `${index}:${segment.startSec}`;
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
