import { Injectable, inject } from '@angular/core';

import type { CaptureSource } from '../../core/models/capture-source.model';
import type { FolderId } from '../../core/models/folder.model';
import type { Meeting, MeetingId } from '../../core/models/meeting.model';
import type { SummaryTemplate } from '../../core/models/summary-template.model';
import { AudioRepositoryPort, FileDialogPort } from '../../core/ports';
import type { MeetingExportFormat } from '../../core/ports/meeting-repository.port';
import { CancelImportUseCase } from '../use-cases/cancel-import.usecase';
import { CancelRecordingUseCase } from '../use-cases/cancel-recording.usecase';
import { CancelSummarizationUseCase } from '../use-cases/cancel-summarization.usecase';
import { CheckModelsUseCase } from '../use-cases/check-models.usecase';
import { CheckSystemAudioUseCase } from '../use-cases/check-system-audio.usecase';
import { CreateFolderUseCase } from '../use-cases/create-folder.usecase';
import { DeleteFolderUseCase } from '../use-cases/delete-folder.usecase';
import { DeleteMeetingUseCase } from '../use-cases/delete-meeting.usecase';
import { DiarizeMeetingUseCase } from '../use-cases/diarize-meeting.usecase';
import { EditSummaryUseCase } from '../use-cases/edit-summary.usecase';
import { EditTranscriptSegmentUseCase } from '../use-cases/edit-transcript-segment.usecase';
import { ExportMeetingUseCase } from '../use-cases/export-meeting.usecase';
import { GetAppVersionUseCase } from '../use-cases/get-app-version.usecase';
import { GetSummaryUseCase } from '../use-cases/get-summary.usecase';
import { ImportAudioUseCase } from '../use-cases/import-audio.usecase';
import { ListAudioSourcesUseCase } from '../use-cases/list-audio-sources.usecase';
import { ListFoldersUseCase } from '../use-cases/list-folders.usecase';
import { ListMeetingsUseCase } from '../use-cases/list-meetings.usecase';
import { ListSummaryLanguagesUseCase } from '../use-cases/list-summary-languages.usecase';
import { ListTemplatesUseCase } from '../use-cases/list-templates.usecase';
import { OpenMeetingUseCase } from '../use-cases/open-meeting.usecase';
import { PlaceMeetingUseCase } from '../use-cases/place-meeting.usecase';
import { RenameFolderUseCase } from '../use-cases/rename-folder.usecase';
import { RenameMeetingUseCase } from '../use-cases/rename-meeting.usecase';
import { RetranscribeMeetingUseCase } from '../use-cases/retranscribe-meeting.usecase';
import { SetMeetingArchivedUseCase } from '../use-cases/set-meeting-archived.usecase';
import { SetMeetingFolderUseCase } from '../use-cases/set-meeting-folder.usecase';
import { StartRecordingUseCase } from '../use-cases/start-recording.usecase';
import { StopRecordingUseCase } from '../use-cases/stop-recording.usecase';
import { SummarizeMeetingUseCase } from '../use-cases/summarize-meeting.usecase';
import { MeetingsStore } from '../stores/meetings.store';
import { DevicesFacade } from './devices.facade';
import {
  EXPORT_EXTENSIONS,
  runCancelImport,
  runDiarizeMeeting,
  runEditSummary,
  runImportAudio,
  runPlaceMeeting,
  runRetranscribeMeeting,
  runSummarizeMeeting,
  toErrorInfo,
} from './meetings-facade.support';
import { ModelsFacade } from './models.facade';
import { SpeakerFacade } from './speaker.facade';
import { TranscriptEditingFacade } from './transcript-editing.facade';

/**
 * The ONLY class components are allowed to inject for the meetings module.
 * Exposes readonly signals from MeetingsStore plus thin methods delegating
 * to use cases. Never re-exports or exposes a use case. Speaker-op undo,
 * transcript structural-mutation undo, in-app model download, and
 * input/output device handling are split into `SpeakerFacade`,
 * `TranscriptEditingFacade`, `ModelsFacade`, and `DevicesFacade`
 * respectively — this class injects each and delegates in one-line
 * pass-throughs, so its own public API surface never shrinks.
 */
