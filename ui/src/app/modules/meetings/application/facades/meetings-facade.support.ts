import { MeetingsError } from '../../core/models/recording-state.model';
import type { MeetingExportFormat } from '../../core/ports/meeting-repository.port';
import type { MeetingsErrorInfo } from '../stores/meetings.store';

/** File extension the save dialog should offer for each export format. */
export const EXPORT_EXTENSIONS: Readonly<Record<MeetingExportFormat, string>> = {
  markdown: 'md',
  json: 'json',
  txt: 'txt',
};

export const toErrorInfo = (caught: unknown): MeetingsErrorInfo => {
  if (caught instanceof MeetingsError) {
    return { code: caught.code, message: caught.message };
  }
  if (caught instanceof Error) {
    return { code: 'UNKNOWN', message: caught.message };
  }
  return { code: 'UNKNOWN', message: String(caught) };
};
