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
import type {
  SpeakerRename,
  TranscriptSectionDelete,
  TranscriptSelectionSpeakerAssignment,
  TranscriptSegmentEdit,
  TranscriptSegmentGroupSpeakerReassign,
  TranscriptSegmentSpeakerReassign,
} from '../../components/transcript-view/transcript-view.component';
import { formatMmSs } from '../../utils/format-display.util';
import { buildExportFilename, CHECKING_SYSTEM_AUDIO, describeLatestSpeakerUndo, describeLatestTranscriptUndo, MeetingOpQueue, runErrorRetry, runMeetingDeleted, runMeetingMoveRequested, runStopRecording } from './meetings-shell.page.support';

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

  /** Transcript-undo toolbar button label; `null` hides the button. */
  protected readonly transcriptUndoLabel = computed(() => describeLatestTranscriptUndo(this.facade.transcriptUndo()));
  /** Speaker-undo toolbar button label; `null` hides the button. */
  protected readonly speakerUndoLabel = computed(() => describeLatestSpeakerUndo(this.facade.speakerHistory()));

  private timerHandle: ReturnType<typeof setInterval> | undefined;
  /** Serialises meeting-mutating ops so two unlocked read-modify-writes of meeting.json never overlap — see `MeetingOpQueue`. */
  private readonly meetingOps = new MeetingOpQueue();

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

  /** Stop, then auto-diarize when the finished meeting can be diarized — see `runStopRecording`. */
  onStop(): void {
    void runStopRecording(this.facade, () => this.onDiarizeRequested());
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

  /** Chip-menu rename; the backend rewrites EVERY occurrence of `label`, never just the clicked segment. */
  onSpeakerRenamed(rename: SpeakerRename): void {
    this.withSelectedMeetingId((id) => this.facade.renameSpeaker(id, rename.label, rename.name));
  }

  /** Chip-menu removal (already confirm-guarded in the transcript view); segments fall back to Others. */
  onSpeakerRemoved(label: string): void {
    this.withSelectedMeetingId((id) => this.facade.removeSpeaker(id, label));
  }

  onSegmentSpeakerReassigned(reassign: TranscriptSegmentSpeakerReassign): void {
    this.withSelectedMeetingId((id) => this.facade.setSegmentSpeaker(id, reassign.index, reassign.speaker));
  }

  /** A whole grouped block reassigned via one chip click — ONE compound undo step; see `SpeakerFacade.setSegmentSpeakers`. */
  onSegmentGroupSpeakerReassigned(reassign: TranscriptSegmentGroupSpeakerReassign): void {
    this.withSelectedMeetingId((id) => this.facade.setSegmentSpeakers(id, reassign.indices, reassign.speaker));
  }

  /** Selection-toolbar assignment: ALL indices in ONE batched call — one compound undo entry. */
  onSelectionSpeakerAssigned(assignment: TranscriptSelectionSpeakerAssignment): void {
    this.withSelectedMeetingId((id) => this.facade.setSegmentSpeakers(id, [...assignment.indices], assignment.speaker));
  }

  /** Chip-menu section delete (already confirm-guarded in the transcript view) — ONE compound undo step; see `TranscriptEditingFacade.deleteTranscriptSection`. */
  onSectionDeleted(event: TranscriptSectionDelete): void {
    this.withSelectedMeetingId((id) => this.facade.deleteTranscriptSection(id, event.indices));
  }

  /** Toolbar "Undo" over the transcript-undo slot (delete/merge inverses). */
  onUndoTranscriptRequested(): void {
    void this.facade.undoLastTranscriptOp();
  }

  /** Toolbar "Undo" over the speaker-undo stack. */
  onUndoSpeakerRequested(): void {
    void this.facade.undoLastSpeakerOp();
  }

  /** Runs a meeting mutation against the selected meeting's id, queued behind any in-flight op; a no-op when nothing is selected. */
  private withSelectedMeetingId(run: (id: MeetingId) => Promise<void>): void {
    this.meetingOps.enqueue(this.facade.selectedMeeting(), run);
  }

  onMeetingDeleted(id: MeetingId): void {
    runMeetingDeleted(this.facade, this.router, id);
  }

  /** Drag-and-drop and the kebab's "move to folder" both route through `facade.placeMeeting`; see `runMeetingMoveRequested`. */
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

  /** Retry from the hoisted error banner: re-open the selected meeting, or dismiss when none — see `runErrorRetry`. */
  onErrorRetryClicked(): void {
    runErrorRetry(this.facade);
  }

  recheckModels(): void {
    void this.facade.checkModels();
  }

  startModelDownload(): void {
    void this.facade.initializeModels();
  }

  cancelModelDownload(): void {
    void this.facade.cancelModelDownload();
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
    // Re-entry guard: the auto-run after stop and a manual button click can
    // race; the pane's disabled state is not the only caller anymore.
    if (this.diarizing()) {
      return;
    }
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