@Injectable()
export class MeetingsFacade {
  private readonly store = inject(MeetingsStore);
  private readonly speakerFacade = inject(SpeakerFacade);
  private readonly transcriptEditingFacade = inject(TranscriptEditingFacade);
  private readonly modelsFacade = inject(ModelsFacade);
  private readonly devicesFacade = inject(DevicesFacade);
  private readonly startRecordingUseCase = inject(StartRecordingUseCase);
  private readonly stopRecordingUseCase = inject(StopRecordingUseCase);
  private readonly cancelRecordingUseCase = inject(CancelRecordingUseCase);
  private readonly listMeetingsUseCase = inject(ListMeetingsUseCase);
  private readonly openMeetingUseCase = inject(OpenMeetingUseCase);
  private readonly deleteMeetingUseCase = inject(DeleteMeetingUseCase);
  private readonly renameMeetingUseCase = inject(RenameMeetingUseCase);
  private readonly setMeetingArchivedUseCase = inject(SetMeetingArchivedUseCase);
  private readonly editTranscriptSegmentUseCase = inject(EditTranscriptSegmentUseCase);
  private readonly editSummaryUseCase = inject(EditSummaryUseCase);
  private readonly summarizeMeetingUseCase = inject(SummarizeMeetingUseCase);
  private readonly listTemplatesUseCase = inject(ListTemplatesUseCase);
  private readonly checkModelsUseCase = inject(CheckModelsUseCase);
  private readonly listAudioSourcesUseCase = inject(ListAudioSourcesUseCase);
  private readonly cancelSummarizationUseCase = inject(CancelSummarizationUseCase);
  private readonly exportMeetingUseCase = inject(ExportMeetingUseCase);
  private readonly checkSystemAudioUseCase = inject(CheckSystemAudioUseCase);
  private readonly listSummaryLanguagesUseCase = inject(ListSummaryLanguagesUseCase);
  private readonly getSummaryUseCase = inject(GetSummaryUseCase);
  private readonly getAppVersionUseCase = inject(GetAppVersionUseCase);
  private readonly importAudioUseCase = inject(ImportAudioUseCase);
  private readonly retranscribeMeetingUseCase = inject(RetranscribeMeetingUseCase);
  private readonly diarizeMeetingUseCase = inject(DiarizeMeetingUseCase);
  private readonly cancelImportUseCase = inject(CancelImportUseCase);
  private readonly fileDialog = inject(FileDialogPort);
  private readonly listFoldersUseCase = inject(ListFoldersUseCase);
  private readonly createFolderUseCase = inject(CreateFolderUseCase);
  private readonly renameFolderUseCase = inject(RenameFolderUseCase);
  private readonly deleteFolderUseCase = inject(DeleteFolderUseCase);
  private readonly setMeetingFolderUseCase = inject(SetMeetingFolderUseCase);
  private readonly placeMeetingUseCase = inject(PlaceMeetingUseCase);
  private readonly audioRepository = inject(AudioRepositoryPort);

  readonly meetings = this.store.meetings;
  readonly selectedMeeting = this.store.selectedMeeting;
  readonly recordingState = this.store.recordingState;
  readonly finalizedSegments = this.store.finalizedSegments;
  readonly partialTextMe = this.store.partialTextMe;
  readonly partialTextOthers = this.store.partialTextOthers;
  readonly level = this.store.level;
  readonly templates = this.store.templates;
  readonly modelsStatus = this.store.modelsStatus;
  readonly summaryStream = this.store.summaryStream;
  readonly error = this.store.error;
  readonly busy = this.store.busy;
  readonly devices = this.devicesFacade.devices;
  readonly selectedDevice = this.devicesFacade.selectedDevice;
  readonly defaultDevice = this.devicesFacade.defaultDevice;
  readonly outputDevices = this.devicesFacade.outputDevices;
  readonly defaultOutputDevice = this.devicesFacade.defaultOutputDevice;
  readonly summarizing = this.store.summarizing;
  readonly summarizingKey = this.store.summarizingKey;
  readonly startingRecording = this.store.startingRecording;
  readonly systemAudioStatus = this.store.systemAudioStatus;
  readonly captureSource = this.store.captureSource;
  readonly summaryLanguages = this.store.summaryLanguages;
  readonly selectedSummaryLanguage = this.store.selectedSummaryLanguage;
  readonly summaryCache = this.store.summaryCache;
  readonly appVersion = this.store.appVersion;
  readonly audioSources = this.store.audioSources;
  readonly selectedAudioSource = this.store.selectedAudioSource;
  readonly effectiveSystemSource = this.store.effectiveSystemSource;
  readonly splitRatio = this.store.splitRatio;
  readonly transcriptCollapsed = this.store.transcriptCollapsed;
  readonly importing = this.store.importing;
  readonly importProgress = this.store.importProgress;
  readonly folders = this.store.folders;
  readonly expandedFolders = this.store.expandedFolders;
  readonly speakerHistory = this.speakerFacade.speakerHistory;
  readonly transcriptUndo = this.transcriptEditingFacade.transcriptUndo;
  readonly modelDownload = this.modelsFacade.modelDownload;

