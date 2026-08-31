import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { distinctUntilChanged, map } from 'rxjs';

import { MeetingsFacade } from '../../../application/facades/meetings.facade';
import type { CaptureSource } from '../../../core/models/capture-source.model';
import type { FolderId } from '../../../core/models/folder.model';
import type { MeetingId } from '../../../core/models/meeting.model';
import { toMeetingId } from '../../../core/models/meeting.model';
import type { MeetingExportFormat } from '../../../core/ports/meeting-repository.port';
import { AttributionComponent } from '../../components/attribution/attribution.component';
import type { SummaryEdit, SummaryLoadRequest } from '../../components/meeting-detail-pane/meeting-detail-pane.component';
import { MeetingDetailPaneComponent } from '../../components/meeting-detail-pane/meeting-detail-pane.component';
import type { MeetingDragMoveRequest } from '../../components/meeting-sidebar/meeting-sidebar.component';
import { MeetingSidebarComponent } from '../../components/meeting-sidebar/meeting-sidebar.component';
import { RecordControlComponent } from '../../components/record-control/record-control.component';
import type { SpeakerRename, TranscriptSelectionSpeakerAssignment, TranscriptSegmentEdit, TranscriptSegmentSpeakerReassign } from '../../components/transcript-view/transcript-view.component';
import { formatMmSs } from '../../utils/format-display.util';
import { buildExportFilename, CHECKING_SYSTEM_AUDIO, runMeetingDeleted, runMeetingMoveRequested } from './meetings-shell.page.support';

/**
 * The single window: a persistent title bar (brand + always-visible record
 * control) above a two-pane Mail/Notes-style layout (sidebar + detail pane).
 * Owns every `MeetingsFacade` call; every child component below it is dumb.
 */
