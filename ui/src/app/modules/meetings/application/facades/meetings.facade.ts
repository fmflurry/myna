import { Injectable, inject } from '@angular/core';

import type { CaptureSource } from '../../core/models/capture-source.model';
import type { Meeting, MeetingId } from '../../core/models/meeting.model';
import { withSummary } from '../../core/models/meeting.model';
import type { SummaryTemplate } from '../../core/models/summary-template.model';
import { FileDialogPort } from '../../core/ports/file-dialog.port';
import type { MeetingExportFormat } from '../../core/ports/meeting-repository.port';
import { CancelRecordingUseCase } from '../use-cases/cancel-recording.usecase';
import { CancelSummarizationUseCase } from '../use-cases/cancel-summarization.usecase';
import { CheckModelsUseCase } from '../use-cases/check-models.usecase';
import { CheckSystemAudioUseCase } from '../use-cases/check-system-audio.usecase';
import { DeleteMeetingUseCase } from '../use-cases/delete-meeting.usecase';
import { EditTranscriptSegmentUseCase } from '../use-cases/edit-transcript-segment.usecase';
import { ExportMeetingUseCase } from '../use-cases/export-meeting.usecase';
import { GetAppVersionUseCase } from '../use-cases/get-app-version.usecase';
import { GetSummaryUseCase } from '../use-cases/get-summary.usecase';
import { ListAudioSourcesUseCase } from '../use-cases/list-audio-sources.usecase';
import { ListDevicesUseCase } from '../use-cases/list-devices.usecase';
import { ListMeetingsUseCase } from '../use-cases/list-meetings.usecase';
import { ListSummaryLanguagesUseCase } from '../use-cases/list-summary-languages.usecase';
import { ListTemplatesUseCase } from '../use-cases/list-templates.usecase';
import { OpenMeetingUseCase } from '../use-cases/open-meeting.usecase';
import { RenameMeetingUseCase } from '../use-cases/rename-meeting.usecase';
import { SetMeetingArchivedUseCase } from '../use-cases/set-meeting-archived.usecase';
import { StartRecordingUseCase } from '../use-cases/start-recording.usecase';
import { StopRecordingUseCase } from '../use-cases/stop-recording.usecase';
import { SummarizeMeetingUseCase } from '../use-cases/summarize-meeting.usecase';
import { MeetingsStore } from '../stores/meetings.store';
import { EXPORT_EXTENSIONS, toErrorInfo } from './meetings-facade.support';

/**
 * The ONLY class components are allowed to inject for the meetings module.
 * Exposes readonly signals from MeetingsStore plus thin methods delegating
 * to use cases. Never re-exports or exposes a use case.
 */
@Injectable()
export class MeetingsFacade {
  private readonly store = inject(MeetingsStore);
  private readonly startRecordingUseCase = inject(StartRecordingUseCase);
  private readonly stopRecordingUseCase = inject(StopRecordingUseCase);
  private readonly cancelRecordingUseCase = inject(CancelRecordingUseCase);
  private readonly listMeetingsUseCase = inject(ListMeetingsUseCase);
  private readonly openMeetingUseCase = inject(OpenMeetingUseCase);
  private readonly deleteMeetingUseCase = inject(DeleteMeetingUseCase);
  private readonly renameMeetingUseCase = inject(RenameMeetingUseCase);
  private readonly setMeetingArchivedUseCase = inject(SetMeetingArchivedUseCase);
  private readonly editTranscriptSegmentUseCase = inject(EditTranscriptSegmentUseCase);
  private readonly summarizeMeetingUseCase = inject(SummarizeMeetingUseCase);
  private readonly listTemplatesUseCase = inject(ListTemplatesUseCase);
  private readonly checkModelsUseCase = inject(CheckModelsUseCase);
  private readonly listDevicesUseCase = inject(ListDevicesUseCase);
  private readonly listAudioSourcesUseCase = inject(ListAudioSourcesUseCase);
  private readonly cancelSummarizationUseCase = inject(CancelSummarizationUseCase);
  private readonly exportMeetingUseCase = inject(ExportMeetingUseCase);
  private readonly checkSystemAudioUseCase = inject(CheckSystemAudioUseCase);
  private readonly listSummaryLanguagesUseCase = inject(ListSummaryLanguagesUseCase);
  private readonly getSummaryUseCase = inject(GetSummaryUseCase);
  private readonly getAppVersionUseCase = inject(GetAppVersionUseCase);
  private readonly fileDialog = inject(FileDialogPort);