  async startRecording(title: string, deviceName?: string): Promise<void> {
    this.store.setStartingRecording(true);
    try {
      this.store.resetLiveTranscript();
      const meeting = await this.startRecordingUseCase.with(
        title,
        deviceName,
        this.store.captureSource(),
        this.store.selectedAudioSource(),
      );
      this.store.setSelectedMeeting(meeting);
      this.store.addMeeting(meeting);
      this.store.clearError();
    } catch (caught) {
      this.store.setError(toErrorInfo(caught));
    } finally {
      this.store.setStartingRecording(false);
    }
  }

  async stopRecording(): Promise<void> {
    try {
      const meeting = await this.stopRecordingUseCase.stop();
      this.store.setSelectedMeeting(meeting);
      this.store.addMeeting(meeting);
      this.store.clearError();
    } catch (caught) {
      this.store.setError(toErrorInfo(caught));
    }
  }

  async cancelRecording(): Promise<void> {
    const cancelled = this.store.selectedMeeting();
    try {
      await this.cancelRecordingUseCase.cancel();
      if (cancelled) {
        this.store.setMeetings(this.store.meetings().filter((meeting) => meeting.id !== cancelled.id));
      }
      this.store.clearSelectedMeeting();
      this.store.clearError();
    } catch (caught) {
      this.store.setError(toErrorInfo(caught));
    }
  }

  /** Clears the selected meeting without modifying the meetings list. */
  clearSelection = (): void => this.store.clearSelectedMeeting();
  /** Dismisses the current error without retrying anything. */
  clearError = (): void => this.store.clearError();

  loadMeetings = (): Promise<void> => this.guarded(async () => this.store.setMeetings(await this.listMeetingsUseCase.list()));
  openMeeting = (id: MeetingId): Promise<void> =>
    this.guarded(async () => this.store.setSelectedMeeting(await this.openMeetingUseCase.open(id)));

  async deleteMeeting(id: MeetingId): Promise<void> {
    await this.guarded(async () => {
      await this.deleteMeetingUseCase.delete(id);
      this.store.setMeetings(this.store.meetings().filter((meeting) => meeting.id !== id));
      if (this.store.selectedMeeting()?.id === id) {
        this.store.clearSelectedMeeting();
      }
    });
  }

  /** Runs `run`, clearing the shared error slot on success and funneling any failure into it. Never optimistic. */
  private async guarded(run: () => Promise<void>): Promise<void> {
    try {
      await run();
      this.store.clearError();
    } catch (caught) {
      this.store.setError(toErrorInfo(caught));
    }
  }

  /** Runs a mutation that returns the meeting the backend actually persisted and mirrors it into the store. */
  private async applyMeetingMutation(mutate: () => Promise<Meeting>): Promise<void> {
    await this.guarded(async () => this.store.updateMeeting(await mutate()));
  }

  /** Renames a meeting; never optimistic, so a failed rename never leaves a stale title on screen. */
  async renameMeeting(id: MeetingId, title: string): Promise<void> {
    await this.applyMeetingMutation(() => this.renameMeetingUseCase.rename(id, title));
  }

  /** Archives or unarchives a meeting; never optimistic, mirrors renameMeeting. */
  async setMeetingArchived(id: MeetingId, archived: boolean): Promise<void> {
    await this.applyMeetingMutation(() => this.setMeetingArchivedUseCase.set(id, archived));
  }

  /** Persists a manual correction to one transcript segment; never optimistic. Rejected with BUSY by the backend while that meeting is recording. */
  async editTranscriptSegment(id: MeetingId, index: number, text: string): Promise<void> {
    await this.applyMeetingMutation(() => this.editTranscriptSegmentUseCase.edit(id, index, text));
  }

  /** Persists an edited summary's markdown; never optimistic — see `runEditSummary`. */
  async editSummary(id: MeetingId, template: string, language: string, markdown: string): Promise<void> {
    await runEditSummary(this.store, this.editSummaryUseCase, id, template, language, markdown);
  }

