import type { FolderId } from '../../core/models/folder.model';
import type { MeetingId } from '../../core/models/meeting.model';
import { withSummary } from '../../core/models/meeting.model';
import { MeetingsError } from '../../core/models/recording-state.model';
import type { SummaryTemplate } from '../../core/models/summary-template.model';
import type { FileDialogFilter, FileDialogPort } from '../../core/ports/file-dialog.port';
import type { MeetingExportFormat } from '../../core/ports/meeting-repository.port';
import type { CancelImportUseCase } from '../use-cases/cancel-import.usecase';
import type { CancelSummarizationUseCase } from '../use-cases/cancel-summarization.usecase';
import type { DiarizeMeetingUseCase } from '../use-cases/diarize-meeting.usecase';
import type { DeleteSummaryUseCase } from '../use-cases/delete-summary.usecase';
import type { EditSummaryUseCase } from '../use-cases/edit-summary.usecase';
import type { ExportMeetingUseCase } from '../use-cases/export-meeting.usecase';
import type { GetSummaryUseCase } from '../use-cases/get-summary.usecase';
import type { ImportAudioUseCase } from '../use-cases/import-audio.usecase';
import type { PlaceMeetingUseCase } from '../use-cases/place-meeting.usecase';
import type { RetranscribeMeetingUseCase } from '../use-cases/retranscribe-meeting.usecase';
import type { SetSummaryGuidelinesUseCase } from '../use-cases/set-summary-guidelines.usecase';
import type { SummarizeMeetingUseCase } from '../use-cases/summarize-meeting.usecase';
import type { MeetingsErrorInfo, MeetingsStore } from '../stores/meetings.store';
import { clearIngestPlaceholderIfSelected } from '../stores/meetings.store.support';

/** File extension the save dialog should offer for each export format. */
export const EXPORT_EXTENSIONS: Readonly<Record<MeetingExportFormat, string>> = {
  markdown: 'md',
  json: 'json',
  txt: 'txt',
};

/** Filter offered by the open dialog for both `importAudio` and a `replaceAudio` re-transcribe. */
const AUDIO_IMPORT_FILTERS: readonly FileDialogFilter[] = [{ name: 'Audio', extensions: ['wav'] }];

/**
 * Interval, in milliseconds, between `DevicesFacade`'s background device
 * polls. cpal exposes no default-device-changed callback (a CoreAudio
 * listener would need `unsafe`, forbidden workspace-wide), so the facade
 * re-runs `loadDevices` on this interval to keep `defaultDevice()` /
 * `devices()` fresh while the app is open.
 */
export const DEVICE_POLL_INTERVAL_MS = 5000;

/**
 * `MeetingsFacade.guarded`'s body, extracted to keep the facade under the
 * project's max-lines limit. On success it clears the shared ERROR slot only
 * when the current error came from the same `source` — or carries no source
 * at all (legacy/backend-pushed errors keep any-success-clears behavior).
 * A rejected call's error must survive a later UNRELATED success: the boot
 * race where `loadTemplates`' success erased `checkModels`' rejection left
 * onboarding stuck on "Checking installed models…" forever with no visible
 * error.
 */
export async function runGuarded(
  store: MeetingsStore,
  run: () => Promise<void>,
  source?: string,
): Promise<void> {
  try {
    await run();
    clearErrorFromSource(store, source);
  } catch (caught) {
    store.setError({ ...toErrorInfo(caught), ...(source !== undefined ? { source } : {}) });
  }
}

/**
 * Clears the shared error slot ONLY when the standing error came from
 * `source` (or carries no source at all). Every success path that is not a
 * retry of the failed operation must go through this rather than calling
 * `store.clearError()` outright.
 *
 * `DevicesFacade.loadDevices` is why this is exported rather than inlined in
 * {@link runGuarded}: it runs on a `DEVICE_POLL_INTERVAL_MS` timer for the
 * whole life of the window, so an unconditional clear there erased a failed
 * boot call's error within five seconds — every time. The onboarding panel
 * was then stuck on "Checking installed models…" with `modelsStatus`
 * undefined, no "Download models" button, and NO error surface to diagnose
 * from.
 */
export function clearErrorFromSource(store: MeetingsStore, source?: string): void {
  const current = store.error();
  if (!current || current.source === undefined || current.source === source) {
    store.clearError();
  }
}

export const toErrorInfo = (caught: unknown): MeetingsErrorInfo => {
  if (caught instanceof MeetingsError) {
    return { code: caught.code, message: caught.message };
  }
  if (caught instanceof Error) {
    return { code: 'UNKNOWN', message: caught.message };
  }
  return { code: 'UNKNOWN', message: String(caught) };
};

/**
 * Orchestrates the open dialog then the audio import itself, so
 * `MeetingsFacade.importAudio` stays a thin wrapper. A `null` dialog result
 * (the user cancelled) is a silent no-op, mirroring `exportMeeting`. Resets
 * the live transcript first so `transcript://final` events emitted during
 * ingest render into a clean transcript, not a previously viewed meeting's.
 */
