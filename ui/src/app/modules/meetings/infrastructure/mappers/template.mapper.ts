import type { SummaryTemplate } from '../../core/models/summary-template.model';
import type { TemplateDto } from '../dto/template.dto';

/**
 * Maps a `TemplateDto` (`myna_llm::Template`, verified snake_case — see
 * the DTO's doc comment) to the domain `SummaryTemplate`.
 *
 * `section_schema` on the Rust side is an arbitrary advisory JSON Schema
 * document, not an array of `{ key, title }` pairs, so it cannot be mapped
 * into the core `SummarySection[]` shape without guessing at structure.
 * `sectionSchema` is therefore always omitted here (left `undefined`) — a
 * known pre-existing mismatch between the core model and the actual Rust
 * payload, not something this mapper can safely resolve.
 *
 * `label` and `emoji` are `string | null` on the wire (see the DTO's doc
 * comment) but optional on the domain model, so `null` is mapped to an
 * absent key via conditional spread — matching how `MeetingDto.audioPath`
 * / `MeetingDto.transcript` are handled in `meeting.mapper.ts` — rather
 * than an explicit `undefined`, which `exactOptionalPropertyTypes` forbids.
 */
export function mapTemplateDtoToDomain(dto: TemplateDto): SummaryTemplate {
  return {
    name: dto.name,
    description: dto.description,
    prompt: dto.prompt,
    ...(dto.label !== null ? { label: dto.label } : {}),
    ...(dto.emoji !== null ? { emoji: dto.emoji } : {}),
  };
}
