import { DEFAULT_SUMMARY_INSTRUCTIONS_DRAFT } from '../../../application/stores/summary-instructions-preferences.util';
import type { SummaryCacheEntry, SummarizingKey } from '../../../application/stores/meetings.store';
import { summaryCacheKey } from '../../../application/stores/meetings.store';
import type { AudioSource } from '../../../core/models/audio-source.model';
import type { CaptureSource } from '../../../core/models/capture-source.model';
import type { Meeting, MeetingId } from '../../../core/models/meeting.model';
import type { ImportProgress } from '../../../core/ports/audio-import.port';
import type { Summary } from '../../../core/models/summary.model';
import type { SummaryInstructionsDraft } from '../../../core/models/summary-instructions.model';
import type { SummaryLanguage } from '../../../core/models/summary-language.model';
import type { SummaryTemplate } from '../../../core/models/summary-template.model';
import {
  formatMeetingHeadingDate,
  formatMmSs,
  formatMinutesLong,
  formatTemplateLabel,
} from '../../utils/format-display.util';

/**
 * Below this viewport width, the two-column split workspace no longer fits
 * comfortably (each column would drop under a usable reading measure), so
 * the layout falls back to the narrow single-column tabbed view — the same
 * one the detail pane used before the split workspace existed, transcript
 * tab included. jsdom's default `window.innerWidth` (1024) resolves to
 * narrow, matching the layout every pre-existing spec already asserts
 * against.
 */
export const NARROW_BREAKPOINT_PX = 1200;

export const CAPTURE_SOURCE_LABELS: Readonly<Record<CaptureSource, string>> = {
  microphone: 'Microphone',
  system: 'System audio',
  mixed: 'Mic + system',
};

/**
 * The EFFECTIVE capture source label for a live recording — never the
 * merely requested one. Requesting `system`/`mixed` audio is only
 * reflected here once a system source is actually attached; when it
 * isn't (the recorder degraded to microphone only), this reads that out
 * plainly instead of repeating the original request, so it can never sit
 * on screen next to the title bar's "Mic only" hint and contradict it.
 * Idle/saved meetings never call this — the meta line shows duration then,
 * and the *selected* (requested) source is still what the record
 * control's capture-settings picker shows before/after recording.
 */
export const computeEffectiveCaptureLabel = (
  requested: CaptureSource,
  effectiveSystemSource: AudioSource | null,
): string => {
  if (requested === 'microphone') {
    return CAPTURE_SOURCE_LABELS.microphone;
  }
  return effectiveSystemSource !== null ? CAPTURE_SOURCE_LABELS[requested] : 'Mic only (system audio unavailable)';
};

/** A request to fetch a persisted summary's content for one (meeting, template, language) triple. */
export interface SummaryLoadRequest {
  readonly meetingId: MeetingId;
  readonly template: string;
  readonly language: string;
}

/** An edited summary's markdown, tagged with the (meeting, template, language) triple it belongs to. */
export interface SummaryEdit {
  readonly meetingId: MeetingId;
  readonly template: string;
  readonly language: string;
  readonly markdown: string;
}

/** Tags the panel's raw edited markdown with the summary it was edited against. */
export const buildSummaryEdit = (
  meeting: Meeting,
  template: string,
  language: string,
  markdown: string,
): SummaryEdit => ({
  meetingId: meeting.id,
  template,
  language,
  markdown,
});

/** A request to delete a persisted summary for one (meeting, template, language) triple. */
export interface SummaryDelete {
  readonly meetingId: MeetingId;
  readonly template: string;
  readonly language: string;
}

/** Tags the active (meeting, template, language) triple as a summary-delete request. */
export const buildSummaryDelete = (meeting: Meeting, template: string, language: string): SummaryDelete =>
  ({ meetingId: meeting.id, template, language });
/** Confirm copy for the destructive summary-delete path; a declined confirmation emits nothing. */
export const buildSummaryDeleteMessage = (template: string, language: string): string =>
  `Delete ${template} in ${language}? This cannot be undone — regenerate from the transcript to recreate it.`;

