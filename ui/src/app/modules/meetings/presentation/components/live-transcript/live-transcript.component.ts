import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  type OnDestroy,
  afterRenderEffect,
  computed,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

import {
  isSuspect,
  speakerAccentIndex,
  speakerDisplayName,
  speakerRole,
  suspectLabel,
  type Speaker,
  type TranscriptSegment,
} from '../../../core/models/transcript.model';
import { formatMmSs } from '../../utils/format-display.util';
import { EditableSegmentComponent } from '../editable-segment/editable-segment.component';

/** Pixel tolerance for treating the scroll position as "pinned to bottom". */
const BOTTOM_TOLERANCE_PX = 24;

/** Size of the fixed CSS accent palette; see `.speaker-accent-N` in the stylesheet. */
const SPEAKER_ACCENT_PALETTE_SIZE = 6;

/** Maximum number of finalized rows retained in the live DOM. */
const LIVE_WINDOW_SIZE = 250;

/** One inline edit committed for the finalized live segment at ABSOLUTE `index`. */
export interface LiveTranscriptSegmentEdit {
  readonly index: number;
  readonly text: string;
}

/**
 * Finalized segments and the two streaming partials (one per speaker slot)
 * are explicit inputs — never a single merged `Transcript` with a sentinel
 * to tell them apart. `finalizedSegments` only ever grows; the partials are
 * transient and are cleared by the store the moment the next final segment
 * arrives.
 */
@Component({
  selector: 'app-live-transcript',
  imports: [EditableSegmentComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './live-transcript.component.html',
  styleUrl: './live-transcript.component.scss',
})
export class LiveTranscriptComponent implements OnDestroy {
  readonly finalizedSegments = input.required<readonly TranscriptSegment[]>();
  readonly partialTextMe = input<string>('');
  readonly partialTextOthers = input<string>('');
  readonly editableLive = input(false);

  readonly liveSegmentEdited = output<LiveTranscriptSegmentEdit>();

  readonly isEmpty = computed(
    () => this.finalizedSegments().length === 0 && !this.partialTextMe() && !this.partialTextOthers(),
  );

  /** Start index selected by explicit earlier-page navigation. */
  private readonly selectedWindowStart = signal(0);

  /** ABSOLUTE index of the first finalized row in the current bounded live page. */
  readonly windowStart = computed(() => {
    const segments = this.finalizedSegments();
    const tailStart = this.tailStart(segments.length);
    return this.pinnedToBottom() ? tailStart : Math.min(this.selectedWindowStart(), tailStart);
  });

  /** Finalized rows in the current bounded live page; the complete input remains untouched. */
  readonly visibleFinalizedSegments = computed(() => {
    const segments = this.finalizedSegments();
    const windowStart = this.windowStart();
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

  /**
   * `scrollTop` the viewport was last known to be at while following (set by
   * our own scroll-to-bottom and by any user scroll that lands at the bottom),
   * or `null` before the first follow. Lets `onScroll` tell "content grew
   * under a viewport that has not moved" apart from "the user scrolled up".
   */
  private followAnchorScrollTop: number | null = null;

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
        // Must stay an instant jump: the stylesheet deliberately has no
        // `scroll-behavior: smooth` because an animated follow reads back
        // through `onScroll` as the user scrolling away (see the .scss).
        element.scrollTop = element.scrollHeight;
        this.followAnchorScrollTop = element.scrollTop;
      }
    });
  }

  /**
   * Re-evaluates whether the user has scrolled away from the bottom.
   *
   * The browser dispatches the `scroll` event for our own scroll-to-bottom
   * one frame late, by which time streaming content may already have grown
   * the container past the tolerance — so "not at the bottom" alone is not
   * evidence of user intent. Only a move UP from where the follow last left
   * the viewport is; a viewport that stayed put keeps following and the
   * already-scheduled next follow catches it up.
   */
  onScroll(event: Event): void {
    const element = event.target as HTMLElement;
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (distanceFromBottom <= BOTTOM_TOLERANCE_PX) {
      this.followAnchorScrollTop = element.scrollTop;
      this.pinnedToBottom.set(true);
      return;
    }
    if (!this.pinnedToBottom()) {
      return;
    }
    if (this.followAnchorScrollTop !== null && element.scrollTop >= this.followAnchorScrollTop) {
      return;
    }
    this.selectedWindowStart.set(this.tailStart(this.finalizedSegments().length));
    this.pinnedToBottom.set(false);
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

  /** Whether a finalized live segment carries any suspect flag worth review. */
  isSuspectSegment(segment: TranscriptSegment): boolean {
    return isSuspect(segment);
  }

  /** Whether a finalized live segment was human-corrected (`edited` stamped by the backend or the optimistic patch). */
  isEditedSegment(segment: TranscriptSegment): boolean {
    return segment.edited === true;
  }

  /** Decoder-original text preserved at first correction; the `Edited` chip tooltip so the audit stays visible without a separate history view. */
  editedTooltip(segment: TranscriptSegment): string {
    return segment.originalText ?? '';
  }

  /** Human-facing label for a single suspect-reason wire value. */
  suspectReasonLabel(reason: string): string {
    return suspectLabel(reason);
  }

  /** Comma-joined human-facing suspect reasons for the badge tooltip. */
  suspectTooltip(segment: TranscriptSegment): string {
    return (segment.suspectReasons ?? []).map((reason) => suspectLabel(reason)).join(', ');
  }

  /** Re-emits an inline edit with its ABSOLUTE transcript index; the parent owns persistence. */
  onLiveSegmentEdited(index: number, text: string): void {
    this.liveSegmentEdited.emit({ index, text });
  }

  /** Stable CSS accent class for `speaker`, from the fixed-size palette. */
  speakerAccentClass(speaker: Speaker): string {
    return `speaker-accent-${speakerAccentIndex(speaker, SPEAKER_ACCENT_PALETTE_SIZE)}`;
  }
}