  /** Generates a summary for one (meeting, template, language) triple; see `runSummarizeMeeting`. */
  async summarizeMeeting(id: MeetingId, template: SummaryTemplate): Promise<void> {
    await runSummarizeMeeting(this.store, this.summarizeMeetingUseCase, id, template);
  }

  async cancelSummarization(): Promise<void> {
    try {
      await this.cancelSummarizationUseCase.cancel();
      this.store.clearError();
    } catch (caught) {
      this.store.setError(toErrorInfo(caught));
    } finally {
      this.store.setSummarizingKey(null);
    }
  }

  loadTemplates = (): Promise<void> => this.guarded(async () => this.store.setTemplates(await this.listTemplatesUseCase.list()));
  checkModels = (): Promise<void> => this.guarded(async () => this.store.setModelsStatus(await this.checkModelsUseCase.check()));

  // Model download, device, speaker-undo, and transcript-undo mutators below
  // are one-line delegations to ModelsFacade / DevicesFacade / SpeakerFacade
  // / TranscriptEditingFacade — see those classes for the orchestration.
  initializeModels = (): Promise<void> => this.modelsFacade.initializeModels();
  initializeDiarizationModels = (): Promise<void> => this.modelsFacade.initializeDiarizationModels();
  cancelModelDownload = (): Promise<void> => this.modelsFacade.cancelModelDownload();
  loadDevices = (): Promise<void> => this.devicesFacade.loadDevices();
  selectDevice = (name: string): void => this.devicesFacade.selectDevice(name);
  undoLastSpeakerOp = (): Promise<void> => this.speakerFacade.undoLastSpeakerOp();
  undoLastTranscriptOp = (): Promise<void> => this.transcriptEditingFacade.undoLastTranscriptOp();
  renameSpeaker = (id: MeetingId, label: string, name: string): Promise<void> =>
    this.speakerFacade.renameSpeaker(id, label, name);
  removeSpeaker = (id: MeetingId, label: string): Promise<void> => this.speakerFacade.removeSpeaker(id, label);
  setSegmentSpeaker = (id: MeetingId, index: number, speaker: string): Promise<void> =>
    this.speakerFacade.setSegmentSpeaker(id, index, speaker);
  setSegmentSpeakers = (id: MeetingId, indices: readonly number[], speaker: string): Promise<void> =>
    this.speakerFacade.setSegmentSpeakers(id, indices, speaker);
  deleteTranscriptSegment = (id: MeetingId, index: number, expectedText: string): Promise<void> =>
    this.transcriptEditingFacade.deleteTranscriptSegment(id, index, expectedText);
  mergeTranscriptSegmentUp = (id: MeetingId, index: number, expectedText: string): Promise<void> =>
    this.transcriptEditingFacade.mergeTranscriptSegmentUp(id, index, expectedText);

  /** Orchestrates the save dialog then the export; a `null` (cancelled) dialog result is a silent no-op. */
  async exportMeeting(id: MeetingId, format: MeetingExportFormat, suggestedName: string): Promise<void> {
    try {
      const dest = await this.fileDialog.save(suggestedName, EXPORT_EXTENSIONS[format]);
      if (dest === null) {
        return;
      }
      await this.exportMeetingUseCase.export(id, format, dest);
      this.store.clearError();
    } catch (caught) {
      this.store.setError(toErrorInfo(caught));
    }
  }

  /** Imports a `.wav` file as a new meeting; see `runImportAudio` for the full orchestration. */
  async importAudio(): Promise<void> {
    await runImportAudio(this.store, this.fileDialog, this.importAudioUseCase);
  }

  /** Re-transcribes an existing meeting, optionally replacing its audio; see `runRetranscribeMeeting`. */
  async retranscribeMeeting(id: MeetingId, replaceAudio: boolean): Promise<void> {
    await runRetranscribeMeeting(this.store, this.fileDialog, this.retranscribeMeetingUseCase, id, replaceAudio);
  }

  /** Cancels an in-flight import/re-transcribe; always clears `importing`, even on failure. */
  async cancelImport(): Promise<void> {
    await runCancelImport(this.store, this.cancelImportUseCase);
  }

  /** Detects speakers in a meeting's system-audio track and relabels its transcript; see `runDiarizeMeeting`. */
  async diarizeMeeting(id: MeetingId): Promise<void> {
    await runDiarizeMeeting(this.store, this.diarizeMeetingUseCase, id);
  }