/**
 * Header label for the determinate import/re-transcribe progress bar, or
 * `null` when nothing should render — either nothing is importing, no
 * progress event has arrived yet, or the backend reported `'done'` (the
 * facade clears `importing`/`importProgress` right after, but this guard
 * keeps a stale `'done'` event from ever flashing on screen).
 */
export const computeImportProgressLabel = (
  importing: boolean,
  progress: ImportProgress | null,
): string | null => {
  if (!importing || !progress || progress.phase === 'done') {
    return null;
  }
  if (progress.phase === 'converting') {
    return 'Converting audio…';
  }
  return `Transcribing ${formatMmSs(progress.processedSec)} / ${formatMmSs(progress.totalSec)}`;
};

/** Fraction (0-100) of the determinate import progress bar to fill. */
export const computeImportProgressPercent = (progress: ImportProgress | null): number => {
  if (!progress || progress.totalSec <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, (progress.processedSec / progress.totalSec) * 100));
};

/** "Re-transcribe from audio" is only meaningful when audio actually exists on disk, and never while something else is already running. */
export const isRetranscribeDisabled = (hasAudio: boolean, busy: boolean, importing: boolean): boolean =>
  !hasAudio || busy || importing;

/** "Replace audio & re-transcribe…" always works (it supplies its own file), except while something else is already running. */
export const isReplaceAudioDisabled = (busy: boolean, importing: boolean): boolean => busy || importing;

/** "Regenerate" re-runs summarization for the active tab; disabled while anything is generating/loading/importing/live. */
export const isRegenerateDisabled = (
  summarizing: boolean,
  summaryLoading: boolean,
  importing: boolean,
  isLive: boolean,
  generatingElsewhere: boolean,
): boolean => summarizing || summaryLoading || importing || isLive || generatingElsewhere;

/** "Detect speakers" needs the diarization models AND a system-audio track, and never runs alongside anything else — including a recording still in progress, since diarization needs the finished system-audio track. */
export const isDiarizeDisabled = (
  modelsPresent: boolean,
  hasSystemTrack: boolean,
  busy: boolean,
  importing: boolean,
  diarizing: boolean,
  recording: boolean,
): boolean => !modelsPresent || !hasSystemTrack || busy || importing || diarizing || recording;

/**
 * Explains why "Detect speakers" is disabled, but only for the durable
 * reasons worth surfacing inline (recording in progress, models missing, no
 * system track) — never for merely being busy with something else, which
 * every other reingest control disables silently too. The recording reason
 * wins over the other two: while recording, models/track state hasn't
 * settled yet and isn't the actionable reason for the user.
 */
export const diarizeDisabledReason = (
  modelsPresent: boolean,
  hasSystemTrack: boolean,
  _modelsPath: string,
  recording: boolean,
): string | undefined => {
  if (recording) {
    return 'Speaker detection runs on the finished recording — available once you stop recording.';
  }
  if (!modelsPresent) {
    return 'Speaker detection needs ~45 MB extra models.';
  }
  return hasSystemTrack ? undefined : 'No system audio was captured for this meeting.';
};

/**
 * The four built-in summary templates in the order their tabs must appear.
 * The backend lists templates alphabetically by name (`action-items`,
 * `decisions`, `key-points`, `meeting-notes`), which reads backwards on
 * screen; the product order is broadest-summary first: Notes, Key Points,
 * Decisions, Action Items.
 */
export const BUILT_IN_TEMPLATE_TAB_ORDER = ['meeting-notes', 'key-points', 'decisions', 'action-items'] as const;

/**
 * Stable priority sort for the tab strip: built-ins render in
 * {@link BUILT_IN_TEMPLATE_TAB_ORDER}; every other template (user-added
 * ones) keeps its incoming relative order and renders after the built-ins.
 * `Array.prototype.sort` is stable since ES2019, so equal-rank templates are
 * never reshuffled. Returns a copy — the caller's array is never mutated.
 */
export const sortTemplatesForDisplay = (
  templates: readonly SummaryTemplate[],
): readonly SummaryTemplate[] => {
  const rankOf = (name: string): number => {
    const index = BUILT_IN_TEMPLATE_TAB_ORDER.findIndex((entry) => entry === name);
    return index === -1 ? BUILT_IN_TEMPLATE_TAB_ORDER.length : index;
  };
  return [...templates].sort((a, b) => rankOf(a.name) - rankOf(b.name));
};

