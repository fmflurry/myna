import type { EnvironmentProviders } from '@angular/core';
import { makeEnvironmentProviders } from '@angular/core';

import { AppInfoPort } from './core/ports/app-info.port';
import { AudioImportPort } from './core/ports/audio-import.port';
import { FileDialogPort } from './core/ports/file-dialog.port';
import { FolderRepositoryPort } from './core/ports/folder-repository.port';
import { MeetingRepositoryPort } from './core/ports/meeting-repository.port';
import { ModelsStatusPort } from './core/ports/models-status.port';
import { PreferencesPort } from './core/ports/preferences.port';
import { RecorderPort } from './core/ports/recorder.port';
import { SummarizerPort } from './core/ports/summarizer.port';
import { TemplateRepositoryPort } from './core/ports/template-repository.port';
import { TranscriberPort } from './core/ports/transcriber.port';
import { LocalStoragePreferencesAdapter } from './infrastructure/local-storage-preferences.adapter';
import { TauriAppInfoAdapter } from './infrastructure/tauri/tauri-app-info.adapter';
import { TauriAudioImportAdapter } from './infrastructure/tauri/tauri-audio-import.adapter';
import { TauriFileDialogAdapter } from './infrastructure/tauri/tauri-file-dialog.adapter';
import { TauriFolderRepositoryAdapter } from './infrastructure/tauri/tauri-folder-repository.adapter';
import { TauriMeetingRepositoryAdapter } from './infrastructure/tauri/tauri-meeting-repository.adapter';
import { TauriModelsStatusAdapter } from './infrastructure/tauri/tauri-models-status.adapter';
import { TauriRecorderAdapter } from './infrastructure/tauri/tauri-recorder.adapter';
import { TauriSummarizerAdapter } from './infrastructure/tauri/tauri-summarizer.adapter';
import { TauriTemplateRepositoryAdapter } from './infrastructure/tauri/tauri-template-repository.adapter';
import { TauriTranscriberAdapter } from './infrastructure/tauri/tauri-transcriber.adapter';
import { CancelImportUseCase } from './application/use-cases/cancel-import.usecase';
import { CancelRecordingUseCase } from './application/use-cases/cancel-recording.usecase';
import { CancelSummarizationUseCase } from './application/use-cases/cancel-summarization.usecase';
import { CheckModelsUseCase } from './application/use-cases/check-models.usecase';
import { CheckSystemAudioUseCase } from './application/use-cases/check-system-audio.usecase';
import { CreateFolderUseCase } from './application/use-cases/create-folder.usecase';
import { DeleteFolderUseCase } from './application/use-cases/delete-folder.usecase';
import { DeleteMeetingUseCase } from './application/use-cases/delete-meeting.usecase';
import { DeleteTranscriptSegmentUseCase } from './application/use-cases/delete-transcript-segment.usecase';
import { DiarizeMeetingUseCase } from './application/use-cases/diarize-meeting.usecase';
import { EditSummaryUseCase } from './application/use-cases/edit-summary.usecase';
import { EditTranscriptSegmentUseCase } from './application/use-cases/edit-transcript-segment.usecase';
import { ExportMeetingUseCase } from './application/use-cases/export-meeting.usecase';
import { GetAppVersionUseCase } from './application/use-cases/get-app-version.usecase';
import { GetSummaryUseCase } from './application/use-cases/get-summary.usecase';
import { ImportAudioUseCase } from './application/use-cases/import-audio.usecase';
import { InitializeModelsUseCase } from './application/use-cases/initialize-models.usecase';
import { ListAudioSourcesUseCase } from './application/use-cases/list-audio-sources.usecase';
import { ListDevicesUseCase } from './application/use-cases/list-devices.usecase';
import { ListFoldersUseCase } from './application/use-cases/list-folders.usecase';
import { ListMeetingsUseCase } from './application/use-cases/list-meetings.usecase';
import { ListSummaryLanguagesUseCase } from './application/use-cases/list-summary-languages.usecase';
import { ListTemplatesUseCase } from './application/use-cases/list-templates.usecase';
import { MergeTranscriptSegmentUpUseCase } from './application/use-cases/merge-transcript-segment-up.usecase';
import { OpenMeetingUseCase } from './application/use-cases/open-meeting.usecase';
import { PlaceMeetingUseCase } from './application/use-cases/place-meeting.usecase';
import { RemoveSpeakerUseCase } from './application/use-cases/remove-speaker.usecase';
import { RenameFolderUseCase } from './application/use-cases/rename-folder.usecase';
import { RenameMeetingUseCase } from './application/use-cases/rename-meeting.usecase';
import { RenameSpeakerUseCase } from './application/use-cases/rename-speaker.usecase';
import { RestoreTranscriptSegmentsUseCase } from './application/use-cases/restore-transcript-segments.usecase';
import { RetranscribeMeetingUseCase } from './application/use-cases/retranscribe-meeting.usecase';
import { SetMeetingArchivedUseCase } from './application/use-cases/set-meeting-archived.usecase';
import { SetMeetingFolderUseCase } from './application/use-cases/set-meeting-folder.usecase';
import { SetSegmentSpeakerUseCase } from './application/use-cases/set-segment-speaker.usecase';
import { StartRecordingUseCase } from './application/use-cases/start-recording.usecase';
import { StopRecordingUseCase } from './application/use-cases/stop-recording.usecase';
import { SummarizeMeetingUseCase } from './application/use-cases/summarize-meeting.usecase';
import { DevicesFacade } from './application/facades/devices.facade';
import { MeetingsFacade } from './application/facades/meetings.facade';
import { ModelsFacade } from './application/facades/models.facade';
import { SpeakerFacade } from './application/facades/speaker.facade';
import { TranscriptEditingFacade } from './application/facades/transcript-editing.facade';
import { MeetingsStore } from './application/stores/meetings.store';
import { ModelInitializerPort } from './core/ports/model-initializer.port';
import { TauriModelInitializerAdapter } from './infrastructure/tauri/tauri-model-initializer.adapter';

