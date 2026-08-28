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
import type { Meeting, MeetingId } from '../../../core/models/meeting.model';
import { toMeetingId } from '../../../core/models/meeting.model';
import type { MeetingExportFormat } from '../../../core/ports/meeting-repository.port';
import { AttributionComponent } from '../../components/attribution/attribution.component';
import type { SummaryLoadRequest } from '../../components/meeting-detail-pane/meeting-detail-pane.component';
import { MeetingDetailPaneComponent } from '../../components/meeting-detail-pane/meeting-detail-pane.component';
import { MeetingSidebarComponent } from '../../components/meeting-sidebar/meeting-sidebar.component';
import { RecordControlComponent } from '../../components/record-control/record-control.component';
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

  protected readonly modelsReady = computed(() => this.facade.modelsStatus()?.allPresent === true);
  protected readonly systemAudioStatus = computed(
    () => this.facade.systemAudioStatus() ?? CHECKING_SYSTEM_AUDIO,
  );

  protected readonly elapsedSec = signal(0);
  protected readonly elapsedLabel = computed(() => formatMmSs(this.elapsedSec()));

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
        }
      });
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
    if (this.facade.busy()) {
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

  onMeetingDeleted(id: MeetingId): void {
    void this.facade.deleteMeeting(id).then(() => {
      if (this.facade.selectedMeeting() === undefined) {
        void this.router.navigate(['/meetings']);
      }
    });
  }

  reload(): void {
    const current = this.facade.selectedMeeting();
    if (current) {
      void this.facade.openMeeting(current.id);
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
}
