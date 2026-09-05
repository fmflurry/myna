import { Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { map } from 'rxjs';

import { toMeetingId } from '../../core/models/meeting.model';
import type { MeetingId } from '../../core/models/meeting.model';
import type { SummaryLanguage } from '../../core/models/summary-language.model';
import type { Summary } from '../../core/models/summary.model';
import type { SummaryInstructionsDraft } from '../../core/models/summary-instructions.model';
import type { SummaryTemplate } from '../../core/models/summary-template.model';
import { SummarizerPort } from '../../core/ports/summarizer.port';
import type { SummaryToken } from '../../core/ports/summarizer.port';
import { mapSummaryDtoToDomain, mapSummaryLanguageDtoToDomain } from '../mappers/summary.mapper';
import { invokeCommand, onEvent } from './ipc';

/** `SummarizerPort` implementation backed by the Tauri IPC command surface. */
@Injectable()
export class TauriSummarizerAdapter extends SummarizerPort {
  override async summarize(
    id: MeetingId,
    template: SummaryTemplate,
    language?: string,
    instructions?: SummaryInstructionsDraft,
  ): Promise<Summary> {
    const dto = await invokeCommand('summarize_meeting', {
      meetingId: id,
      template: template.name,
      // `exactOptionalPropertyTypes` forbids assigning `undefined` to an
      // optional key, so an unset language is omitted via conditional
      // spread rather than set to `undefined` — the Rust side then falls
      // back to `en` on its own.
      ...(language !== undefined ? { language } : {}),
      // Same idiom for instructions: an unset draft is omitted entirely so
      // the Rust side applies the persisted general guidelines by default.
      ...(instructions !== undefined
        ? {
            instructions: {
              specific: instructions.text,
              includeGeneral: instructions.includeGeneral,
            },
          }
        : {}),
    });
    return mapSummaryDtoToDomain(dto);
  }

  override async listLanguages(): Promise<readonly SummaryLanguage[]> {
    const dtos = await invokeCommand('list_summary_languages', {});
    return dtos.map(mapSummaryLanguageDtoToDomain);
  }

  override tokens(): Observable<SummaryToken> {
    return onEvent('summary://token').pipe(
      map((dto) => ({ meetingId: toMeetingId(dto.meetingId), template: dto.template, token: dto.token })),
    );
  }

  override done(): Observable<Summary> {
    // `summary://done` carries no `createdAt` — the moment of receipt is
    // used as a best-effort approximation. The authoritative timestamp is
    // the one returned by `summarize()` itself.
    return onEvent('summary://done').pipe(
      map((dto) => ({
        template: dto.template,
        markdown: dto.markdown,
        createdAt: new Date(),
        language: dto.language,
        // A summary just streamed in from generation is never stale.
        stale: false,
      })),
    );
  }

  override async cancel(): Promise<void> {
    await invokeCommand('cancel_summarization', {});
  }

  override async getSummary(id: MeetingId, template: string, language: string): Promise<Summary | null> {
    const dto = await invokeCommand('get_summary', { meetingId: id, template, language });
    return dto ? mapSummaryDtoToDomain(dto) : null;
  }

  override async editSummary(id: MeetingId, template: string, language: string, markdown: string): Promise<Summary> {
    const dto = await invokeCommand('edit_summary', { meetingId: id, template, language, markdown });
    return mapSummaryDtoToDomain(dto);
  }

  override async deleteSummary(id: MeetingId, template: string, language: string): Promise<void> {
    await invokeCommand('delete_summary', { meetingId: id, template, language });
  }

  override async getGuidelines(): Promise<string> {
    return invokeCommand('get_summary_guidelines', {});
  }

  override async setGuidelines(text: string): Promise<void> {
    await invokeCommand('set_summary_guidelines', { guidelines: text });
  }
}