export async function runImportAudio(
  store: MeetingsStore,
  fileDialog: FileDialogPort,
  importAudioUseCase: ImportAudioUseCase,
): Promise<void> {
  try {
    const path = await fileDialog.open(AUDIO_IMPORT_FILTERS);
    if (path === null) {
      return;
    }
    store.resetLiveTranscript();
    store.setImporting(true);
    const meeting = await importAudioUseCase.import(path);
    store.addMeeting(meeting);
    store.setSelectedMeeting(meeting);
    store.clearError();
  } catch (caught) {
    const errorInfo = toErrorInfo(caught);
    if (errorInfo.code !== 'CANCELLED') {
      store.setError(errorInfo);
    }
    clearIngestPlaceholderIfSelected(store);
  } finally {
    store.setImporting(false);
    store.resetImport();
  }
}

/**
 * Re-runs transcription for an already-imported/recorded meeting. When
 * `replaceAudio` is true, the user picks a new source file first — a
 * cancelled dialog is a silent no-op, mirroring `runImportAudio`. Never
 * optimistic: the store only ever reflects the meeting the backend actually
 * persisted.
 */
export async function runRetranscribeMeeting(
  store: MeetingsStore,
  fileDialog: FileDialogPort,
  retranscribeMeetingUseCase: RetranscribeMeetingUseCase,
  id: MeetingId,
  replaceAudio: boolean,
): Promise<void> {
  let path: string | undefined;
  if (replaceAudio) {
    const dest = await fileDialog.open(AUDIO_IMPORT_FILTERS);
    if (dest === null) {
      return;
    }
    path = dest;
  }
  store.resetLiveTranscript();
  store.setImporting(true);
  try {
    store.updateMeeting(await retranscribeMeetingUseCase.retranscribe(id, path));
    store.clearError();
  } catch (caught) {
    const errorInfo = toErrorInfo(caught);
    if (errorInfo.code !== 'CANCELLED') {
      store.setError(errorInfo);
    }
  } finally {
    store.setImporting(false);
    store.resetImport();
  }
}

/**
 * Runs speaker detection over `id`'s system-audio track. Shares the exact
 * same `IMPORTING`/`resetImport` store slots `runRetranscribeMeeting` does
 * — the backend's `guard_import` treats diarize/import/re-transcribe as one
 * mutually-exclusive resource (all three load models and contend for the
 * same CPU cores), so the UI must disable the same controls while any one
 * of them runs. Never optimistic: the store only ever reflects the meeting
 * the backend actually persisted.
 */
export async function runDiarizeMeeting(
  store: MeetingsStore,
  diarizeMeetingUseCase: DiarizeMeetingUseCase,
  id: MeetingId,
): Promise<void> {
  store.setImporting(true);
  try {
    store.updateMeeting(await diarizeMeetingUseCase.diarize(id));
    store.clearError();
  } catch (caught) {
    const errorInfo = toErrorInfo(caught);
    if (errorInfo.code !== 'CANCELLED') {
      store.setError(errorInfo);
    }
  } finally {
    store.setImporting(false);
    store.resetImport();
  }
}

/** Cancels an in-flight import/re-transcribe; always clears `importing`, even on failure. */
export async function runCancelImport(store: MeetingsStore, cancelImportUseCase: CancelImportUseCase): Promise<void> {
  try {
    await cancelImportUseCase.cancel();
    store.clearError();
  } catch (caught) {
    store.setError(toErrorInfo(caught));
  } finally {
    store.setImporting(false);
  }
}

/**
 * Generates a summary for one (meeting, template, language) triple. The
 * language AND the (meeting, template) instruction draft are captured once,
 * up front, so switching either mid-generation never rewrites which tab this
 * belongs to or what the in-flight run sees. Lands the
 * result in the same cache `loadSummary` reads from, so tab switches never re-fetch
 * it. `setSummarizingKey(null)` runs on success, failure, AND cancellation
 * alike, so no tab is ever left stuck "generating".
 */
export async function runSummarizeMeeting(
  store: MeetingsStore,
  summarizeMeetingUseCase: SummarizeMeetingUseCase,
  id: MeetingId,
  template: SummaryTemplate,
): Promise<void> {
  const language = store.selectedSummaryLanguage();
  // Read AT CALL TIME: edits made after generation starts must not leak into
  // this run. The default draft ({text:'', includeGeneral:true}) is a real
  // value, not `undefined` — the Rust side treats empty text + includeGeneral
  // as "general guidelines only".
  const instructions = store.summaryInstructionDraft(id, template.name);
  try {
    store.resetSummaryStream();
    store.setSummarizingKey({ template: template.name, language });
    const summary = await summarizeMeetingUseCase.summarize(id, template, language, instructions);
    const current = store.selectedMeeting();
    if (current && current.id === id) {
      store.setSelectedMeeting(withSummary(current, summary));
    }
    store.setSummaryCacheResult(id, summary.template, summary.language, summary);
    store.clearError();
  } catch (caught) {
    store.setError(toErrorInfo(caught));
  } finally {
    store.setSummarizingKey(null);
  }
}

