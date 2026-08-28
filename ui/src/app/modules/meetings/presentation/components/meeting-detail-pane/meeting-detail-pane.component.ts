import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, HostListener, computed, effect, input, output, signal } from '@angular/core';

import type { SummaryCacheEntry, SummarizingKey } from '../../../application/stores/meetings.store';
import { summaryCacheKey, type MeetingsErrorInfo } from '../../../application/stores/meetings.store';
import type { AudioSource } from '../../../core/models/audio-source.model';
import type { CaptureSource } from '../../../core/models/capture-source.model';
import type { Meeting, MeetingId } from '../../../core/models/meeting.model';
import type { ModelsStatus } from '../../../core/models/models-status.model';
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
import { EditableTitleComponent } from '../editable-title/editable-title.component';
import { ErrorStateComponent } from '../error-state/error-state.component';
import { LiveTranscriptComponent } from '../live-transcript/live-transcript.component';
import { OnboardingPanelComponent } from '../onboarding-panel/onboarding-panel.component';
import { SplitWorkspaceComponent } from '../split-workspace/split-workspace.component';
import { SummaryLanguagePickerComponent } from '../summary-language-picker/summary-language-picker.component';
import { SummaryPanelComponent } from '../summary-panel/summary-panel.component';
import type { TranscriptSegmentEdit } from '../transcript-view/transcript-view.component';
import { TranscriptViewComponent } from '../transcript-view/transcript-view.component';
import { WelcomePanelComponent } from '../welcome-panel/welcome-panel.component';

const TRANSCRIPT_TAB = 'transcript';

/**
 * Below this viewport width, the two-column split workspace no longer fits
 * comfortably (each column would drop under a usable reading measure), so
 * the layout falls back to the narrow single-column tabbed view — the same
 * one this component used before the split workspace existed, transcript
 * tab included. jsdom's default `window.innerWidth` (1024) resolves to
 * narrow, matching the layout every pre-existing spec in this file already
 * asserts against.
 */
const NARROW_BREAKPOINT_PX = 1200;

const EXPORT_FORMATS: readonly MeetingExportFormat[] = ['markdown', 'txt', 'json'];

const CAPTURE_SOURCE_LABELS: Readonly<Record<CaptureSource, string>> = {
  microphone: 'Microphone',
  system: 'System audio',
  mixed: 'Mic + system',
};

