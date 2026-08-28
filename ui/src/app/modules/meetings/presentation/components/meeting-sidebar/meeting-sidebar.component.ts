import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

import type { Meeting, MeetingId } from '../../../core/models/meeting.model';
import type { MeetingArchiveRequest } from '../meeting-list-item/meeting-list-item.component';
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
  /** Id of the meeting currently being recorded, if any — forwarded to the matching row's `recording` input. */
  readonly recordingMeetingId = input<MeetingId | undefined>(undefined);

  readonly meetingSelected = output<MeetingId>();
  readonly meetingDeleted = output<MeetingId>();
  readonly meetingArchiveToggled = output<MeetingArchiveRequest>();

  protected readonly query = signal('');
  private readonly archiveManuallyExpanded = signal(false);

  private readonly matches = computed(() => {
    const needle = this.query().trim().toLowerCase();
    if (!needle) {
      return this.meetings();
    }
    return this.meetings().filter((meeting) => meeting.title.toLowerCase().includes(needle));
  });

  protected readonly activeMeetings = computed(() => this.matches().filter((meeting) => !meeting.archived));
  protected readonly archivedMeetings = computed(() => this.matches().filter((meeting) => meeting.archived));

  /** Auto-opens while a search has archived hits, so a match is never hidden behind a collapsed section. */
  protected readonly archiveExpanded = computed(
    () =>
      this.archiveManuallyExpanded() ||
      (this.query().trim().length > 0 && this.archivedMeetings().length > 0),
  );

  onQueryInput(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  toggleArchive(): void {
    this.archiveManuallyExpanded.update((open) => !open);
  }
}