/**
 * Persists an edited summary's markdown; never optimistic, mirroring
 * `editTranscriptSegment` — but deliberately NOT via the facade's
 * `applyMeetingMutation`: the meeting JSON is untouched, so on success only
 * the summary cache entry and the selected meeting's matching `summaries`
 * ref are patched (both read paths the detail pane uses). A failure mutates
 * nothing.
 */
export async function runEditSummary(
  store: MeetingsStore,
  editSummaryUseCase: EditSummaryUseCase,
  id: MeetingId,
  template: string,
  language: string,
  markdown: string,
): Promise<void> {
  try {
    const summary = await editSummaryUseCase.edit(id, template, language, markdown);
    store.updateSummaryContent(id, template, language, summary);
    store.clearError();
  } catch (caught) {
    store.setError(toErrorInfo(caught));
  }
}

/**
 * Deletes a persisted summary; never optimistic, mirroring
 * `runEditSummary` — on success only the summary cache entry is cleared
 * and the selected meeting's matching `summaries` ref is stripped (see
 * `applySummaryRemoval`, which never touches undo/drafts). A failure
 * mutates nothing.
 */
export async function runDeleteSummary(
  store: MeetingsStore,
  deleteSummaryUseCase: DeleteSummaryUseCase,
  id: MeetingId,
  template: string,
  language: string,
): Promise<void> {
  try {
    await deleteSummaryUseCase.delete(id, template, language);
    store.removeSummary(id, template, language);
    store.clearError();
  } catch (caught) {
    store.setError(toErrorInfo(caught));
  }
}

/**
 * Places a meeting — container (folder/unfiled/archived) AND ordering — via
 * a single `set_meeting_placement` write. Never optimistic: on success, a
 * full `reloadMeetings` (rather than mirroring the returned `Meeting`) is
 * mandatory, because `MeetingsStore.updateMeeting` replaces the element in
 * place and PRESERVES array order — mirroring would make a successful
 * reorder invisible on screen. On failure, only the error slot is touched,
 * so a rejected placement can never half-apply.
 */
export async function runPlaceMeeting(
  store: MeetingsStore,
  placeMeetingUseCase: PlaceMeetingUseCase,
  reloadMeetings: () => Promise<void>,
  id: MeetingId,
  folderId: FolderId | null,
  archived: boolean,
  previousId: MeetingId | null,
  nextId: MeetingId | null,
): Promise<void> {
  try {
    await placeMeetingUseCase.execute(id, folderId, archived, previousId, nextId);
    store.clearError();
    await reloadMeetings();
  } catch (caught) {
    store.setError(toErrorInfo(caught));
  }
}

/**
 * Fetches and caches a persisted summary for one (meeting, template, language)
 * triple; a no-op once cached, so tab switches never re-hit IPC. Drops the
 * loading marker on failure so the next tab visit retries instead of sticking.
 */
export async function runLoadSummary(store: MeetingsStore, getSummaryUseCase: GetSummaryUseCase, id: MeetingId, template: string, language: string): Promise<void> {
  if (store.getSummaryCacheEntry(id, template, language)) {
    return;
  }
  store.setSummaryCacheLoading(id, template, language);
  try {
    const summary = await getSummaryUseCase.get(id, template, language);
    store.setSummaryCacheResult(id, template, language, summary);
    store.clearError();
  } catch (caught) {
    store.clearSummaryCacheEntry(id, template, language);
    store.setError(toErrorInfo(caught));
  }
}

/** Cancels an in-flight summarization; clears the error slot on success and ALWAYS releases `summarizingKey`. */
export async function runCancelSummarization(store: MeetingsStore, cancelSummarizationUseCase: CancelSummarizationUseCase): Promise<void> {
  try {
    await cancelSummarizationUseCase.cancel();
    store.clearError();
  } catch (caught) {
    store.setError(toErrorInfo(caught));
  } finally {
    store.setSummarizingKey(null);
  }
}

/** Orchestrates the save dialog then the export; a `null` (cancelled) dialog result is a silent no-op. */
export async function runExportMeeting(
  store: MeetingsStore,
  fileDialog: FileDialogPort,
  exportMeetingUseCase: ExportMeetingUseCase,
  id: MeetingId,
  format: MeetingExportFormat,
  suggestedName: string,
): Promise<void> {
  try {
    const dest = await fileDialog.save(suggestedName, EXPORT_EXTENSIONS[format]);
    if (dest === null) {
      return;
    }
    await exportMeetingUseCase.export(id, format, dest);
    store.clearError();
  } catch (caught) {
    store.setError(toErrorInfo(caught));
  }
}

/**
 * Persists the general guidelines through the port and updates the store slot
 * ONLY once the write succeeds — never optimistic: a rejected save leaves the
 * guidelines currently on screen untouched. Guarded, so failure lands in the
 * shared ERROR slot with this source.
 */
export async function runSetSummaryGuidelines(store: MeetingsStore, setSummaryGuidelinesUseCase: SetSummaryGuidelinesUseCase, text: string): Promise<void> {
  await runGuarded(store, async () => {
    await setSummaryGuidelinesUseCase.set(text);
    store.setSummaryGuidelines(text);
  }, 'setSummaryGuidelines');
}
