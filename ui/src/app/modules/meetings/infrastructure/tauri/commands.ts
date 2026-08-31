import type { CaptureSource, SystemAudioStatus } from '../../core/models/capture-source.model';
import type { AudioSourceDto, DeviceInfoDto } from '../dto/device.dto';
import type { FolderDto } from '../dto/folder.dto';
import type { MeetingDto } from '../dto/meeting.dto';
import type { ModelsStatusDto } from '../dto/models-status.dto';
import type { RecordingStatePayloadDto } from '../dto/event-payload.dto';
import type { SummaryDto, SummaryLanguageDto } from '../dto/summary.dto';
import type { TemplateDto } from '../dto/template.dto';
import type { TranscriptDto, TranscriptSegmentWireDto } from '../dto/transcript.dto';

/**
 * The frozen Rust command surface, registered verbatim in
 * `tauri::generate_handler!` (`app/src-tauri/src/lib.rs`). Every entry here
 * must match a Rust command name exactly — a typo becomes a compile error
 * at every call site instead of a silent runtime IPC failure.
 */
export const COMMAND_NAMES = [
  'list_input_devices',
  'default_input_device',
  'list_output_devices',
  'default_output_device',
  'list_audio_sources',
  'start_recording',
  'stop_recording',
  'cancel_recording',
  'recording_state',
  'list_meetings',
  'get_meeting',
  'delete_meeting',
  'rename_meeting',
  'set_meeting_archived',
  'edit_transcript_segment',
  'get_transcript',
  'list_templates',
  'list_summary_languages',
  'summarize_meeting',
  'cancel_summarization',
  'models_status',
  'download_command',
  'export_meeting',
  'system_audio_status',
  'request_system_audio_permission',
  'get_summary',
  'app_version',
  'import_audio',
  'retranscribe_meeting',
  'cancel_import',
  'diarize_meeting',
  'list_folders',
  'create_folder',
  'rename_folder',
  'delete_folder',
  'set_meeting_folder',
  'set_meeting_placement',
  'edit_summary',
  'rename_speaker',
  'remove_speaker',
  'set_segment_speaker',
  'delete_transcript_segment',
  'merge_transcript_segment_up',
  'restore_transcript_segments',
  'start_model_download',
  'start_diarization_download',
  'cancel_model_download',
  'get_meeting_audio_path',
] as const;

export type CommandName = (typeof COMMAND_NAMES)[number];

/** Marker for commands that take no invoke arguments. */
export type NoArgs = Record<string, never>;

/** Mirrors the Rust `ExportFormat` (`#[serde(rename_all = "lowercase")]`). */
export type ExportFormatDto = 'markdown' | 'text' | 'json';

/**
 * Ties each {@link CommandName} to its exact invoke argument shape and
 * return DTO. Tauri auto-converts `#[tauri::command]` snake_case parameter
 * names to camelCase for the JS-facing `invoke` call (e.g. `meeting_id` ->
 * `meetingId`), which every arg shape below reflects.
 */