/**
 * The template tab governing the right (summary) column in the WIDE layout,
 * where the tab strip no longer includes a Transcript tab. Falls back to the
 * first available template so the right column shows something meaningful
 * even before the user explicitly clicks a tab.
 */
export const computeWideActiveTemplate = (
  activeTab: string,
  transcriptTab: string,
  templates: readonly SummaryTemplate[],
): string => {
  if (activeTab !== transcriptTab) {
    return activeTab;
  }
  return templates[0]?.name ?? transcriptTab;
};

/**
 * The (template, language) selector every summary-related computed reads
 * from. Narrow: the literal active tab (Transcript included). Wide:
 * {@link computeWideActiveTemplate}'s result, since the transcript is always
 * visible in the left column there and the tab strip governs only the right
 * one.
 */
export const computeSummarySelectionTab = (isNarrow: boolean, activeTab: string, wideActiveTemplate: string): string =>
  isNarrow ? activeTab : wideActiveTemplate;

/**
 * The most recently generated summary matching the active (template,
 * language) tab. A ref whose `markdown` is still `''` (persisted before this
 * session, not yet fetched) is resolved from `summaryCache` instead.
 */
export const findExistingSummary = (
  meeting: Meeting | undefined,
  summaryCache: ReadonlyMap<string, SummaryCacheEntry>,
  tab: string,
  language: string,
): Summary | undefined => {
  const ref = meeting?.summaries.filter((summary) => summary.template === tab && summary.language === language).at(-1);
  if (!ref) {
    return undefined;
  }
  if (ref.markdown !== '') {
    return ref;
  }
  const entry = summaryCache.get(summaryCacheKey(meeting!.id, tab, language));
  return entry?.status === 'loaded' ? entry.summary : undefined;
};

/** True while a persisted-but-unfetched summary ref is being (or about to be) loaded for the active tab. */
export const isSummaryLoading = (
  meeting: Meeting | undefined,
  summaryCache: ReadonlyMap<string, SummaryCacheEntry>,
  tab: string,
  language: string,
): boolean => {
  const ref = meeting?.summaries.filter((summary) => summary.template === tab && summary.language === language).at(-1);
  if (!meeting || !ref || ref.markdown !== '') {
    return false;
  }
  const entry = summaryCache.get(summaryCacheKey(meeting.id, tab, language));
  return entry === undefined || entry.status === 'loading';
};

/**
 * True only when the ACTIVE tab (template + selected language) is the one
 * generating — never the bare `summarizing` flag, which is true for every
 * tab while ANY generation runs.
 */
export const computeIsGeneratingActiveTab = (
  key: SummarizingKey | null,
  tab: string,
  language: string,
): boolean => key !== null && key.template === tab && key.language === language;

/**
 * Display label of the template generating on a DIFFERENT tab than the one
 * currently active, or `undefined` when nothing is generating elsewhere.
 * Drives the disabled Generate button + visible reason on every other tab,
 * since the backend rejects a second concurrent summarization with `Busy`.
 */
export const computeGeneratingElsewhereLabel = (
  key: SummarizingKey | null,
  isGeneratingActiveTab: boolean,
  templates: readonly SummaryTemplate[],
): string | undefined => {
  if (!key || isGeneratingActiveTab) {
    return undefined;
  }
  const template = templates.find((candidate) => candidate.name === key.template);
  return template ? formatTemplateLabel(template) : key.template;
};

/**
 * Requests a fetch whenever the active tab shows a persisted ref (survived a
 * restart) whose markdown hasn't been loaded into the cache yet. Returns
 * `undefined` once the facade has recorded a 'loading' (then
 * 'loaded'/'empty') entry for this exact key, so the caller's effect stops
 * emitting further requests for it.
 */
