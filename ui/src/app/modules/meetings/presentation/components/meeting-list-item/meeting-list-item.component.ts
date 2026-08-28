import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

import type { Meeting, MeetingId } from '../../../core/models/meeting.model';
import { formatMeetingListMeta, formatMeetingTitle } from '../../utils/format-display.util';

/** Shown as a tooltip on a row while selection is disabled (e.g. mid-recording). */
export const SELECTION_DISABLED_HINT = 'Selection is disabled while a recording is in progress';

/** Emitted when the row's archive control is toggled — reversible, no confirmation step. */
export interface MeetingArchiveRequest {
  readonly id: MeetingId;
  readonly archived: boolean;
}

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
  /** True when this row's meeting is the one currently being recorded — swaps the delete confirm to a stop-and-discard warning. */
  readonly recording = input(false);

  readonly opened = output<MeetingId>();
  readonly deleteRequested = output<MeetingId>();
  readonly archiveToggleRequested = output<MeetingArchiveRequest>();

  protected readonly confirmingDelete = signal(false);
  protected readonly confirmLabel = computed(() =>
    this.recording()
      ? 'Stop and discard this recording? The audio and transcript will be deleted.'
      : 'Delete?',
  );
  protected readonly archiveLabel = computed(() =>
    this.meeting().archived ? 'Unarchive meeting' : 'Archive meeting',
  );
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

  toggleArchive(event: Event): void {
    event.stopPropagation();
    this.archiveToggleRequested.emit({ id: this.meeting().id, archived: !this.meeting().archived });
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