@Component({
  selector: 'app-meetings-shell-page',
  imports: [MeetingSidebarComponent, MeetingDetailPaneComponent, RecordControlComponent, AttributionComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './meetings-shell.page.html',
  styleUrl: './meetings-shell.page.scss',
})
export class MeetingsShellPage implements OnInit {
  protected readonly facade = inject(MeetingsFacade);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly showAbout = signal(false);
  /** Local, ephemeral UI-only flag — true only for the duration of the in-flight export call. */
  protected readonly exporting = signal(false);
  /**
   * Local, ephemeral UI-only flag — true only for the duration of the
   * in-flight `diarizeMeeting` call, mirroring `exporting`. Distinct from
   * `facade.importing()` (which `diarizeMeeting` ALSO sets, for mutual
   * exclusion with import/re-transcribe): this one identifies THIS specific
   * operation, so the "Detect speakers" button only shows its own running
   * state — never borrows a spinner from an unrelated in-flight
   * import/re-transcribe.
   */
  protected readonly diarizing = signal(false);

  protected readonly modelsReady = computed(() => this.facade.modelsStatus()?.allPresent === true);
  protected readonly systemAudioStatus = computed(
    () => this.facade.systemAudioStatus() ?? CHECKING_SYSTEM_AUDIO,
  );

  protected readonly elapsedSec = signal(0);
  protected readonly elapsedLabel = computed(() => formatMmSs(this.elapsedSec()));

  /**
   * Id of the meeting currently being recorded, if any. During a recording
   * the recording meeting IS the selected meeting (`startRecording` sets it,
   * and the busy-guard in `onMeetingSelected` blocks selection from
   * changing), so `busy()` + `selectedMeeting()?.id` identifies it.
   */
  protected readonly recordingMeetingId = computed<MeetingId | undefined>(() =>
    this.facade.busy() ? this.facade.selectedMeeting()?.id : undefined,
  );

  private timerHandle: ReturnType<typeof setInterval> | undefined;

  constructor() {
    // Drives the live elapsed timer purely off `recordingState`, independent
    // of transcript/level events, so it never stalls or drifts with them.
    effect(() => {
      const isRecording = this.facade.recordingState() === 'recording';
      if (isRecording && this.timerHandle === undefined) {
        this.elapsedSec.set(0);
        this.timerHandle = setInterval(() => this.elapsedSec.update((value) => value + 1), 1000);
      } else if (!isRecording && this.timerHandle !== undefined) {
        clearInterval(this.timerHandle);
        this.timerHandle = undefined;
      }
    });

    this.destroyRef.onDestroy(() => {
      if (this.timerHandle !== undefined) {
        clearInterval(this.timerHandle);
      }
    });
  }

  ngOnInit(): void {
    void this.facade.loadMeetings();
    void this.facade.loadTemplates();
    void this.facade.checkModels();
    void this.facade.loadDevices();
    void this.facade.checkSystemAudio();
    void this.facade.loadSummaryLanguages();
    void this.facade.loadAppVersion();
    void this.facade.loadAudioSources();
    void this.facade.loadFolders();

    // Reactive, not a one-time `snapshot` read: `''` and `meeting/:id` share
    // this same component, and Angular's default route-reuse strategy keeps
    // the instance alive (never re-running `ngOnInit`) across navigations
    // between two `meeting/:id` activations that only differ by param — a
    // second sidebar selection would otherwise never re-open a meeting.
    this.route.paramMap
      .pipe(
        map((params) => params.get('id')),
        distinctUntilChanged(),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((id) => {
        if (id) {
          void this.facade.openMeeting(toMeetingId(id));
        } else {
          this.facade.clearSelection();
        }
      });
  }

  onGoHome(): void {
    void this.router.navigate(['/meetings']);
  }

  toggleAbout(): void {
    this.showAbout.update((value) => !value);
  }

  onBackdropActivate(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      this.toggleAbout();
    }
  }

  onBackdropKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Escape') {
      event.preventDefault();
      this.toggleAbout();
    }
  }

  onDeviceChanged(name: string): void {
    this.facade.selectDevice(name);
  }

  onSourceSelected(source: CaptureSource): void {
    this.facade.selectCaptureSource(source);
  }

  onAudioSourceSelected(id: string): void {
    this.facade.selectAudioSource(id);
  }

  onPermissionRequested(): void {
    void this.facade.requestSystemAudioPermission();
  }

  onRecord(): void {
    void this.facade.startRecording('', this.facade.selectedDevice()?.name);
  }

  onStop(): void {
    void this.facade.stopRecording();
  }

  onCancel(): void {
    void this.facade.cancelRecording();
  }

  onMeetingSelected(id: MeetingId): void {
    if (this.facade.busy() || this.facade.importing()) {
      return;
    }
    void this.router.navigate(['/meetings/meeting', id]);
  }

  onMeetingRenamed(title: string): void {
    const meeting = this.facade.selectedMeeting();
    if (!meeting) {
      return;
    }
    void this.facade.renameMeeting(meeting.id, title);
  }

  onSegmentEdited(edit: TranscriptSegmentEdit): void {
    const meeting = this.facade.selectedMeeting();
    if (!meeting) {
      return;
    }
    void this.facade.editTranscriptSegment(meeting.id, edit.index, edit.text);
  }

  /**
   * Commits a speaker-chip rename through the facade (never a use case
   * directly — presentation talks to facades only). An empty `name` clears
   * the display name, restoring the derived label; the facade captures the
   * undo inverse and refreshes the selected meeting from the persisted one.
   */
  onSpeakerRenamed(rename: SpeakerRename): void {
    const meeting = this.facade.selectedMeeting();
    if (!meeting) {
      return;
    }
    void this.facade.renameSpeaker(meeting.id, rename.label, rename.name);
  }

  /**
   * Commits a speaker-chip segment reassign through the facade (never a use
   * case directly — presentation talks to facades only). The batched
   * `setSegmentSpeakers` entry point keeps the undo history honest: a
   * single-index reassign collapses to the plain `'reassign'` op.
   */
  onSegmentSpeakerReassigned(reassign: TranscriptSegmentSpeakerReassign): void {
    const meeting = this.facade.selectedMeeting();
    if (!meeting) {
      return;
    }
    void this.facade.setSegmentSpeakers(meeting.id, [reassign.index], reassign.speaker);
  }

  /**
   * Commits a selection-toolbar assignment through the facade. ALL indices
   * go into one batched `setSegmentSpeakers` call — one compound undo entry.
   */
  onSelectionSpeakerAssigned(assignment: TranscriptSelectionSpeakerAssignment): void {
    const meeting = this.facade.selectedMeeting();
    if (!meeting) {
      return;
    }
    void this.facade.setSegmentSpeakers(meeting.id, [...assignment.indices], assignment.speaker);
  }

  onMeetingDeleted(id: MeetingId): void {
    runMeetingDeleted(this.facade, this.router, id);
  }

  /**
   * Drag-and-drop and the kebab menu's "move to folder" option are both
   * first-class ways to move or archive a meeting; this is the drag-and-drop
   * handler — it routes by the drop target's `kind`, always via
   * `facade.placeMeeting` with `previousId`/`nextId` both `null` (the backend
   * resolves that to `Placement::Keep` — container change only, matching
   * today's behaviour but as one write instead of two). Archiving preserves
   * the meeting's CURRENT folder — looked up from `facade.meetings()` — so a
   * meeting dragged to the archive never loses its filing. See
   * `onMeetingArchiveToggled`/`onMeetingFolderChanged` for the kebab-menu
   * equivalents.
   */
  onMeetingMoveRequested(request: MeetingDragMoveRequest): void {
    runMeetingMoveRequested(this.facade, this.facade.meetings(), request);
  }

  /** Kebab-menu Archive/Unarchive — see `MeetingListItemComponent.archiveToggled`. */
  onMeetingArchiveToggled(event: { id: MeetingId; archived: boolean }): void {
    void this.facade.setMeetingArchived(event.id, event.archived);
  }

  /** Kebab-menu "move to folder" (including "No folder") — see `MeetingListItemComponent.folderChanged`. */
  onMeetingFolderChanged(event: { id: MeetingId; folderId: FolderId | null }): void {
    void this.facade.setMeetingFolder(event.id, event.folderId);
  }

  reload(): void {
    const current = this.facade.selectedMeeting();
    if (current) {
      void this.facade.openMeeting(current.id);
    }
  }

  /**
   * Wired to the detail pane's `retryRequested`, which is now emitted from
   * the hoisted error banner regardless of which pane is showing — not just
   * the meeting-selected detail branch. With a meeting selected, "retry"
   * still means re-opening it (`reload()`, unchanged). With no meeting
   * selected (e.g. an import rejected before any placeholder meeting was
   * created — see meeting-detail-pane.component.html), `reload()` is a
   * no-op, so retry instead just dismisses the error so the user can try
   * again from a clean state.
   */
  onErrorRetryClicked(): void {
    if (this.facade.selectedMeeting()) {
      this.reload();
    } else {
      this.facade.clearError();
    }
  }

  recheckModels(): void {
    void this.facade.checkModels();
  }

  summarize(templateName: string): void {
    const meeting = this.facade.selectedMeeting();
    const template = this.facade.templates().find((candidate) => candidate.name === templateName);
    if (!meeting || !template) {
      return;
    }
    void this.facade.summarizeMeeting(meeting.id, template);
  }

  cancelSummary(): void {
    void this.facade.cancelSummarization();
  }

  onSummaryLanguageSelected(code: string): void {
    this.facade.selectSummaryLanguage(code);
  }

  onSummaryLoadRequested(request: SummaryLoadRequest): void {
    void this.facade.loadSummary(request.meetingId, request.template, request.language);
  }

  onSummaryEdited(edit: SummaryEdit): void {
    void this.facade.editSummary(edit.meetingId, edit.template, edit.language, edit.markdown);
  }

  onSplitRatioChanged(ratio: number): void {
    this.facade.setSplitRatio(ratio);
  }

  onTranscriptCollapsedChanged(collapsed: boolean): void {
    this.facade.setTranscriptCollapsed(collapsed);
  }

  exportMeeting(format: MeetingExportFormat): void {
    const meeting = this.facade.selectedMeeting();
    if (!meeting) {
      return;
    }
    this.exporting.set(true);
    void this.facade
      .exportMeeting(meeting.id, format, buildExportFilename(meeting))
      .finally(() => this.exporting.set(false));
  }

  onImportRequested(): void {
    void this.facade.importAudio();
  }

  onRetranscribeRequested(): void {
    const meeting = this.facade.selectedMeeting();
    if (!meeting) {
      return;
    }
    void this.facade.retranscribeMeeting(meeting.id, false);
  }

  onReplaceAudioRequested(): void {
    const meeting = this.facade.selectedMeeting();
    if (!meeting) {
      return;
    }
    void this.facade.retranscribeMeeting(meeting.id, true);
  }

  onCancelImportRequested(): void {
    void this.facade.cancelImport();
  }

  onDiarizeRequested(): void {
    const meeting = this.facade.selectedMeeting();
    if (!meeting) {
      return;
    }
    this.diarizing.set(true);
    void this.facade.diarizeMeeting(meeting.id).finally(() => this.diarizing.set(false));
  }

  onFolderCreated(name: string): void {
    void this.facade.createFolder(name);
  }

  onFolderRenamed(event: { id: FolderId; name: string }): void {
    void this.facade.renameFolder(event.id, event.name);
  }

  onFolderDeleted(id: FolderId): void {
    void this.facade.deleteFolder(id);
  }

  onFolderToggled(id: FolderId): void {
    this.facade.toggleFolderExpanded(id);
  }
}
