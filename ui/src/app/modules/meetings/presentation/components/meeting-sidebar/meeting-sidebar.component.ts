import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

import type { Folder, FolderId } from '../../../core/models/folder.model';
import type { Meeting, MeetingId } from '../../../core/models/meeting.model';
import { FolderSectionComponent } from '../folder-section/folder-section.component';
import { MeetingListItemComponent } from '../meeting-list-item/meeting-list-item.component';
import { isLegalArchiveTarget, isLegalFolderTarget, isLegalUncategorizedTarget } from '../../utils/drop-legality.util';
import type { DropEdge } from '../../utils/reorder-geometry.util';
import type { MeetingContainer } from '../../utils/reorder-target.util';
import { resolveKeyboardSwapPlacement, resolveRowDropPlacement } from '../../utils/reorder-target.util';

export type { MeetingContainer } from '../../utils/reorder-target.util';

/** One folder paired with the (already search-filtered) meetings it contains. */
interface FolderView {
  readonly folder: Folder;
  readonly meetings: readonly Meeting[];
}

/** Where a dragged meeting was dropped — either a container-level move, or a row-level placement within/into a container. */
export type MeetingMoveTarget =
  | MeetingContainer
  | {
      readonly kind: 'placement';
      readonly container: MeetingContainer;
      readonly previousId: MeetingId | null;
      readonly nextId: MeetingId | null;
    };

/** Emitted once a drag-and-drop move resolves to a legal drop target. */
export interface MeetingDragMoveRequest {
  readonly id: MeetingId;
  readonly target: MeetingMoveTarget;
}

/**
 * Fixed-width, scrollable left sidebar: a search field filtering by title,
 * uncategorized meetings, one disclosure per folder, a "new folder"
 * affordance, and the archive disclosure pinned last. Owns no facade calls —
 * the shell page wires selection, deletion, and folder mutations through to
 * `MeetingsFacade`.
 */