/**
 * Self-registering module providers for the meetings feature.
 *
 * Each port is bound to its Tauri adapter. The in-memory fakes remain in
 * the tree for use directly by application-layer specs.
 */
export function provideMeetings(): EnvironmentProviders {
  return makeEnvironmentProviders([
    { provide: RecorderPort, useClass: TauriRecorderAdapter },
    { provide: TranscriberPort, useClass: TauriTranscriberAdapter },
    { provide: SummarizerPort, useClass: TauriSummarizerAdapter },
    { provide: MeetingRepositoryPort, useClass: TauriMeetingRepositoryAdapter },
    { provide: FolderRepositoryPort, useClass: TauriFolderRepositoryAdapter },
    { provide: TemplateRepositoryPort, useClass: TauriTemplateRepositoryAdapter },
    { provide: ModelsStatusPort, useClass: TauriModelsStatusAdapter },
    { provide: FileDialogPort, useClass: TauriFileDialogAdapter },
    { provide: PreferencesPort, useClass: LocalStoragePreferencesAdapter },
    { provide: AppInfoPort, useClass: TauriAppInfoAdapter },
    { provide: AudioImportPort, useClass: TauriAudioImportAdapter },
    { provide: ModelInitializerPort, useClass: TauriModelInitializerAdapter },
    StartRecordingUseCase,
    StopRecordingUseCase,
    CancelRecordingUseCase,
    ListMeetingsUseCase,
    OpenMeetingUseCase,
    DeleteMeetingUseCase,
    RenameMeetingUseCase,
    SetMeetingArchivedUseCase,
    EditTranscriptSegmentUseCase,
    EditSummaryUseCase,
    SummarizeMeetingUseCase,
    ListTemplatesUseCase,
    CheckModelsUseCase,
    ListDevicesUseCase,
    ListAudioSourcesUseCase,
    CancelSummarizationUseCase,
    ExportMeetingUseCase,
    CheckSystemAudioUseCase,
    ListSummaryLanguagesUseCase,
    GetSummaryUseCase,
    GetAppVersionUseCase,
    ImportAudioUseCase,
    RetranscribeMeetingUseCase,
    DiarizeMeetingUseCase,
    CancelImportUseCase,
    ListFoldersUseCase,
    CreateFolderUseCase,
    RenameFolderUseCase,
    DeleteFolderUseCase,
    SetMeetingFolderUseCase,
    PlaceMeetingUseCase,
    RenameSpeakerUseCase,
    RemoveSpeakerUseCase,
    SetSegmentSpeakerUseCase,
    DeleteTranscriptSegmentUseCase,
    MergeTranscriptSegmentUpUseCase,
    RestoreTranscriptSegmentsUseCase,
    InitializeModelsUseCase,
    MeetingsStore,
    SpeakerFacade,
    TranscriptEditingFacade,
    ModelsFacade,
    DevicesFacade,
    MeetingsFacade,
  ]);
}