  readonly meetings = this.store.meetings;
  readonly selectedMeeting = this.store.selectedMeeting;
  readonly recordingState = this.store.recordingState;
  readonly finalizedSegments = this.store.finalizedSegments;
  readonly partialText = this.store.partialText;
  readonly level = this.store.level;
  readonly templates = this.store.templates;
  readonly modelsStatus = this.store.modelsStatus;
  readonly summaryStream = this.store.summaryStream;
  readonly error = this.store.error;
  readonly busy = this.store.busy;
  readonly devices = this.store.devices;
  readonly selectedDevice = this.store.selectedDevice;
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
  clearSelection(): void {
    this.store.clearSelectedMeeting();
  }

  async loadMeetings(): Promise<void> {
    try {
      const meetings = await this.listMeetingsUseCase.list();
      this.store.setMeetings(meetings);
      this.store.clearError();
    } catch (caught) {
      this.store.setError(toErrorInfo(caught));
    }
  }

  async openMeeting(id: MeetingId): Promise<void> {
    try {
      const meeting = await this.openMeetingUseCase.open(id);
      this.store.setSelectedMeeting(meeting);
      this.store.clearError();
    } catch (caught) {
      this.store.setError(toErrorInfo(caught));
    }
  }

  async deleteMeeting(id: MeetingId): Promise<void> {
    try {
      await this.deleteMeetingUseCase.delete(id);
      this.store.setMeetings(this.store.meetings().filter((meeting) => meeting.id !== id));
      if (this.store.selectedMeeting()?.id === id) {
        this.store.clearSelectedMeeting();
      }
      this.store.clearError();
    } catch (caught) {
      this.store.setError(toErrorInfo(caught));
    }
  }

  /** Runs a mutation that returns the meeting the backend actually persisted, mirrors it into the store, and funnels any failure into the shared error slot. Never optimistic. */
  private async applyMeetingMutation(mutate: () => Promise<Meeting>): Promise<void> {
    try {
      this.store.updateMeeting(await mutate());
      this.store.clearError();
    } catch (caught) {
      this.store.setError(toErrorInfo(caught));
    }
  }

  /**
   * Renames a meeting. Only updates the store with the meeting the Rust
   * command actually persisted (never optimistically), so a failed rename
   * never leaves a stale title on screen — the sidebar row and detail
   * heading simply keep showing whatever was already correct.
   */
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

