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
import type { CaptureSource, SystemAudioStatus } from '../../../core/models/capture-source.model';
import type { FolderId } from '../../../core/models/folder.model';
import type { Meeting, MeetingId } from '../../../core/models/meeting.model';
import { toMeetingId } from '../../../core/models/meeting.model';
import type { MeetingExportFormat } from '../../../core/ports/meeting-repository.port';
import { AttributionComponent } from '../../components/attribution/attribution.component';
import type { SummaryEdit, SummaryLoadRequest } from '../../components/meeting-detail-pane/meeting-detail-pane.component';
import { MeetingDetailPaneComponent } from '../../components/meeting-detail-pane/meeting-detail-pane.component';
import type { MeetingDragMoveRequest } from '../../components/meeting-sidebar/meeting-sidebar.component';
import { MeetingSidebarComponent } from '../../components/meeting-sidebar/meeting-sidebar.component';
import { RecordControlComponent } from '../../components/record-control/record-control.component';
import type { TranscriptSegmentEdit } from '../../components/transcript-view/transcript-view.component';
import { formatMmSs } from '../../utils/format-display.util';

/**
 * Shown to the capture-source-picker before `checkSystemAudio()` has
 * resolved. `unknown`, not `unavailable` — there is no preflight API for
 * the audio permission, so the system/mixed options must stay selectable
 * even during this brief window, not just once the check settles.
 */
const CHECKING_SYSTEM_AUDIO: SystemAudioStatus = { kind: 'unknown' };

const ISO_DATE_LENGTH = 10;

const buildExportFilename = (meeting: Meeting): string => {
  const isoDate = meeting.createdAt.toISOString().slice(0, ISO_DATE_LENGTH);
  return `${meeting.title} - ${isoDate}`;
};

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

  onMeetingDeleted(id: MeetingId): void {
    if (this.facade.busy() && this.facade.selectedMeeting()?.id === id) {
      // There is no finished recording session on disk to stop first —
      // `cancelRecording()` stops the session and wipes the meeting dir,
      // including audio.wav, instead of `deleteMeeting()`.
      void this.facade.cancelRecording().then(() => this.router.navigate(['/meetings']));
      return;
    }
    void this.facade.deleteMeeting(id).then(() => {
      if (this.facade.selectedMeeting() === undefined) {
        void this.router.navigate(['/meetings']);
      }
    });
  }

  /**
   * Drag-and-drop is the only way to move or archive a meeting — this is the
   * sole handler for both; it routes by the drop target's `kind`, always via
   * `facade.placeMeeting` with `previousId`/`nextId` both `null` (the backend
   * resolves that to `Placement::Keep` — container change only, matching
   * today's behaviour but as one write instead of two). Archiving preserves
   * the meeting's CURRENT folder — looked up from `facade.meetings()` — so a
   * meeting dragged to the archive never loses its filing.
   */
  onMeetingMoveRequested(request: MeetingDragMoveRequest): void {
    const { target } = request;
    if (target.kind === 'placement') {
      const { container, previousId, nextId } = target;
      if (container.kind === 'archive') {
        void this.facade.placeMeeting(request.id, this.currentFolderId(request.id), true, previousId, nextId);
        return;
      }
      const folderId = container.kind === 'folder' ? container.folderId : null;
      void this.facade.placeMeeting(request.id, folderId, false, previousId, nextId);
      return;
    }
    if (target.kind === 'archive') {
      void this.facade.placeMeeting(request.id, this.currentFolderId(request.id), true, null, null);
      return;
    }
    const folderId = target.kind === 'folder' ? target.folderId : null;
    void this.facade.placeMeeting(request.id, folderId, false, null, null);
  }

  /** The meeting's CURRENT folder (or `null`), looked up from `facade.meetings()` — used to preserve filing when archiving. */
  private currentFolderId(id: MeetingId): FolderId | null {
    return this.facade.meetings().find((meeting) => meeting.id === id)?.folderId ?? null;
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