/** A request to fetch a persisted summary's content for one (meeting, template, language) triple. */
export interface SummaryLoadRequest {
  readonly meetingId: MeetingId;
  readonly template: string;
  readonly language: string;
}

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
  readonly recordingState = input.required<RecordingState>();
  readonly finalizedSegments = input<readonly TranscriptSegment[]>([]);
  readonly partialText = input('');
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

  readonly renameRequested = output<string>();
  readonly segmentEdited = output<TranscriptSegmentEdit>();
  readonly summarizeRequested = output<string>();
  readonly cancelSummaryRequested = output<void>();
  readonly exportRequested = output<MeetingExportFormat>();
  readonly retryRequested = output<void>();
  readonly recheckModelsRequested = output<void>();
  readonly summaryLanguageSelected = output<string>();
  /** Emitted when the active tab has a persisted-but-unloaded summary ref that needs fetching. */
  readonly summaryLoadRequested = output<SummaryLoadRequest>();
  readonly splitRatioChanged = output<number>();
  readonly transcriptCollapsedChanged = output<boolean>();
  /** Re-emitted from `app-welcome-panel`'s Start a meeting button — see `meetings-shell.page.ts` for the wiring. */
  readonly startRecordingRequested = output<void>();

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
   * The template tab governing the right (summary) column in the WIDE
   * layout, where the tab strip no longer includes a Transcript tab. Falls
   * back to the first available template so the right column shows
   * something meaningful even before the user explicitly clicks a tab —
   * `activeTab` itself still starts at {@link TRANSCRIPT_TAB} internally,
   * it just never renders as a tab choice on wide screens.
   */
  protected readonly wideActiveTemplate = computed(() => {
    const tab = this.activeTab();
    if (tab !== this.transcriptTab) {
      return tab;
    }
    return this.templates()[0]?.name ?? this.transcriptTab;
  });

  /**
   * The (template, language) selector every summary-related computed below
   * reads from. Narrow: the literal active tab (Transcript included, same
   * as before the split workspace existed). Wide: {@link wideActiveTemplate},
   * since the transcript is always visible in the left column there and the
   * tab strip governs only the right one.
   */
  protected readonly summarySelectionTab = computed(() =>
    this.isNarrow() ? this.activeTab() : this.wideActiveTemplate(),
  );

  protected readonly headingDate = computed(() => {
    const current = this.meeting();
    return current ? formatMeetingHeadingDate(current.createdAt) : '';
  });

  protected readonly displayTitle = computed(() => formatMeetingTitle(this.meeting()?.title ?? ''));

  protected readonly metaLine = computed(() => {
    if (this.isLive()) {
      return `Recording · ${this.effectiveCaptureLabel()}`;
    }
    const current = this.meeting();
    return current ? formatMinutesLong(current.durationSec) : '';
  });

  /**
   * The EFFECTIVE capture source label for a live recording — never the
   * merely requested one. Requesting `system`/`mixed` audio is only
   * reflected here once a system source is actually attached; when it
   * isn't (the recorder degraded to microphone only), this reads that out
   * plainly instead of repeating the original request, so it can never sit
   * on screen next to the title bar's "Mic only" hint and contradict it.
   * Idle/saved meetings never call this — `metaLine` shows duration then,
   * and the *selected* (requested) source is still what the record
   * control's capture-settings picker shows before/after recording.
   */
  protected readonly effectiveCaptureLabel = computed(() => {
    const requested = this.captureSource();
    if (requested === 'microphone') {
      return CAPTURE_SOURCE_LABELS.microphone;
    }
    return this.effectiveSystemSource() !== null
      ? CAPTURE_SOURCE_LABELS[requested]
      : 'Mic only (system audio unavailable)';
  });

  protected readonly activeTemplateLabel = computed(() => {
    const template = this.templates().find((candidate) => candidate.name === this.summarySelectionTab());
    return template ? formatTemplateLabel(template) : this.summarySelectionTab();
  });

  protected readonly activeLanguageLabel = computed(() => {
    const code = this.selectedSummaryLanguage();
    return this.summaryLanguages().find((language) => language.code === code)?.label ?? code;
  });

  /**
   * A tab is keyed by template alone, but a template can now hold both a
   * French and an English summary side by side — so the match also
   * requires the CURRENTLY SELECTED language, keeping which version is on
   * screen unambiguous. `.at(-1)` picks the most recently generated match
   * so regenerating in the same language shows the fresh content, while
   * regenerating in a different language never overwrites the other one
   * (`withSummary` only ever appends).
   *
   * A ref whose `markdown` is still `''` (persisted before this session, not
   * yet fetched) is resolved from `summaryCache` instead — see the
   * constructor `effect` below, which requests that fetch.
   */
  protected readonly existingSummary = computed(() => {
    const current = this.meeting();
    const tab = this.summarySelectionTab();
    const language = this.selectedSummaryLanguage();
    const ref = current?.summaries
      .filter((summary) => summary.template === tab && summary.language === language)
      .at(-1);
    if (!ref) {
      return undefined;
    }
    if (ref.markdown !== '') {
      return ref;
    }
    const entry = this.summaryCache().get(summaryCacheKey(current!.id, tab, language));
    return entry?.status === 'loaded' ? entry.summary : undefined;
  });

  /** True while a persisted-but-unfetched summary ref is being (or about to be) loaded for the active tab. */
  protected readonly summaryLoading = computed(() => {
    const current = this.meeting();
    const tab = this.summarySelectionTab();
    const language = this.selectedSummaryLanguage();
    const ref = current?.summaries
      .filter((summary) => summary.template === tab && summary.language === language)
      .at(-1);
    if (!current || !ref || ref.markdown !== '') {
      return false;
    }
    const entry = this.summaryCache().get(summaryCacheKey(current.id, tab, language));
    return entry === undefined || entry.status === 'loading';
  });

  /**
   * True only when the ACTIVE tab (template + selected language) is the one
   * generating. This is what gates the loader, the streaming tokens, and
   * Cancel — never the bare `summarizing` flag, which is true for every tab
   * while ANY generation runs and was the root cause of every tab showing
   * the same loader (see task brief).
   */
  protected readonly isGeneratingActiveTab = computed(() => {
    const key = this.summarizingKey();
    return (
      key !== null && key.template === this.summarySelectionTab() && key.language === this.selectedSummaryLanguage()
    );
  });

  /**
   * Display label of the template generating on a DIFFERENT tab than the
   * one currently active, or `undefined` when nothing is generating
   * elsewhere. Drives the disabled Generate button + visible reason on
   * every other tab, since the backend rejects a second concurrent
   * summarization with `Busy`.
   */
  protected readonly generatingElsewhereLabel = computed(() => {
    const key = this.summarizingKey();
    if (!key || this.isGeneratingActiveTab()) {
      return undefined;
    }
    const template = this.templates().find((candidate) => candidate.name === key.template);
    return template ? formatTemplateLabel(template) : key.template;
  });

  constructor() {
    // Requests a fetch whenever the active tab shows a persisted ref
    // (survived a restart) whose markdown hasn't been loaded into the cache
    // yet. Re-running as `summaryCache` itself changes is intentional: once
    // the facade records a 'loading' (then 'loaded'/'empty') entry for this
    // exact key, the guard below stops emitting further requests for it.
    effect(() => {
      const current = this.meeting();
      const tab = this.summarySelectionTab();
      const language = this.selectedSummaryLanguage();
      if (!current || tab === this.transcriptTab) {
        return;
      }
      const ref = current.summaries
        .filter((summary) => summary.template === tab && summary.language === language)
        .at(-1);
      if (!ref || ref.markdown !== '') {
        return;
      }
      if (this.summaryCache().has(summaryCacheKey(current.id, tab, language))) {
        return;
      }
      this.summaryLoadRequested.emit({ meetingId: current.id, template: tab, language });
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
}