export const findUnloadedSummaryRequest = (
  meeting: Meeting | undefined,
  tab: string,
  transcriptTab: string,
  language: string,
  summaryCache: ReadonlyMap<string, SummaryCacheEntry>,
): { readonly meetingId: MeetingId; readonly template: string; readonly language: string } | undefined => {
  if (!meeting || tab === transcriptTab) {
    return undefined;
  }
  const ref = meeting.summaries.filter((summary) => summary.template === tab && summary.language === language).at(-1);
  if (!ref || ref.markdown !== '') {
    return undefined;
  }
  if (summaryCache.has(summaryCacheKey(meeting.id, tab, language))) {
    return undefined;
  }
  return { meetingId: meeting.id, template: tab, language };
};

/** A focus-draft change from the instructions editor, tagged with the template (tab) it was made against. */
export interface SummaryDraftChange {
  readonly template: string;
  readonly draft: SummaryInstructionsDraft;
}

/** The active tab's focus draft; the default draft (empty text, general included) when none was ever saved. */
export const findSummaryDraft = (
  drafts: ReadonlyMap<string, SummaryInstructionsDraft>,
  template: string,
): SummaryInstructionsDraft => drafts.get(template) ?? DEFAULT_SUMMARY_INSTRUCTIONS_DRAFT;

/**
 * Single-line preview of the general guidelines for the instructions editor's
 * hint: whitespace collapsed, truncated at ~`maxLength` chars with an
 * ellipsis. `''` for empty guidelines — the editor never shows placeholder
 * content.
 */
export const buildGuidelinesPreview = (guidelines: string, maxLength = 80): string => {
  const collapsed = guidelines.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  return `${collapsed.slice(0, maxLength).trimEnd()}…`;
};

/**
 * Contextual copy for the inline regenerate confirm strip. Varies by draft
 * state so the strip always names what the next run will use: custom focus
 * text when the user wrote some (plus the general guidelines when those are
 * both included and non-empty), the guidelines preview when only those
 * apply, and a plain default-settings line otherwise. Pure — no framework
 * deps, safe for the pane's `OnPush` computed.
 */
export const buildRegenerateHint = (draft: SummaryInstructionsDraft, guidelinesPreview: string): string => {
  const focus = draft.text.trim();
  if (focus !== '') {
    return draft.includeGeneral && guidelinesPreview !== ''
      ? `Regenerate using your instructions (“${focus}”) plus general guidelines: ${guidelinesPreview}`
      : `Regenerate using your instructions (“${focus}”)`;
  }
  if (draft.includeGeneral && guidelinesPreview !== '') {
    return `Regenerate using general guidelines: ${guidelinesPreview}`;
  }
  return 'Regenerate from the current transcript with default settings.';
};

/** Heading date for the pane title; `''` with no meeting selected. */
export const computeHeadingDate = (meeting: Meeting | undefined): string =>
  meeting ? formatMeetingHeadingDate(meeting.createdAt) : '';

/** Frozen fallback registry so the speaker-names input never allocates a fresh object per CD pass. */
const EMPTY_SPEAKER_NAMES: Readonly<Record<string, string>> = Object.freeze({});

/** The selected meeting's speaker-name registry, with a FROZEN stable fallback. */
export const computeSpeakerNamesRegistry = (meeting: Meeting | undefined): Readonly<Record<string, string>> =>
  meeting?.speakerNames ?? EMPTY_SPEAKER_NAMES;

/** Duration for a saved meeting, capture source while live — never a fabricated speaker count or language. */
export const computeMetaLine = (
  isLive: boolean,
  effectiveCaptureLabel: string,
  meeting: Meeting | undefined,
): string => {
  if (isLive) {
    return `Recording · ${effectiveCaptureLabel}`;
  }
  return meeting ? formatMinutesLong(meeting.durationSec) : '';
};

/** Display label of the active summary tab's template; falls back to the raw tab name. */
export const computeActiveTemplateLabel = (templates: readonly SummaryTemplate[], tab: string): string => {
  const template = templates.find((candidate) => candidate.name === tab);
  return template ? formatTemplateLabel(template) : tab;
};

/** Label of the selected summary language; falls back to the raw code when the list hasn't loaded. */
export const computeActiveLanguageLabel = (languages: readonly SummaryLanguage[], code: string): string =>
  languages.find((language) => language.code === code)?.label ?? code;
