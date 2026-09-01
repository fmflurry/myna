import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, HostListener, computed, effect, input, output, signal } from '@angular/core';

import type {
  MeetingsErrorInfo,
  ModelDownloadState,
  SummaryCacheEntry,
  SummarizingKey,
} from '../../../application/stores/meetings.store';
import type { AudioSource } from '../../../core/models/audio-source.model';
import type { CaptureSource } from '../../../core/models/capture-source.model';
import type { Meeting } from '../../../core/models/meeting.model';
import type { ModelsStatus } from '../../../core/models/models-status.model';
import type { ImportProgress } from '../../../core/ports/audio-import.port';
import type { MeetingExportFormat } from '../../../core/ports/meeting-repository.port';
import type { RecordingState } from '../../../core/models/recording-state.model';
import { DEFAULT_SPLIT_RATIO } from '../../../core/models/split-layout.model';
import type { SummaryLanguage } from '../../../core/models/summary-language.model';
import type { SummaryTemplate } from '../../../core/models/summary-template.model';
import type { TranscriptSegment } from '../../../core/models/transcript.model';
import {
  TRANSCRIPT_TAB_LABEL,
  formatMeetingHeadingDate,
  formatMeetingTitle,
  formatMinutesLong,
  formatTemplateLabel,
} from '../../utils/format-display.util';
import { AudioPlayerComponent } from '../audio-player/audio-player.component';
import { EditableTitleComponent } from '../editable-title/editable-title.component';
import { ErrorStateComponent } from '../error-state/error-state.component';
import { LiveTranscriptComponent } from '../live-transcript/live-transcript.component';
import { OnboardingPanelComponent } from '../onboarding-panel/onboarding-panel.component';
import { SplitWorkspaceComponent } from '../split-workspace/split-workspace.component';
import { SummaryLanguagePickerComponent } from '../summary-language-picker/summary-language-picker.component';
import { SummaryPanelComponent } from '../summary-panel/summary-panel.component';
import type { TranscriptSegmentEdit } from '../transcript-view/transcript-view.component';
import type {
  SpeakerRename,
  TranscriptSectionDelete,
  TranscriptSelectionSpeakerAssignment,
  TranscriptSegmentGroupSpeakerReassign,
  TranscriptSegmentSpeakerReassign,
} from '../transcript-view/transcript-view.component';
import { TranscriptViewComponent } from '../transcript-view/transcript-view.component';
import { WelcomePanelComponent } from '../welcome-panel/welcome-panel.component';
import {
  computeEffectiveCaptureLabel,
  computeGeneratingElsewhereLabel,
  computeIsGeneratingActiveTab,
  computeSummarySelectionTab,
  computeWideActiveTemplate,
  diarizeDisabledReason,
  findExistingSummary,
  findUnloadedSummaryRequest,
  isDiarizeDisabled,
  isSummaryLoading,
  NARROW_BREAKPOINT_PX,
  buildSummaryEdit,
  computeImportProgressLabel,
  computeImportProgressPercent,
  isReplaceAudioDisabled,
  isRetranscribeDisabled,
} from './meeting-detail-pane.component.support';
import type { SummaryEdit, SummaryLoadRequest } from './meeting-detail-pane.component.support';
export type { SummaryEdit, SummaryLoadRequest } from './meeting-detail-pane.component.support';

const TRANSCRIPT_TAB = 'transcript';

const EXPORT_FORMATS: readonly MeetingExportFormat[] = ['markdown', 'txt', 'json'];

/** Frozen fallback registry so `speakerNamesRegistry` never allocates a fresh object per CD pass. */
const EMPTY_SPEAKER_NAMES: Readonly<Record<string, string>> = Object.freeze({});

/**
 * Right-hand detail pane: heading, a horizontal tab strip (Transcript + one
 * tab per summary template), and the active tab's content. Renders the
 * models-missing onboarding block in place of content instead of routing to
 * a separate page. Meta line shows only fields sourced from real data —
 * duration for a saved meeting, capture source for the in-progress
 * recording — never a fabricated speaker count or language.
 */
