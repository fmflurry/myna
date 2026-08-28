import type { SummaryLanguage } from '../../core/models/summary-language.model';
import type { Summary } from '../../core/models/summary.model';
import type { SummaryDto, SummaryLanguageDto, SummaryRefDto } from '../dto/summary.dto';

/** Maps a full `SummaryDto` (from `summarize_meeting`) to the domain `Summary`. */
export function mapSummaryDtoToDomain(dto: SummaryDto): Summary {
  return {
    template: dto.template,
    markdown: dto.markdown,
    createdAt: new Date(dto.createdAt),
    language: dto.language,
  };
}

/**
 * Maps a `SummaryRefDto` — a pointer to a persisted summary, as embedded
 * in `MeetingDto.summaries` — to the domain `Summary`.
 *
 * `SummaryRefDto` carries no `markdown` field, so it is mapped to `''`
 * here — that is the caller's signal that the content still needs to be
 * fetched. Callers wanting the real content call `SummarizerPort.getSummary`
 * (backed by the `get_summary` command) for that exact (meeting, template,
 * language) triple and cache the result; see `MeetingsFacade.loadSummary`.
 */
export function mapSummaryRefDtoToDomain(dto: SummaryRefDto): Summary {
  return {
    template: dto.template,
    markdown: '',
    createdAt: new Date(dto.createdAt),
    language: dto.language,
  };
}

/** Maps a `SummaryLanguageDto` entry (from `list_summary_languages`) to the domain `SummaryLanguage`. */
export function mapSummaryLanguageDtoToDomain(dto: SummaryLanguageDto): SummaryLanguage {
  return { code: dto.code, label: dto.label };
}