export interface CommandSignatures {
  readonly list_input_devices: { args: NoArgs; result: readonly DeviceInfoDto[] };
  readonly default_input_device: { args: NoArgs; result: DeviceInfoDto };
  readonly list_output_devices: { args: NoArgs; result: readonly DeviceInfoDto[] };
  readonly default_output_device: { args: NoArgs; result: DeviceInfoDto };
  readonly list_audio_sources: { args: NoArgs; result: readonly AudioSourceDto[] };
  readonly start_recording: {
    args: {
      readonly title: string;
      readonly device?: string;
      readonly source?: CaptureSource;
      readonly systemSource?: string;
    };
    result: MeetingDto;
  };
  readonly stop_recording: { args: NoArgs; result: MeetingDto };
  readonly cancel_recording: { args: NoArgs; result: void };
  readonly recording_state: { args: NoArgs; result: RecordingStatePayloadDto };
  readonly list_meetings: { args: NoArgs; result: readonly MeetingDto[] };
  readonly get_meeting: { args: { readonly id: string }; result: MeetingDto };
  readonly delete_meeting: { args: { readonly id: string }; result: void };
  readonly rename_meeting: {
    args: { readonly meetingId: string; readonly title: string };
    result: MeetingDto;
  };
  readonly set_meeting_archived: {
    args: { readonly meetingId: string; readonly archived: boolean };
    result: MeetingDto;
  };
  readonly edit_transcript_segment: {
    args: { readonly meetingId: string; readonly segmentIndex: number; readonly text: string };
    result: MeetingDto;
  };
  readonly get_transcript: { args: { readonly id: string }; result: TranscriptDto | null };
  readonly list_templates: { args: NoArgs; result: readonly TemplateDto[] };
  readonly list_summary_languages: { args: NoArgs; result: readonly SummaryLanguageDto[] };
  readonly summarize_meeting: {
    args: { readonly meetingId: string; readonly template: string; readonly language?: string };
    result: SummaryDto;
  };
  readonly cancel_summarization: { args: NoArgs; result: void };
  readonly models_status: { args: NoArgs; result: ModelsStatusDto };
  readonly download_command: { args: NoArgs; result: string };
  readonly export_meeting: {
    args: { readonly meetingId: string; readonly format: ExportFormatDto; readonly dest: string };
    result: void;
  };
  readonly system_audio_status: { args: NoArgs; result: SystemAudioStatus };
  readonly request_system_audio_permission: { args: NoArgs; result: SystemAudioStatus };
  readonly get_summary: {
    args: { readonly meetingId: string; readonly template: string; readonly language: string };
    result: SummaryDto | null;
  };
  readonly app_version: { args: NoArgs; result: string };
  readonly import_audio: {
    args: { readonly path: string; readonly title?: string };
    result: MeetingDto;
  };
  readonly retranscribe_meeting: {
    args: { readonly meetingId: string; readonly path?: string };
    result: MeetingDto;
  };
  readonly cancel_import: { args: NoArgs; result: void };
  readonly diarize_meeting: {
    args: { readonly meetingId: string };
    result: MeetingDto;
  };
  readonly list_folders: { args: NoArgs; result: readonly FolderDto[] };
  readonly create_folder: { args: { readonly name: string }; result: FolderDto };
  readonly rename_folder: {
    args: { readonly folderId: string; readonly name: string };
    result: FolderDto;
  };
  readonly delete_folder: { args: { readonly folderId: string }; result: void };
  readonly set_meeting_folder: {
    args: { readonly meetingId: string; readonly folderId: string | null };
    result: MeetingDto;
  };
  readonly set_meeting_placement: {
    args: {
      readonly meetingId: string;
      readonly folderId: string | null;
      readonly archived: boolean;
      readonly previousId: string | null;
      readonly nextId: string | null;
    };
    result: MeetingDto;
  };
  readonly edit_summary: {
    args: {
      readonly meetingId: string;
      readonly template: string;
      readonly language: string;
      readonly markdown: string;
    };
    result: SummaryDto;
  };
  readonly rename_speaker: {
    args: { readonly meetingId: string; readonly label: string; readonly name: string };
    result: MeetingDto;
  };
  readonly remove_speaker: {
    args: { readonly meetingId: string; readonly label: string };
    result: MeetingDto;
  };
  readonly set_segment_speaker: {
    args: { readonly meetingId: string; readonly segmentIndex: number; readonly speaker: string };
    result: MeetingDto;
  };
  readonly delete_transcript_segment: {
    args: {
      readonly meetingId: string;
      readonly segmentIndex: number;
      readonly expectedText: string;
    };
    result: MeetingDto;
  };
  readonly merge_transcript_segment_up: {
    args: {
      readonly meetingId: string;
      readonly segmentIndex: number;
      readonly expectedText: string;
    };
    result: MeetingDto;
  };
  readonly restore_transcript_segments: {
    args: {
      readonly meetingId: string;
      readonly segmentIndex: number;
      readonly removeCount: number;
      readonly segments: readonly TranscriptSegmentWireDto[];
    };
    result: MeetingDto;
  };
  readonly start_model_download: { args: NoArgs; result: void };
  readonly start_diarization_download: { args: NoArgs; result: void };
  readonly cancel_model_download: { args: NoArgs; result: void };
  readonly get_meeting_audio_path: { args: { readonly id: string }; result: string | null };
}

export type CommandArgs<C extends CommandName> = CommandSignatures[C]['args'];
export type CommandResult<C extends CommandName> = CommandSignatures[C]['result'];