@Component({
  selector: 'app-meeting-detail-pane',
  imports: [
    AudioPlayerComponent,
    EditableTitleComponent,
    ErrorStateComponent,
    LiveTranscriptComponent,
    NgTemplateOutlet,
    OnboardingPanelComponent,
    SplitWorkspaceComponent,
    SummaryLanguagePickerComponent,
    SummaryPanelComponent,
    TranscriptViewComponent,
    WelcomePanelComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './meeting-detail-pane.component.html',
  styleUrl: './meeting-detail-pane.component.scss',
})
export class MeetingDetailPaneComponent {
  readonly meeting = input<Meeting | undefined>(undefined);
  readonly modelsReady = input.required<boolean>();
  readonly modelsStatus = input<ModelsStatus | undefined>(undefined);
  readonly modelDownload = input<ModelDownloadState | undefined>(undefined);
  readonly recordingState = input.required<RecordingState>();
  readonly finalizedSegments = input<readonly TranscriptSegment[]>([]);
  readonly partialTextMe = input('');
  readonly partialTextOthers = input('');
  readonly templates = input<readonly SummaryTemplate[]>([]);
  readonly summaryStream = input('');
  /** True while ANYTHING is generating, regardless of tab — see `isGeneratingActiveTab` for the per-tab check. */
  readonly summarizing = input(false);
  /** Identity of the (template, language) pair currently generating, or `null` when nothing is. */
  readonly summarizingKey = input<SummarizingKey | null>(null);
  readonly error = input<MeetingsErrorInfo | undefined>(undefined);
  readonly captureSource = input.required<CaptureSource>();
  /**
   * The system-audio source the recorder actually attached, or `null` when
   * none is (not requested, or the tap silently fell back to microphone
   * only). Drives `metaLine` during a live recording so this meta line can
   * never contradict the title-bar's own effective-source readout.
   */
  readonly effectiveSystemSource = input<AudioSource | null>(null);
  readonly summaryLanguages = input<readonly SummaryLanguage[]>([]);
  readonly selectedSummaryLanguage = input.required<string>();
  /** Load state of persisted summaries fetched via `get_summary`, keyed by `summaryCacheKey`. */
  readonly summaryCache = input<ReadonlyMap<string, SummaryCacheEntry>>(new Map());
  /** True for the duration of an in-flight export call; shows activity instead of a dead-looking button. */
  readonly exporting = input(false);
  /** Fraction of the wide-layout split workspace the transcript column occupies. Persisted; a fresh session falls back to {@link DEFAULT_SPLIT_RATIO}. */
  readonly splitRatio = input<number>(DEFAULT_SPLIT_RATIO);
  /** Whether the transcript column is collapsed to its reopen rail. Persisted. */
  readonly transcriptCollapsed = input(false);
  /** True while a recording is starting up, forwarded to the welcome panel's Start a meeting button. */
  readonly startingRecording = input(false);
  /** True while an audio import or re-transcribe is running for THIS meeting. */
  readonly importing = input(false);
  /** Latest `import://progress` event for the in-flight import/re-transcribe, or `null` once none is running. */
  readonly importProgress = input<ImportProgress | null>(null);
  /** Whether `audio.wav` exists on disk for this meeting — gates "Re-transcribe from audio". */
  readonly hasAudio = input(false);
  /** Whether `track-system.wav` exists on disk for this meeting — gates "Detect speakers". */
  readonly hasSystemTrack = input(false);
  /** True for the duration of an in-flight `diarizeMeeting` call; shows activity on the "Detect speakers" button specifically (never borrowed from an unrelated `importing`). */
  readonly diarizing = input(false);
  /** Transcript-undo button label (from `describeTranscriptOp`); `null` hides the button. */
  readonly transcriptUndoLabel = input<string | null>(null);
  /** Speaker-undo button label (from `describeSpeakerOp` on the stack top); `null` hides the button. */
  readonly speakerUndoLabel = input<string | null>(null);

  readonly renameRequested = output<string>();
  readonly segmentEdited = output<TranscriptSegmentEdit>();
  /** Re-emitted from `app-transcript-view`'s chip-menu ops; see `meetings-shell.page.ts` for the facade wiring. */
  readonly speakerRenamed = output<SpeakerRename>();
  readonly speakerRemoved = output<string>();
  readonly segmentSpeakerReassigned = output<TranscriptSegmentSpeakerReassign>();
  readonly segmentGroupSpeakerReassigned = output<TranscriptSegmentGroupSpeakerReassign>();
  /** Re-emitted from `app-transcript-view`'s confirm-guarded "Delete section…"; see `meetings-shell.page.ts` for the facade wiring. */
  readonly sectionDeleted = output<TranscriptSectionDelete>();
  /** Re-emitted from `app-transcript-view`'s floating selection toolbar; see `meetings-shell.page.ts` for the facade wiring. */
  readonly selectionSpeakerAssigned = output<TranscriptSelectionSpeakerAssignment>();
  /** Emitted by the transcript toolbar's Undo buttons; the shell maps them onto the two undo slots. */
  readonly undoTranscriptRequested = output<void>();
  readonly undoSpeakerRequested = output<void>();
  readonly summarizeRequested = output<string>();
  readonly cancelSummaryRequested = output<void>();
  readonly exportRequested = output<MeetingExportFormat>();
  readonly retryRequested = output<void>();
  readonly recheckModelsRequested = output<void>();
  readonly downloadRequested = output<void>();
  readonly downloadCancelRequested = output<void>();
  readonly summaryLanguageSelected = output<string>();
  /** Emitted when the active tab has a persisted-but-unloaded summary ref that needs fetching. */
  readonly summaryLoadRequested = output<SummaryLoadRequest>();
  /** Re-emitted from `app-summary-panel`'s edit mode with the (meeting, template, language) context of the edited summary. */
  readonly summaryEdited = output<SummaryEdit>();
  readonly splitRatioChanged = output<number>();
  readonly transcriptCollapsedChanged = output<boolean>();
  /** Re-emitted from `app-welcome-panel`'s Start a meeting button — see `meetings-shell.page.ts` for the wiring. */
  readonly startRecordingRequested = output<void>();
  /** Re-emitted from `app-welcome-panel`'s secondary Import a recording button. */
  readonly importRequested = output<void>();
  readonly retranscribeRequested = output<void>();
  readonly replaceAudioRequested = output<void>();
  readonly cancelImportRequested = output<void>();
  /** User-triggered speaker detection over this meeting's system-audio track; see `meetings-shell.page.ts` for the wiring. */
  readonly diarizeRequested = output<void>();

  protected readonly transcriptTab = TRANSCRIPT_TAB;
  protected readonly exportFormats = EXPORT_FORMATS;
  protected readonly activeTab = signal<string>(TRANSCRIPT_TAB);
  protected readonly exportFormat = signal<MeetingExportFormat>('markdown');

  protected readonly viewportWidth = signal(typeof window === 'undefined' ? NARROW_BREAKPOINT_PX : window.innerWidth);

  @HostListener('window:resize')
  protected onWindowResize(): void {
    this.viewportWidth.set(window.innerWidth);
  }

  /** True when the workspace must fall back to the narrow single-column tabbed layout — see {@link NARROW_BREAKPOINT_PX}. */
  protected readonly isNarrow = computed(() => this.viewportWidth() < NARROW_BREAKPOINT_PX);

  protected readonly isLive = computed(() => this.recordingState() !== 'idle');

  /**
   * Drives the transcript column: a live import re-uses the same streaming
   * view as a live recording. A diarize-only run over an already-saved
   * meeting does NOT — it shares the `importing` slot but has nothing to
   * stream, so it gets its own loading placeholder instead of this empty
   * live view.
   */
  protected readonly showLiveTranscript = computed(
    () => this.isLive() || (this.importing() && !this.diarizing()),
  );

  protected readonly importProgressLabel = computed(() =>
    computeImportProgressLabel(this.importing(), this.importProgress()),
  );
  protected readonly importProgressPercent = computed(() => computeImportProgressPercent(this.importProgress()));
  protected readonly retranscribeDisabled = computed(() =>
    isRetranscribeDisabled(this.hasAudio(), this.isLive(), this.importing()),
  );
  protected readonly replaceAudioDisabled = computed(() => isReplaceAudioDisabled(this.isLive(), this.importing()));

  /** Whether the diarization models (pyannote segmentation + NeMo TitaNet embedding) are present on disk. */
  protected readonly diarizationModelsPresent = computed(() => this.modelsStatus()?.diarization?.present ?? false);
  /** See {@link isDiarizeDisabled}. `isLive()` is passed both as `busy` (silent, matches every other reingest control) and as the explicit `recording` flag that drives the surfaced reason below. */
  protected readonly diarizeDisabled = computed(() =>
    isDiarizeDisabled(
      this.diarizationModelsPresent(),
      this.hasSystemTrack(),
      this.isLive(),
      this.importing(),
      this.diarizing(),
      this.isLive(),
    ),
  );
  /** See {@link diarizeDisabledReason}. The recording reason takes precedence over the other durable reasons while a recording is in progress. */
  protected readonly diarizeDisabledReason = computed<string | undefined>(() =>
    diarizeDisabledReason(
      this.diarizationModelsPresent(),
      this.hasSystemTrack(),
      this.modelsStatus()?.diarization?.path ?? '',
      this.isLive(),
    ),
  );
  /** Drives the "some audio wasn't transcribed" recovery warning near the transcript. */
  protected readonly hasDroppedAudio = computed(() => (this.meeting()?.droppedAudioChunks ?? 0) > 0);

  /** See {@link computeWideActiveTemplate}. */
  protected readonly wideActiveTemplate = computed(() =>
    computeWideActiveTemplate(this.activeTab(), this.transcriptTab, this.templates()),
  );

  /** See {@link computeSummarySelectionTab}. */
  protected readonly summarySelectionTab = computed(() =>
    computeSummarySelectionTab(this.isNarrow(), this.activeTab(), this.wideActiveTemplate()),
  );

  protected readonly headingDate = computed(() => {
    const current = this.meeting();
    return current ? formatMeetingHeadingDate(current.createdAt) : '';
  });

  protected readonly displayTitle = computed(() => formatMeetingTitle(this.meeting()?.title ?? ''));

  /** The selected meeting's speaker-name registry, with a FROZEN stable fallback so the transcript view's input never flips identity per CD pass. */
  protected readonly speakerNamesRegistry = computed<Readonly<Record<string, string>>>(
    () => this.meeting()?.speakerNames ?? EMPTY_SPEAKER_NAMES,
  );

  protected readonly metaLine = computed(() => {
    if (this.isLive()) {
      return `Recording · ${this.effectiveCaptureLabel()}`;
    }
    const current = this.meeting();
    return current ? formatMinutesLong(current.durationSec) : '';
  });

  /** See {@link computeEffectiveCaptureLabel}. Idle/saved meetings never call this — `metaLine` shows duration then. */
  protected readonly effectiveCaptureLabel = computed(() =>
    computeEffectiveCaptureLabel(this.captureSource(), this.effectiveSystemSource()),
  );

  protected readonly activeTemplateLabel = computed(() => {
    const template = this.templates().find((candidate) => candidate.name === this.summarySelectionTab());
    return template ? formatTemplateLabel(template) : this.summarySelectionTab();
  });

  protected readonly activeLanguageLabel = computed(() => {
    const code = this.selectedSummaryLanguage();
    return this.summaryLanguages().find((language) => language.code === code)?.label ?? code;
  });

  /** See {@link findExistingSummary}. A ref whose `markdown` is still `''` is resolved from `summaryCache` instead — see the constructor `effect` below, which requests that fetch. */
  protected readonly existingSummary = computed(() =>
    findExistingSummary(this.meeting(), this.summaryCache(), this.summarySelectionTab(), this.selectedSummaryLanguage()),
  );

  /** See {@link isSummaryLoading}. */
  protected readonly summaryLoading = computed(() =>
    isSummaryLoading(this.meeting(), this.summaryCache(), this.summarySelectionTab(), this.selectedSummaryLanguage()),
  );

  /** See {@link computeIsGeneratingActiveTab}. Gates the loader, the streaming tokens, and Cancel — never the bare `summarizing` flag. */
  protected readonly isGeneratingActiveTab = computed(() =>
    computeIsGeneratingActiveTab(this.summarizingKey(), this.summarySelectionTab(), this.selectedSummaryLanguage()),
  );

  /** See {@link computeGeneratingElsewhereLabel}. */
  protected readonly generatingElsewhereLabel = computed(() =>
    computeGeneratingElsewhereLabel(this.summarizingKey(), this.isGeneratingActiveTab(), this.templates()),
  );

  constructor() {
    // Requests a fetch whenever the active tab shows a persisted-but-unloaded
    // summary ref — see {@link findUnloadedSummaryRequest}. Re-running as
    // `summaryCache` itself changes is intentional: once the facade records a
    // 'loading' (then 'loaded'/'empty') entry for this exact key, the guard
    // inside that helper stops emitting further requests for it.
    effect(() => {
      const request = findUnloadedSummaryRequest(
        this.meeting(),
        this.summarySelectionTab(),
        this.transcriptTab,
        this.selectedSummaryLanguage(),
        this.summaryCache(),
      );
      if (request) {
        this.summaryLoadRequested.emit(request);
      }
    });
  }

  protected templateLabel(template: SummaryTemplate): string {
    return formatTemplateLabel(template);
  }

  protected transcriptTabLabel(): string {
    return TRANSCRIPT_TAB_LABEL;
  }

  selectTab(tab: string): void {
    this.activeTab.set(tab);
  }

  setExportFormat(format: MeetingExportFormat): void {
    this.exportFormat.set(format);
  }

  onExportFormatChange(event: Event): void {
    this.setExportFormat((event.target as HTMLSelectElement).value as MeetingExportFormat);
  }

  export(): void {
    this.exportRequested.emit(this.exportFormat());
  }

  generateSummary(): void {
    this.summarizeRequested.emit(this.summarySelectionTab());
  }

  onSummaryLanguageSelected(code: string): void {
    this.summaryLanguageSelected.emit(code);
  }

  /** Tags the panel's raw edited markdown with the summary it was edited against. */
  onSummaryEdited(markdown: string): void {
    const current = this.meeting();
    if (!current) {
      return;
    }
    this.summaryEdited.emit(
      buildSummaryEdit(current, this.summarySelectionTab(), this.selectedSummaryLanguage(), markdown),
    );
  }

  retranscribe(): void {
    this.retranscribeRequested.emit();
  }
  replaceAudio(): void {
    this.replaceAudioRequested.emit();
  }
  diarize(): void {
    this.diarizeRequested.emit();
  }
}
