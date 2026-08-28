import type { EnvironmentProviders } from '@angular/core';
import { makeEnvironmentProviders } from '@angular/core';

import { AppInfoPort } from './core/ports/app-info.port';
import { FileDialogPort } from './core/ports/file-dialog.port';
import { MeetingRepositoryPort } from './core/ports/meeting-repository.port';
import { ModelsStatusPort } from './core/ports/models-status.port';
import { PreferencesPort } from './core/ports/preferences.port';
import { RecorderPort } from './core/ports/recorder.port';
import { SummarizerPort } from './core/ports/summarizer.port';
import { TemplateRepositoryPort } from './core/ports/template-repository.port';
import { TranscriberPort } from './core/ports/transcriber.port';
import { LocalStoragePreferencesAdapter } from './infrastructure/local-storage-preferences.adapter';
import { TauriAppInfoAdapter } from './infrastructure/tauri/tauri-app-info.adapter';
import { TauriFileDialogAdapter } from './infrastructure/tauri/tauri-file-dialog.adapter';
import { TauriMeetingRepositoryAdapter } from './infrastructure/tauri/tauri-meeting-repository.adapter';
import { TauriModelsStatusAdapter } from './infrastructure/tauri/tauri-models-status.adapter';
import { TauriRecorderAdapter } from './infrastructure/tauri/tauri-recorder.adapter';
import { TauriSummarizerAdapter } from './infrastructure/tauri/tauri-summarizer.adapter';
import { TauriTemplateRepositoryAdapter } from './infrastructure/tauri/tauri-template-repository.adapter';
import { TauriTranscriberAdapter } from './infrastructure/tauri/tauri-transcriber.adapter';
import { CancelRecordingUseCase } from './application/use-cases/cancel-recording.usecase';
import { CancelSummarizationUseCase } from './application/use-cases/cancel-summarization.usecase';
import { CheckModelsUseCase } from './application/use-cases/check-models.usecase';
import { CheckSystemAudioUseCase } from './application/use-cases/check-system-audio.usecase';
import { DeleteMeetingUseCase } from './application/use-cases/delete-meeting.usecase';
import { ExportMeetingUseCase } from './application/use-cases/export-meeting.usecase';
import { GetAppVersionUseCase } from './application/use-cases/get-app-version.usecase';
import { GetSummaryUseCase } from './application/use-cases/get-summary.usecase';
import { ListAudioSourcesUseCase } from './application/use-cases/list-audio-sources.usecase';
import { ListDevicesUseCase } from './application/use-cases/list-devices.usecase';
import { ListMeetingsUseCase } from './application/use-cases/list-meetings.usecase';
import { ListSummaryLanguagesUseCase } from './application/use-cases/list-summary-languages.usecase';
import { ListTemplatesUseCase } from './application/use-cases/list-templates.usecase';
import { OpenMeetingUseCase } from './application/use-cases/open-meeting.usecase';
import { RenameMeetingUseCase } from './application/use-cases/rename-meeting.usecase';
import { StartRecordingUseCase } from './application/use-cases/start-recording.usecase';
import { StopRecordingUseCase } from './application/use-cases/stop-recording.usecase';
import { SummarizeMeetingUseCase } from './application/use-cases/summarize-meeting.usecase';
import { MeetingsFacade } from './application/facades/meetings.facade';
import { MeetingsStore } from './application/stores/meetings.store';

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
    { provide: TemplateRepositoryPort, useClass: TauriTemplateRepositoryAdapter },
    { provide: ModelsStatusPort, useClass: TauriModelsStatusAdapter },
    { provide: FileDialogPort, useClass: TauriFileDialogAdapter },
    { provide: PreferencesPort, useClass: LocalStoragePreferencesAdapter },
    { provide: AppInfoPort, useClass: TauriAppInfoAdapter },
    StartRecordingUseCase,
    StopRecordingUseCase,
    CancelRecordingUseCase,
    ListMeetingsUseCase,
    OpenMeetingUseCase,
    DeleteMeetingUseCase,
    RenameMeetingUseCase,
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
    MeetingsStore,
    MeetingsFacade,
  ]);
}