  checkSystemAudio = (): Promise<void> =>
    this.guarded(async () => this.store.setSystemAudioStatus(await this.checkSystemAudioUseCase.status()));
  requestSystemAudioPermission = (): Promise<void> =>
    this.guarded(async () => this.store.setSystemAudioStatus(await this.checkSystemAudioUseCase.request()));

  selectCaptureSource(source: CaptureSource): void {
    this.store.setCaptureSource(source);
  }

  loadAudioSources = (): Promise<void> =>
    this.guarded(async () => this.store.setAudioSources(await this.listAudioSourcesUseCase.list()));

  /** Selects the system-audio source the NEXT recording will use; persisted by the store. */
  selectAudioSource(id: string): void {
    this.store.setSelectedAudioSource(id);
  }

  loadSummaryLanguages = (): Promise<void> =>
    this.guarded(async () => this.store.setSummaryLanguages(await this.listSummaryLanguagesUseCase.list()));

  /** Selects the language the NEXT summary generation will use; persisted by the store. */
  selectSummaryLanguage(code: string): void {
    this.store.setSelectedSummaryLanguage(code);
  }

  /** Fetches and caches a persisted summary for one (meeting, template, language) triple; a no-op once cached, so tab switches never re-hit IPC. */
  async loadSummary(id: MeetingId, template: string, language: string): Promise<void> {
    if (this.store.getSummaryCacheEntry(id, template, language)) {
      return;
    }
    this.store.setSummaryCacheLoading(id, template, language);
    try {
      const summary = await this.getSummaryUseCase.get(id, template, language);
      this.store.setSummaryCacheResult(id, template, language, summary);
      this.store.clearError();
    } catch (caught) {
      // Drop the loading marker so the next tab visit retries instead of getting stuck.
      this.store.clearSummaryCacheEntry(id, template, language);
      this.store.setError(toErrorInfo(caught));
    }
  }

  loadAppVersion = (): Promise<void> =>
    this.guarded(async () => this.store.setAppVersion(await this.getAppVersionUseCase.version()));

  /** Persists the transcript/summary split ratio for the NEXT session too, via the store. */
  setSplitRatio(ratio: number): void {
    this.store.setSplitRatio(ratio);
  }

  /** Persists whether the transcript column is collapsed for the NEXT session too, via the store. */
  setTranscriptCollapsed(collapsed: boolean): void {
    this.store.setTranscriptCollapsed(collapsed);
  }
  getAudioUrl = (meetingId: MeetingId): Promise<string | null> => this.audioRepository.getAudioUrl(meetingId);

  loadFolders = (): Promise<void> =>
    this.guarded(async () => this.store.setFolders(await this.listFoldersUseCase.execute()));
  createFolder = (name: string): Promise<void> =>
    this.guarded(async () => this.store.addFolder(await this.createFolderUseCase.execute(name)));
  renameFolder = (id: FolderId, name: string): Promise<void> =>
    this.guarded(async () => this.store.updateFolder(await this.renameFolderUseCase.execute(id, name)));

  /** Deletes a folder, then re-runs `loadMeetings` so meetings reassigned back to unfiled refresh. */
  async deleteFolder(id: FolderId): Promise<void> {
    await this.guarded(async () => {
      await this.deleteFolderUseCase.execute(id);
      this.store.removeFolder(id);
      await this.loadMeetings();
    });
  }

  /** Assigns/clears a meeting's folder; never optimistic, mirrors setMeetingArchived. */
  async setMeetingFolder(id: MeetingId, folderId: FolderId | null): Promise<void> {
    await this.applyMeetingMutation(() => this.setMeetingFolderUseCase.execute(id, folderId));
  }
  /** Places a meeting's container + ordering in one write, then reloads; see `runPlaceMeeting`. */
  async placeMeeting(id: MeetingId, folderId: FolderId | null, archived: boolean, previousId: MeetingId | null, nextId: MeetingId | null): Promise<void> {
    await runPlaceMeeting(this.store, this.placeMeetingUseCase, () => this.loadMeetings(), id, folderId, archived, previousId, nextId);
  }
  /** Toggles a folder's expanded/collapsed state; synchronous, always-succeeds preference toggle, mirrors selectDevice/selectCaptureSource. */
  toggleFolderExpanded(id: FolderId): void {
    this.store.toggleFolderExpanded(id);
  }
}