  async summarizeMeeting(id: MeetingId, template: SummaryTemplate): Promise<void> {
    // Captured once, up front — NOT re-read reactively — so switching the
    // summary language mid-generation (e.g. en -> fr) never rewrites which
    // tab this in-flight generation belongs to. The fr tab is a different
    // (template, language) pair and must show its own state, not this one.
    const language = this.store.selectedSummaryLanguage();
    try {
      this.store.resetSummaryStream();
      this.store.setSummarizingKey({ template: template.name, language });
      const summary = await this.summarizeMeetingUseCase.summarize(id, template, language);
      const current = this.store.selectedMeeting();
      if (current && current.id === id) {
        this.store.setSelectedMeeting(withSummary(current, summary));
      }
      // Lands the freshly generated summary in the same cache `loadSummary`
      // reads from, so switching tabs away and back never re-fetches (or
      // appears to lose) content generated earlier in this session.
      this.store.setSummaryCacheResult(id, summary.template, summary.language, summary);
      this.store.clearError();
    } catch (caught) {
      this.store.setError(toErrorInfo(caught));
    } finally {
      // Runs on success, failure, AND cancellation alike, so no tab is ever
      // left stuck claiming to generate once this call settles.
      this.store.setSummarizingKey(null);
    }
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

  async loadTemplates(): Promise<void> {
    try {
      const templates = await this.listTemplatesUseCase.list();
      this.store.setTemplates(templates);
      this.store.clearError();
    } catch (caught) {
      this.store.setError(toErrorInfo(caught));
    }
  }

  async checkModels(): Promise<void> {
    try {
      const status = await this.checkModelsUseCase.check();
      this.store.setModelsStatus(status);
      this.store.clearError();
    } catch (caught) {
      this.store.setError(toErrorInfo(caught));
    }
  }

  async loadDevices(): Promise<void> {
    try {
      const devices = await this.listDevicesUseCase.list();
      this.store.setDevices(devices);
      if (!this.store.selectedDevice()) {
        const defaultDevice = await this.listDevicesUseCase.default();
        this.store.setSelectedDevice(defaultDevice);
      }
      this.store.clearError();
    } catch (caught) {
      this.store.setError(toErrorInfo(caught));
    }
  }

  selectDevice(name: string): void {
    const match = this.store.devices().find((device) => device.name === name);
    if (match) {
      this.store.setSelectedDevice(match);
    }
  }

  /**
   * Orchestrates the save dialog then the export itself, so components
   * never touch `FileDialogPort` directly. A `null` dialog result (the
   * user cancelled) is a silent no-op, never surfaced as an error.
   */
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

  async checkSystemAudio(): Promise<void> {
    try {
      const status = await this.checkSystemAudioUseCase.status();
      this.store.setSystemAudioStatus(status);
      this.store.clearError();
    } catch (caught) {
      this.store.setError(toErrorInfo(caught));
    }
  }

  async requestSystemAudioPermission(): Promise<void> {
    try {
      const status = await this.checkSystemAudioUseCase.request();
      this.store.setSystemAudioStatus(status);
      this.store.clearError();
    } catch (caught) {
      this.store.setError(toErrorInfo(caught));
    }
  }

  selectCaptureSource(source: CaptureSource): void {
    this.store.setCaptureSource(source);
  }

  async loadAudioSources(): Promise<void> {
    try {
      const sources = await this.listAudioSourcesUseCase.list();
      this.store.setAudioSources(sources);
      this.store.clearError();
    } catch (caught) {
      this.store.setError(toErrorInfo(caught));
    }
  }

  /** Selects the system-audio source the NEXT recording will use; persisted by the store. */
  selectAudioSource(id: string): void {
    this.store.setSelectedAudioSource(id);
  }

  async loadSummaryLanguages(): Promise<void> {
    try {
      const languages = await this.listSummaryLanguagesUseCase.list();
      this.store.setSummaryLanguages(languages);
      this.store.clearError();
    } catch (caught) {
      this.store.setError(toErrorInfo(caught));
    }
  }

  /** Selects the language the NEXT summary generation will use; persisted by the store. */
  selectSummaryLanguage(code: string): void {
    this.store.setSelectedSummaryLanguage(code);
  }

  /**
   * Fetches a persisted summary's content for one exact (meeting, template,
   * language) triple and caches the result — a `null` resolution caches the
   * deliberate "nothing saved" outcome, never surfaced as an error. A no-op
   * once that triple already has a cache entry (loading, loaded, or empty),
   * so switching tabs back and forth never re-hits IPC.
   */
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
      // Drop the loading marker on failure so the next tab visit retries
      // instead of getting permanently stuck in the loading state.
      this.store.clearSummaryCacheEntry(id, template, language);
      this.store.setError(toErrorInfo(caught));
    }
  }

  async loadAppVersion(): Promise<void> {
    try {
      const version = await this.getAppVersionUseCase.version();
      this.store.setAppVersion(version);
      this.store.clearError();
    } catch (caught) {
      this.store.setError(toErrorInfo(caught));
    }
  }

  /** Persists the transcript/summary split ratio for the NEXT session too, via the store. */
  setSplitRatio(ratio: number): void {
    this.store.setSplitRatio(ratio);
  }

  /** Persists whether the transcript column is collapsed for the NEXT session too, via the store. */
  setTranscriptCollapsed(collapsed: boolean): void {
    this.store.setTranscriptCollapsed(collapsed);
  }
}
