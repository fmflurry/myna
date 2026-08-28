import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

import type { Meeting, MeetingId } from '../../../core/models/meeting.model';
import { MeetingListItemComponent } from '../meeting-list-item/meeting-list-item.component';

/**
 * Fixed-width, scrollable left sidebar: a search field filtering by title,
 * then the meeting list. Owns no facade calls — the shell page wires
 * selection and deletion through to `MeetingsFacade`.
 */
@Component({
  selector: 'app-meeting-sidebar',
  imports: [MeetingListItemComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './meeting-sidebar.component.html',
  styleUrl: './meeting-sidebar.component.scss',
})
export class MeetingSidebarComponent {
  readonly meetings = input<readonly Meeting[]>([]);
  readonly selectedId = input<MeetingId | undefined>(undefined);
  /** True while a recording is in progress; rows stay visible but show why selection is blocked. */
  readonly selectionDisabled = input(false);

  readonly meetingSelected = output<MeetingId>();
  readonly meetingDeleted = output<MeetingId>();

  protected readonly query = signal('');

  protected readonly filteredMeetings = computed(() => {
    const needle = this.query().trim().toLowerCase();
    if (!needle) {
      return this.meetings();
    }
    return this.meetings().filter((meeting) => meeting.title.toLowerCase().includes(needle));
  });

  onQueryInput(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }
}
