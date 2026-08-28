import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  effect,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';

import { DEFAULT_SPLIT_RATIO, clampSplitRatio } from '../../../core/models/split-layout.model';

/** Fraction the divider moves per arrow-key press when focused. */
const KEYBOARD_STEP = 0.02;

/**
 * Generic, presentational two-column workspace with a draggable divider and
 * a collapsible left column. Knows nothing about transcripts or summaries —
 * callers project content into the `left`/`right` slots via `<div left>` /
 * `<div right>` and own persistence of `splitRatio`/`collapsed` themselves;
 * this component only reports changes via `splitRatioChanged`/
 * `collapsedChanged`, so it never needs to inject anything.
 *
 * The divider follows the WAI-ARIA window-splitter pattern: `role="separator"`,
 * `aria-orientation="vertical"` (the divider bar itself is a vertical line),
 * and ArrowLeft/ArrowRight resize it when focused. Collapsed, the left
 * column is replaced by a thin clickable rail that reopens it at its
 * PREVIOUS ratio — `internalRatio` is never reset by collapsing, only ever
 * synced from the `splitRatio` input (never while a drag is in progress, so
 * a parent re-render mid-drag can't fight the pointer).
 */
@Component({
  selector: 'app-split-workspace',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './split-workspace.component.html',
  styleUrl: './split-workspace.component.scss',
})
export class SplitWorkspaceComponent {
  readonly splitRatio = input<number>(DEFAULT_SPLIT_RATIO);
  readonly collapsed = input<boolean>(false);
  /** Accessible name fragment for the left column, e.g. `'transcript'` — read out as "Show transcript" / "Hide transcript". */
  readonly leftLabel = input<string>('left panel');

  readonly splitRatioChanged = output<number>();
  readonly collapsedChanged = output<boolean>();

  private readonly container = viewChild.required<ElementRef<HTMLElement>>('container');

  protected readonly dragging = signal(false);
  protected readonly internalRatio = signal(clampSplitRatio(this.splitRatio()));
  protected readonly internalCollapsed = signal(this.collapsed());

  /** Rounded to 2 decimal places of percent so float drift (e.g. `0.4 + 0.02`) never reaches the DOM as `42.00000000000001%`. */
  protected readonly leftWidthPercent = computed(() => Math.round(this.internalRatio() * 10000) / 100);
  protected readonly ariaValueNow = computed(() => Math.round(this.internalRatio() * 100));
  protected readonly toggleLabel = computed(() =>
    this.internalCollapsed() ? `Show ${this.leftLabel()}` : `Hide ${this.leftLabel()}`,
  );

  constructor() {
    // Tracks ONLY `splitRatio` (the input) — `dragging` is read `untracked`
    // purely as a guard, never as a trigger. Reacting to `dragging` itself
    // would re-run this the instant a drag ends and stomp the
    // just-committed `internalRatio` back to the input's still-stale value
    // (the parent hasn't re-rendered with the newly emitted ratio yet).
    // Once the parent DOES catch up, `splitRatio` changes and this applies
    // it — by then it's a no-op, since it already matches.
    effect(() => {
      const ratio = this.splitRatio();
      if (!untracked(() => this.dragging())) {
        this.internalRatio.set(clampSplitRatio(ratio));
      }
    });
    effect(() => {
      this.internalCollapsed.set(this.collapsed());
    });
  }

  onDividerPointerDown(event: PointerEvent): void {
    if ((event.target as HTMLElement).closest('.collapse-toggle')) {
      return;
    }
    event.preventDefault();
    this.dragging.set(true);
  }

  @HostListener('window:pointermove', ['$event'])
  protected onWindowPointerMove(event: PointerEvent): void {
    if (!this.dragging()) {
      return;
    }
    const rect = this.container().nativeElement.getBoundingClientRect();
    if (rect.width <= 0) {
      return;
    }
    this.internalRatio.set(clampSplitRatio((event.clientX - rect.left) / rect.width));
  }

  @HostListener('window:pointerup')
  protected onWindowPointerUp(): void {
    if (!this.dragging()) {
      return;
    }
    this.dragging.set(false);
    this.splitRatioChanged.emit(this.internalRatio());
  }

  onDividerKeydown(event: KeyboardEvent): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return;
    }
    event.preventDefault();
    const delta = event.key === 'ArrowRight' ? KEYBOARD_STEP : -KEYBOARD_STEP;
    const next = clampSplitRatio(this.internalRatio() + delta);
    this.internalRatio.set(next);
    this.splitRatioChanged.emit(next);
  }

  onToggleClick(event: Event): void {
    event.stopPropagation();
    const next = !this.internalCollapsed();
    this.internalCollapsed.set(next);
    this.collapsedChanged.emit(next);
  }
}
