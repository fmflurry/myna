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

import {
  DEFAULT_SIDEBAR_WIDTH_PX,
  MAX_SIDEBAR_WIDTH_PX,
  MIN_SIDEBAR_WIDTH_PX,
  clampSidebarWidth,
} from '../../../core/models/sidebar-layout.model';

/** Pixels the splitter moves per arrow-key press when focused. */
const KEYBOARD_STEP_PX = 8;

/**
 * Pixel-based, presentational sidebar splitter with a draggable divider and
 * a collapsible sidebar. Knows nothing about meetings or persistence —
 * callers project content into the `sidebar`/`content` slots via
 * `<div sidebar>` / `<div content>` and own persistence of `widthPx`/
 * `collapsed` themselves; this component only reports changes via
 * `widthPxChanged`/`collapsedChanged`, so it never needs to inject anything.
 *
 * The divider follows the WAI-ARIA window-splitter pattern: `role="separator"`,
 * `aria-orientation="vertical"` (the divider bar itself is a vertical line),
 * and ArrowLeft/ArrowRight/Home/End resize it when focused. Collapsed, the
 * sidebar is replaced by a thin clickable rail that reopens it at its
 * PREVIOUS width — `internalWidth` is never reset by collapsing, only ever
 * synced from the `widthPx` input (never while a drag is in progress, so
 * a parent re-render mid-drag can't fight the pointer).
 */
@Component({
  selector: 'app-sidebar-splitter',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './sidebar-splitter.component.html',
  styleUrl: './sidebar-splitter.component.scss',
})
export class SidebarSplitterComponent {
  readonly widthPx = input<number>(DEFAULT_SIDEBAR_WIDTH_PX);
  readonly collapsed = input<boolean>(false);
  /** Accessible name fragment for the sidebar, e.g. `'meetings'` — read out as "Show meetings" / "Hide meetings". */
  readonly sidebarLabel = input<string>('sidebar');
  /** `id` of the sidebar pane, targeted by the toggle's `aria-controls`. */
  readonly panelId = input<string>('meetings-sidebar');

  readonly widthPxChanged = output<number>();
  readonly collapsedChanged = output<boolean>();

  private readonly container = viewChild.required<ElementRef<HTMLElement>>('container');
  private readonly toggleButton = viewChild<ElementRef<HTMLButtonElement>>('toggleButton');

  protected readonly dragging = signal(false);
  protected readonly internalWidth = signal(clampSidebarWidth(this.widthPx()));
  protected readonly internalCollapsed = signal(this.collapsed());

  /**
   * Class fields bound to an imported constant render as `undefined` in
   * templates under some bundle evaluation orders (repo-known quirk) — a
   * method reading the live binding works everywhere, so the ARIA bounds
   * below go through these instead of fields.
   */
  protected minWidth(): number {
    return MIN_SIDEBAR_WIDTH_PX;
  }

  protected maxWidth(): number {
    return MAX_SIDEBAR_WIDTH_PX;
  }
  protected readonly ariaValueNow = computed(() => this.internalWidth());
  protected readonly toggleLabel = computed(() =>
    this.internalCollapsed() ? `Show ${this.sidebarLabel()}` : `Hide ${this.sidebarLabel()}`,
  );
  /** Toggle tooltip: the action label plus the Cmd/Ctrl+B shortcut that triggers it from anywhere. */
  protected readonly toggleTitle = computed(() => `${this.toggleLabel()} (⌘B / Ctrl+B)`);

  constructor() {
    // Tracks ONLY `widthPx` (the input) — `dragging` is read `untracked`
    // purely as a guard, never as a trigger. Reacting to `dragging` itself
    // would re-run this the instant a drag ends and stomp the
    // just-committed `internalWidth` back to the input's still-stale value
    // (the parent hasn't re-rendered with the newly emitted width yet).
    // Once the parent DOES catch up, `widthPx` changes and this applies
    // it — by then it's a no-op, since it already matches.
    effect(() => {
      const width = this.widthPx();
      if (!untracked(() => this.dragging())) {
        this.internalWidth.set(clampSidebarWidth(width));
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
    this.internalWidth.set(clampSidebarWidth(event.clientX - rect.left));
  }

  @HostListener('window:pointerup')
  protected onWindowPointerUp(): void {
    if (!this.dragging()) {
      return;
    }
    this.dragging.set(false);
    this.widthPxChanged.emit(this.internalWidth());
  }

  onDividerKeydown(event: KeyboardEvent): void {
    let next: number | null = null;
    if (event.key === 'ArrowRight') {
      next = this.internalWidth() + KEYBOARD_STEP_PX;
    } else if (event.key === 'ArrowLeft') {
      next = this.internalWidth() - KEYBOARD_STEP_PX;
    } else if (event.key === 'Home') {
      next = MIN_SIDEBAR_WIDTH_PX;
    } else if (event.key === 'End') {
      next = MAX_SIDEBAR_WIDTH_PX;
    } else {
      return;
    }
    event.preventDefault();
    const clamped = clampSidebarWidth(next);
    this.internalWidth.set(clamped);
    this.widthPxChanged.emit(clamped);
  }

  onToggleClick(event: Event): void {
    event.stopPropagation();
    const next = !this.internalCollapsed();
    this.internalCollapsed.set(next);
    this.collapsedChanged.emit(next);
    // The toggle persists in both states, so it is both the collapse target
    // and the expand return point — keep keyboard focus on it across the
    // unmount/remount of the sidebar pane (programmatic toggles are covered
    // by the shell's `moveFocusToSidebarToggle` effect).
    this.toggleButton()?.nativeElement.focus();
  }
}
