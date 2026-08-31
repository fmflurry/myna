import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

import type { Folder, FolderId } from '../../../core/models/folder.model';
import type { Meeting, MeetingId } from '../../../core/models/meeting.model';
import { MeetingListItemComponent } from '../meeting-list-item/meeting-list-item.component';
import type { DropEdge } from '../../utils/reorder-geometry.util';

type FolderSectionMode = 'idle' | 'renaming' | 'confirming-delete';

/**
 * One folder's disclosure in the sidebar: a header (toggle, inline rename,
 * two-step delete confirm) plus its meetings rendered as a listbox — mirrors
 * the archive disclosure precedent in
 * `meeting-sidebar.component.ts`/`.html`. Dumb component: no facade
 * injection, no mutation of its own inputs. The shell page owns every
 * mutation triggered by the outputs below.
 */
@Component({
  selector: 'app-folder-section',
  imports: [MeetingListItemComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './folder-section.component.html',
  styleUrl: './folder-section.component.scss',
  // Mirrors the `dropAccepting`/`dragOver`-driven classes and the
  // dragover/dragleave/drop listeners bound in the template on the inner
  // `.folder-section` div — but bound on the component's HOST element
  // (`<app-folder-section>`) too. The sidebar's drag coordinator dispatches
  // drops directly onto that host tag (it never sees the div nested inside
  // it), and a native DOM event dispatched on an element only reaches that
  // element and its ANCESTORS, never its descendants — so the div's own
  // bindings alone cannot see a drop performed from the parent's DOM. The
  // in-isolation folder-section spec, conversely, dispatches directly on the
  // inner div, which then bubbles up to these host bindings — so a single
  // set of host listeners correctly covers both call sites.
  host: {
    '[class.drop-accepting]': 'dropAccepting()',
    '[class.drop-hover]': 'effectiveHover()',
    '(dragover)': 'onDragOver($event)',
    '(dragleave)': 'onDragLeave()',
    '(drop)': 'onDrop($event)',
  },
})
export class FolderSectionComponent {
  readonly folder = input.required<Folder>();
  readonly meetings = input<readonly Meeting[]>([]);
  readonly expanded = input(false);
  readonly selectedId = input<MeetingId | null>(null);
  readonly selectionDisabled = input(false);
  readonly recordingMeetingId = input<MeetingId | null>(null);
  /** True to make this folder's rows native HTML5 drag sources. */
  readonly dragEnabled = input(false);
  /** True while this folder is a legal drop target for the meeting currently being dragged. */
  readonly dropAccepting = input(false);
  /** True to make every row in this folder a row-level reorder drop target — forwarded uniformly to each row; see `MeetingListItemComponent.dropIndicatorEnabled`. */
  readonly rowDropEnabled = input(false);
  /** All folders, forwarded uniformly to each row's kebab menu — see `MeetingListItemComponent.folders`. */
  readonly folders = input<readonly Folder[]>([]);

  readonly toggled = output<FolderId>();
  readonly renamed = output<{ id: FolderId; name: string }>();
  readonly deleted = output<FolderId>();
  readonly meetingSelected = output<MeetingId>();
  readonly meetingDeleted = output<MeetingId>();
  readonly meetingDragStarted = output<MeetingId>();
  readonly meetingDragEnded = output<void>();
  /** Emitted with this folder's id when a meeting is dropped while `dropAccepting()` is true. */
  readonly dropped = output<FolderId>();
  /** Forwards a row-level reorder drop, with the dropped-on row's id attached. */
  readonly meetingDropOnRow = output<{ id: MeetingId; edge: DropEdge }>();
  /** Forwards an Alt+Arrow keyboard reorder request from a row. */
  readonly meetingReorderRequested = output<{ id: MeetingId; direction: 'up' | 'down' }>();
  /** Re-emits a row's kebab-menu Archive/Unarchive action — see `MeetingListItemComponent.archiveToggled`. */
  readonly meetingArchiveToggled = output<{ id: MeetingId; archived: boolean }>();
  /** Re-emits a row's kebab-menu "move to folder" action — see `MeetingListItemComponent.folderChanged`. */
  readonly meetingFolderChanged = output<{ id: MeetingId; folderId: FolderId | null }>();

  protected readonly mode = signal<FolderSectionMode>('idle');
  protected readonly renameDraft = signal('');
  protected readonly bodyId = computed(() => `folder-meetings-${this.folder().id}`);
  protected readonly dragOver = signal(false);
  /**
   * `dragOver()` alone can go stale: it is only cleared by a `dragleave`/
   * `drop` on THIS element, but the sidebar clears the drag gesture (and
   * therefore `dropAccepting()`) from a `dragend` fired on a totally
   * different element (the dragged row), which this component never sees.
   * Gating the visible hover state on both signals means it self-clears the
   * instant `dropAccepting()` drops, with no extra wiring required.
   */
  protected readonly effectiveHover = computed(() => this.dragOver() && this.dropAccepting());

  onToggleClick(event: Event): void {
    event.stopPropagation();
    this.toggled.emit(this.folder().id);
  }

  startRename(event: Event): void {
    event.stopPropagation();
    this.renameDraft.set(this.folder().name);
    this.mode.set('renaming');
  }

  onRenameInput(event: Event): void {
    this.renameDraft.set((event.target as HTMLInputElement).value);
  }

  /** Commits the trimmed draft via `renamed`; a blank draft is ignored and leaves the input open. */
  commitRename(event: Event): void {
    event.stopPropagation();
    const trimmed = this.renameDraft().trim();
    if (!trimmed) {
      return;
    }
    this.mode.set('idle');
    this.renamed.emit({ id: this.folder().id, name: trimmed });
  }

  cancelRename(event: Event): void {
    event.stopPropagation();
    this.mode.set('idle');
  }

  startDelete(event: Event): void {
    event.stopPropagation();
    this.mode.set('confirming-delete');
  }

  confirmDelete(event: Event): void {
    event.stopPropagation();
    this.mode.set('idle');
    this.deleted.emit(this.folder().id);
  }

  cancelDelete(event: Event): void {
    event.stopPropagation();
    this.mode.set('idle');
  }

  /** Backs out of rename/delete without emitting anything — bound on `.folder-header` so it fires regardless of which control has focus. */
  onHeaderEscape(event: Event): void {
    if (this.mode() !== 'idle') {
      event.stopPropagation();
      this.mode.set('idle');
    }
  }

  onDragOver(event: DragEvent): void {
    if (!this.dropAccepting()) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    this.dragOver.set(true);
  }

  onDragLeave(): void {
    this.dragOver.set(false);
  }

  onDrop(event: DragEvent): void {
    this.dragOver.set(false);
    if (!this.dropAccepting()) {
      return;
    }
    event.preventDefault();
    this.dropped.emit(this.folder().id);
  }
}
