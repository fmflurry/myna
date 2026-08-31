import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

import type { Meeting, MeetingId } from '../../../core/models/meeting.model';
import { formatMeetingListMeta, formatMeetingTitle } from '../../utils/format-display.util';
import type { DropEdge } from '../../utils/reorder-geometry.util';
import { resolveDropEdge } from '../../utils/reorder-geometry.util';

/** Shown as a tooltip on a row while selection is disabled (e.g. mid-recording). */
export const SELECTION_DISABLED_HINT = 'Selection is disabled while a recording is in progress';

/**
 * One row in the sidebar meeting list, with an inline two-step delete
 * confirm. Drag-and-drop (see `dragEnabled`/`dragStarted`/`dragEnded`) is the
 * ONLY way to move a meeting to a folder or the archive — there is
 * deliberately no click affordance for either, so a user can never move or
 * archive a meeting without dragging it.
 */
@Component({
  selector: 'app-meeting-list-item',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './meeting-list-item.component.html',
  styleUrl: './meeting-list-item.component.scss',
})
export class MeetingListItemComponent {
  readonly meeting = input.required<Meeting>();
  readonly selected = input(false);
  /** When true, this row shows why it can't be opened instead of silently swallowing the click. */
  readonly disabled = input(false);
  /** True when this row's meeting is the one currently being recorded — swaps the delete confirm to a stop-and-discard warning. */
  readonly recording = input(false);
  /** True when this row's meeting is the one currently being imported/re-transcribed — swaps the delete confirm to a cancel-import warning, mirroring `recording`. */
  readonly importing = input(false);
  /** True to make this row a native HTML5 drag source — false in any host that hasn't wired up drop targets yet. */
  readonly dragEnabled = input(false);
  /** True to make this row itself a row-level reorder drop target — false while reordering isn't legal for this row (e.g. mid-search). */
  readonly dropIndicatorEnabled = input(false);

  readonly opened = output<MeetingId>();
  readonly deleteRequested = output<MeetingId>();
  readonly dragStarted = output<MeetingId>();
  readonly dragEnded = output<void>();
  /** Emitted with the hovered edge when a reorder drop lands on this row. */
  readonly dropOnRow = output<DropEdge>();

  protected readonly confirmingDelete = signal(false);
  /** True while this row is in EITHER busy state — recording or importing — the two states share the same "warn on delete" treatment. */
  protected readonly busy = computed(() => this.recording() || this.importing());
  protected readonly confirmLabel = computed(() => {
    if (this.recording()) {
      return 'Stop and discard this recording? The audio and transcript will be deleted.';
    }
    if (this.importing()) {
      return 'Cancel this import? The partially imported audio and transcript will be deleted.';
    }
    return 'Delete?';
  });
  protected readonly meta = computed(() => formatMeetingListMeta(this.meeting().createdAt, this.meeting().durationSec));
  protected readonly displayTitle = computed(() => formatMeetingTitle(this.meeting().title));
  protected readonly disabledHint = computed<string | null>(() =>
    this.disabled() ? SELECTION_DISABLED_HINT : null,
  );
  protected readonly dropEdge = signal<DropEdge | null>(null);
  /** Staleness guard, mirroring `FolderSectionComponent.effectiveHover`: `dropEdge()` alone can go stale once reordering is no longer legal for this row, so the visible indicator is gated on `dropIndicatorEnabled()` too. */
  protected readonly indicator = computed<DropEdge | null>(() =>
    this.dropIndicatorEnabled() ? this.dropEdge() : null,
  );

  activate(): void {
    // Also guards the keyboard path: a `keydown.enter`/`keydown.space` fired
    // on the Yes/No buttons bubbles up to this row's own listeners, so
    // `confirmingDelete()` must be checked here too — not just relying on
    // the buttons' `stopPropagation()` on `click`.
    if (this.disabled() || this.confirmingDelete()) {
      return;
    }
    this.opened.emit(this.meeting().id);
  }

  requestDelete(event: Event): void {
    event.stopPropagation();
    this.confirmingDelete.set(true);
  }

  cancelDelete(event: Event): void {
    event.stopPropagation();
    this.confirmingDelete.set(false);
  }

  confirmDelete(event: Event): void {
    event.stopPropagation();
    this.confirmingDelete.set(false);
    this.deleteRequested.emit(this.meeting().id);
  }

  /** Escape backs out of the delete confirmation without deleting anything. */
  onEscapeKey(event: Event): void {
    if (!this.confirmingDelete()) {
      return;
    }
    this.cancelDelete(event);
  }

  /**
   * `dragstart`/`dragend` never `stopPropagation()`: the sidebar's drag
   * coordinator (`draggingMeetingId`) listens for both at any ancestor
   * depth — whether this row lives directly in the sidebar or nested inside
   * a folder section — so blocking propagation here would silently break
   * drag tracking. This is unchanged by the row-level reorder drop target
   * below.
   *
   * `dragover`/`drop` split that contract further, and asymmetrically:
   * `onRowDragOver` only `stopPropagation()`s once `dropIndicatorEnabled()`
   * is true — mid-search, where "between these two rows" is ill-defined, it
   * bails immediately so the event bubbles to the container exactly as it
   * did before row-level reordering existed. `onRowDrop`, in contrast,
   * ALWAYS `stopPropagation()`s and always emits: a drop landing on a row
   * already carries its own container via the sidebar's bookkeeping, so the
   * row must own it outright or a single drop would double-fire the
   * container's own (non-reorder) move handler — and it must still fire
   * even if `dropIndicatorEnabled()` flipped false between hover and drop
   * (e.g. a `dragend` firing out of order — see the sidebar's
   * `draggedSnapshot` doc comment), falling back to the `'before'` edge when
   * no `dragover` ever resolved one.
   */
  onDragStart(event: DragEvent): void {
    if (!this.dragEnabled() || this.busy() || this.confirmingDelete()) {
      event.preventDefault();
      return;
    }
    event.dataTransfer?.setData('text/plain', this.meeting().id);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
    }
    this.dragStarted.emit(this.meeting().id);
  }

  /** Same `dragstart`/`dragend` propagation contract as `onDragStart` — see comment there. */
  onDragEnd(): void {
    this.dragEnded.emit();
  }

  /** Resolves and shows this row's own drop indicator — only once `dropIndicatorEnabled()` is true; see the propagation comment on `onDragStart`. */
  onRowDragOver(event: DragEvent): void {
    if (!this.dropIndicatorEnabled()) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.dropEdge.set(resolveDropEdge((event.currentTarget as HTMLElement).getBoundingClientRect(), event.clientY));
  }

  /** Emits `dropOnRow` with the currently hovered edge (or `'before'` if none was resolved) — always, regardless of `dropIndicatorEnabled()`; see the propagation comment on `onDragStart`. */
  onRowDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.dropOnRow.emit(this.dropEdge() ?? 'before');
    this.dropEdge.set(null);
  }

  onRowDragLeave(): void {
    this.dropEdge.set(null);
  }
}
