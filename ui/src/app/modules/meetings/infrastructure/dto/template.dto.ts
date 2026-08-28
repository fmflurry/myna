/**
 * Mirrors `myna_llm::Template` directly — `list_templates` returns this
 * struct as-is, with no camelCase-renaming DTO wrapper. Verified against
 * `crates/myna-llm/src/template.rs`: the struct has no
 * `#[serde(rename_all = ...)]` attribute, so `section_schema` serializes in
 * snake_case, unlike every other command payload in this module. `label`
 * and `emoji` are single-word field names, so snake_case vs. camelCase is
 * moot for them — they serialize verbatim as `label` / `emoji`.
 *
 * `section_schema` is `Option<serde_json::Value>` on the Rust side: an
 * arbitrary advisory JSON Schema document (see `templates/schema.json`),
 * NOT an array of `{ key, title }` pairs. It does not structurally match
 * the existing core `SummaryTemplate.sectionSchema` shape
 * (`readonly SummarySection[]`) — see `template.mapper.ts` for how that
 * pre-existing mismatch is resolved.
 *
 * `label` and `emoji` are `#[serde(default)]` `Option<String>` on the Rust
 * side (see `Template::label` / `Template::emoji`) — with no
 * `skip_serializing_if`, `None` serializes to JSON `null` (not an absent
 * key), same as `MeetingDto.audioPath` / `MeetingDto.transcript`. `null`
 * for user-authored templates predating these fields, a real string for
 * the four built-ins (`meeting-notes`, `key-points`, `action-items`,
 * `decisions`).
 */
export interface TemplateDto {
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
  readonly section_schema: unknown;
  readonly label: string | null;
  readonly emoji: string | null;
}