@Component({
  selector: 'app-meeting-sidebar',
  imports: [MeetingListItemComponent, FolderSectionComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './meeting-sidebar.component.html',
  styleUrl: './meeting-sidebar.component.scss',
})
export class MeetingSidebarComponent {
  readonly meetings = input<readonly Meeting[]>([]);
  readonly folders = input<readonly Folder[]>([]);
  readonly expandedFolders = input<ReadonlySet<FolderId>>(new Set());
  readonly selectedId = input<MeetingId | undefined>(undefined);
  /** True while a recording is in progress; rows stay visible but show why selection is blocked. */
  readonly selectionDisabled = input(false);
  /** Id of the meeting currently being recorded, if any — forwarded to the matching row's `recording` input. */
  readonly recordingMeetingId = input<MeetingId | undefined>(undefined);
  /** True while a recording or an audio import/re-transcribe is in progress; disables the header Import button. */
  readonly importDisabled = input(false);

  readonly meetingSelected = output<MeetingId>();
  readonly meetingDeleted = output<MeetingId>();
  readonly importRequested = output<void>();
  readonly folderCreated = output<string>();
  readonly folderRenamed = output<{ id: FolderId; name: string }>();
  readonly folderDeleted = output<FolderId>();
  readonly folderToggled = output<FolderId>();
  /** Emitted once a drag-and-drop gesture resolves to a legal drop target. */
  readonly meetingMoveRequested = output<MeetingDragMoveRequest>();
  /** Pass-through of a row's kebab-menu Archive/Unarchive action — see `MeetingListItemComponent.archiveToggled`. */
  readonly meetingArchiveToggled = output<{ id: MeetingId; archived: boolean }>();
  /** Pass-through of a row's kebab-menu "move to folder" action — see `MeetingListItemComponent.folderChanged`. */
  readonly meetingFolderChanged = output<{ id: MeetingId; folderId: FolderId | null }>();

  protected readonly query = signal('');
  private readonly archiveManuallyExpanded = signal(false);
  protected readonly creatingFolder = signal(false);
  protected readonly newFolderDraft = signal('');
  /** Id of the meeting currently being dragged — the ONLY carrier of drag state; never `DataTransfer` (jsdom has neither `DragEvent` nor `DataTransfer`). */
  private readonly draggingMeetingId = signal<MeetingId | null>(null);
  /**
   * Plain (non-reactive) snapshot of the dragged meeting, set alongside
   * `draggingMeetingId` on drag start. Per spec `drop` always fires before
   * `dragend`, so `draggedMeeting()` below is normally all a drop handler
   * needs — this snapshot only matters if that order ever flips (observed
   * as a real risk with Tauri/WKWebView's native drag coordination): unlike
   * `draggingMeetingId`, it is NOT cleared synchronously by
   * `onRowDragEnded`, so a `drop` that the platform fires immediately after
   * a (premature) `dragend` can still resolve which meeting was dragged.
   */
  private draggedSnapshot: Meeting | null = null;

  private readonly matches = computed(() => {
    const needle = this.query().trim().toLowerCase();
    if (!needle) {
      return this.meetings();
    }
    return this.meetings().filter((meeting) => meeting.title.toLowerCase().includes(needle));
  });

  private readonly knownFolderIds = computed(() => new Set(this.folders().map((folder) => folder.id)));

  /**
   * Non-archived meetings with no folder assignment — rendered in the
   * original, unscoped `.list`. Also catches the dangling-id case: a
   * `folderId` that names no folder in `folders()` (the backend never
   * validates it, see `delete_folder`) must still render here instead of
   * vanishing.
   */
  protected readonly uncategorizedMeetings = computed(() =>
    this.matches().filter(
      (meeting) =>
        !meeting.archived &&
        (meeting.folderId === undefined || !this.knownFolderIds().has(meeting.folderId)),
    ),
  );
  protected readonly archivedMeetings = computed(() => this.matches().filter((meeting) => meeting.archived));

  /** Auto-opens while a search has archived hits, so a match is never hidden behind a collapsed section. */
  protected readonly archiveExpanded = computed(
    () =>
      this.archiveManuallyExpanded() ||
      (this.query().trim().length > 0 && this.archivedMeetings().length > 0),
  );

  protected readonly sortedFolders = computed(() => [...this.folders()].sort((a, b) => a.position - b.position));

  /** One view per folder, in `position` order; while a search is active, folders with zero hits are dropped entirely. */
  protected readonly folderViews = computed<readonly FolderView[]>(() => {
    const hasQuery = this.query().trim().length > 0;
    return this.sortedFolders()
      .map((folder) => ({ folder, meetings: this.meetingsInFolder(folder.id) }))
      .filter((view) => !hasQuery || view.meetings.length > 0);
  });

  /** True once any section (uncategorized, a folder, or archive) has at least one hit — drives the "no match" message. */
  protected readonly hasAnyMatches = computed(
    () =>
      this.uncategorizedMeetings().length > 0 ||
      this.archivedMeetings().length > 0 ||
      this.sortedFolders().some((folder) => this.meetingsInFolder(folder.id).length > 0),
  );

  private meetingsInFolder(folderId: FolderId): readonly Meeting[] {
    return this.matches().filter((meeting) => !meeting.archived && meeting.folderId === folderId);
  }

  /** The meeting currently being dragged, looked up from the (unfiltered) `meetings()` input — `null` when no drag is in progress. */
  protected readonly draggedMeeting = computed<Meeting | null>(() => {
    const id = this.draggingMeetingId();
    if (id === null) {
      return null;
    }
    return this.meetings().find((meeting) => meeting.id === id) ?? null;
  });

  /** True for the whole duration of a drag gesture — drives the archive section's empty-state drop target. */
  protected readonly dragActive = computed(() => this.draggingMeetingId() !== null);

  /** Legal only outside a search (a filtered container makes "between these two rows" ill-defined) and never for the row currently being dragged (a no-op drop onto itself). */
  protected rowDropEnabled(rowId: MeetingId): boolean {
    return this.dragActive() && this.query().trim().length === 0 && rowId !== this.draggingMeetingId();
  }

  /** `container`'s rendered meeting ids, in on-screen order — the EXISTING per-container computed, never a new sort/filter. */
  protected renderedIds(container: MeetingContainer): readonly MeetingId[] {
    if (container.kind === 'folder') {
      return this.meetingsInFolder(container.folderId).map((meeting) => meeting.id);
    }
    if (container.kind === 'archive') {
      return this.archivedMeetings().map((meeting) => meeting.id);
    }
    return this.uncategorizedMeetings().map((meeting) => meeting.id);
  }

  /** False when the dragged meeting is already in `folderId` and not archived — archived meetings are always droppable into a folder. */
  protected canDropInFolder(folderId: FolderId): boolean {
    const meeting = this.draggedMeeting();
    if (!meeting) {
      return false;
    }
    return isLegalFolderTarget(meeting, folderId);
  }

  /** False when the dragged meeting already has no folder and is not archived. */
  protected canDropInUncategorized(): boolean {
    const meeting = this.draggedMeeting();
    if (!meeting) {
      return false;
    }
    return isLegalUncategorizedTarget(meeting, this.knownFolderIds());
  }

  /** False when the dragged meeting is already archived. */
  protected canDropInArchive(): boolean {
    const meeting = this.draggedMeeting();
    return meeting !== null && isLegalArchiveTarget(meeting);
  }

  protected onRowDragStarted(id: MeetingId): void {
    this.draggingMeetingId.set(id);
    this.draggedSnapshot = this.meetings().find((meeting) => meeting.id === id) ?? null;
  }

  protected onRowDragEnded(): void {
    this.draggingMeetingId.set(null);
    this.uncategorizedDragHover.set(false);
    this.archiveDragHover.set(false);
    // Deferred, not synchronous: see the `draggedSnapshot` doc comment. A
    // `drop` dispatched synchronously right after this `dragend` still runs
    // (and reads `draggedSnapshot`) before this callback ever fires.
    setTimeout(() => {
      this.draggedSnapshot = null;
    }, 0);
  }

  /**
   * Resolves the dragged meeting for a drop: `draggedMeeting()` covers the
   * spec-compliant order (`drop` before `dragend`); `draggedSnapshot` is the
   * fallback for the hardened, out-of-order case — see its doc comment.
   */
  private resolveDroppedMeeting(): Meeting | null {
    return this.draggedMeeting() ?? this.draggedSnapshot;
  }

  protected onDropOnFolder(folderId: FolderId): void {
    const meeting = this.resolveDroppedMeeting();
    this.draggingMeetingId.set(null);
    if (!meeting) {
      console.warn('[meeting-sidebar] drop on folder ignored: no dragged meeting could be resolved', { folderId });
      return;
    }
    this.draggedSnapshot = null;
    if (!isLegalFolderTarget(meeting, folderId)) {
      console.warn('[meeting-sidebar] drop on folder ignored: not a legal move', { meetingId: meeting.id, folderId });
      return;
    }
    this.meetingMoveRequested.emit({ id: meeting.id, target: { kind: 'folder', folderId } });
  }

  protected onDropOnUncategorized(): void {
    const meeting = this.resolveDroppedMeeting();
    this.draggingMeetingId.set(null);
    if (!meeting) {
      console.warn('[meeting-sidebar] drop on uncategorized ignored: no dragged meeting could be resolved');
      return;
    }
    this.draggedSnapshot = null;
    if (!isLegalUncategorizedTarget(meeting, this.knownFolderIds())) {
      console.warn('[meeting-sidebar] drop on uncategorized ignored: not a legal move', { meetingId: meeting.id });
      return;
    }
    this.meetingMoveRequested.emit({ id: meeting.id, target: { kind: 'uncategorized' } });
  }

  protected onDropOnArchive(): void {
    const meeting = this.resolveDroppedMeeting();
    this.draggingMeetingId.set(null);
    if (!meeting) {
      console.warn('[meeting-sidebar] drop on archive ignored: no dragged meeting could be resolved');
      return;
    }
    this.draggedSnapshot = null;
    if (!isLegalArchiveTarget(meeting)) {
      console.warn('[meeting-sidebar] drop on archive ignored: not a legal move', { meetingId: meeting.id });
      return;
    }
    this.meetingMoveRequested.emit({ id: meeting.id, target: { kind: 'archive' } });
  }

  /** Row-level reorder drop: reuses `resolveDroppedMeeting()` + `resolveRowDropPlacement`; emits nothing when the meeting is missing or the placement is a no-op (e.g. dropping onto its own slot). */
  protected onDropOnRow(anchorId: MeetingId, edge: DropEdge, container: MeetingContainer): void {
    const meeting = this.resolveDroppedMeeting();
    this.draggingMeetingId.set(null);
    if (!meeting) {
      return;
    }
    this.draggedSnapshot = null;
    const target = resolveRowDropPlacement(this.renderedIds(container), meeting.id, anchorId, edge, container);
    if (!target) {
      return;
    }
    this.meetingMoveRequested.emit({ id: meeting.id, target });
  }

  /** Alt+Arrow reorder: swaps `id` with its neighbour in `container`'s rendered order; emits nothing at a container boundary. Same placement pipeline as `onDropOnRow` — no new geometry. */
  protected onKeyboardReorder(id: MeetingId, direction: 'up' | 'down', container: MeetingContainer): void {
    const target = resolveKeyboardSwapPlacement(this.renderedIds(container), id, direction, container);
    if (!target) {
      return;
    }
    this.meetingMoveRequested.emit({ id, target });
  }

  /** True while a legal drop is hovering the uncategorized `.list` — drives the same dashed/solid + text-cue treatment as `FolderSectionComponent`. */
  protected readonly uncategorizedDragHover = signal(false);
  /** Same as `uncategorizedDragHover`, for `section.archive`. */
  protected readonly archiveDragHover = signal(false);

  protected onUncategorizedDragOver(event: DragEvent): void {
    if (!this.canDropInUncategorized()) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    this.uncategorizedDragHover.set(true);
  }

  protected onUncategorizedDragLeave(): void {
    this.uncategorizedDragHover.set(false);
  }

  /**
   * Legality is decided inside `onDropOnUncategorized` itself (not gated
   * here first) so its `draggedSnapshot` fallback actually gets a chance to
   * run — see the doc comment on `draggedSnapshot`. `canDropInUncategorized`
   * (called here in every other test/CSS context) reads the same signal
   * that `onRowDragEnded` clears synchronously, so re-checking it here would
   * just reproduce the race this handler exists to harden against.
   */
  protected onUncategorizedDrop(event: DragEvent): void {
    this.uncategorizedDragHover.set(false);
    event.preventDefault();
    this.onDropOnUncategorized();
  }

  protected onArchiveDragOver(event: DragEvent): void {
    if (!this.canDropInArchive()) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    this.archiveDragHover.set(true);
  }

  protected onArchiveDragLeave(): void {
    this.archiveDragHover.set(false);
  }

  /** Same rationale as `onUncategorizedDrop` — legality is decided inside `onDropOnArchive`. */
  protected onArchiveDrop(event: DragEvent): void {
    this.archiveDragHover.set(false);
    event.preventDefault();
    this.onDropOnArchive();
  }

  onQueryInput(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  toggleArchive(): void {
    this.archiveManuallyExpanded.update((open) => !open);
  }

  /** A folder auto-expands while a search is active (mirrors `archiveExpanded`), otherwise reflects the persisted set. */
  protected isFolderExpanded(folderId: FolderId): boolean {
    return this.query().trim().length > 0 || this.expandedFolders().has(folderId);
  }

  startNewFolder(): void {
    this.newFolderDraft.set('');
    this.creatingFolder.set(true);
  }

  onNewFolderInput(event: Event): void {
    this.newFolderDraft.set((event.target as HTMLInputElement).value);
  }

  /** Commits the trimmed draft via `folderCreated`; a blank draft is ignored and leaves the input open. */
  commitNewFolder(event: Event): void {
    event.stopPropagation();
    const trimmed = this.newFolderDraft().trim();
    if (!trimmed) {
      return;
    }
    this.creatingFolder.set(false);
    this.folderCreated.emit(trimmed);
  }

  cancelNewFolder(event: Event): void {
    event.stopPropagation();
    this.creatingFolder.set(false);
  }
}
