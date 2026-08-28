import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

import type { Meeting, MeetingId } from '../../../core/models/meeting.model';
import { formatMeetingListMeta, formatMeetingTitle } from '../../utils/format-display.util';

/** Shown as a tooltip on a row while selection is disabled (e.g. mid-recording). */
export const SELECTION_DISABLED_HINT = 'Selection is disabled while a recording is in progress';

/** One row in the sidebar meeting list, with an inline two-step delete confirm. */
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

  readonly opened = output<MeetingId>();
  readonly deleteRequested = output<MeetingId>();

  protected readonly confirmingDelete = signal(false);
  protected readonly meta = computed(() => formatMeetingListMeta(this.meeting().createdAt, this.meeting().durationSec));
  protected readonly displayTitle = computed(() => formatMeetingTitle(this.meeting().title));
  protected readonly disabledHint = computed<string | null>(() =>
    this.disabled() ? SELECTION_DISABLED_HINT : null,
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
}
