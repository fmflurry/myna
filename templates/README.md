# templates

JSON summary templates: each file is a prompt template plus an optional section schema, loaded and rendered by `myna-llm`. The same files drive both the CLI and the Angular GUI — plain JSON, no custom syntax, parseable by both `serde_json` and the browser's `JSON.parse`.

## Format

Every template file matches `schema.json` (JSON Schema draft 2020-12):

```json
{
  "$schema": "./schema.json",
  "name": "key-points",
  "label": "Key Points",
  "emoji": "🔑",
  "description": "Extract the key points discussed in the meeting as a concise bullet list.",
  "prompt": "... {title} ... {duration} ... {transcript} ...",
  "section_schema": { "...": "..." }
}
```

- `name` — kebab-case id (`^[a-z0-9-]+$`), must match the filename without extension.
- `label` — optional short (1-2 word) display label for compact UI tabs, e.g. `Notes`. Must be non-empty (after trimming) and at most 24 characters when present. Absent means the UI falls back to a title-cased `name`.
- `emoji` — optional single display emoji for compact UI tabs, e.g. `📝`. Must be non-empty and at most 2 Unicode scalar values when present (covers a plain emoji or a base character plus a variation selector, e.g. `⚖️`). Absent means the UI falls back to a generic emoji.
- `description` — human-readable summary of what the template produces. This stays the long explanatory text; it is not used for tab labels.
- `prompt` — the prompt sent to the model. May reference the placeholders `{title}`, `{duration}`, `{transcript}`, and `{language}`; `{transcript}` is required. Any other `{...}` token in the prompt is rejected at load time. `{language}` receives the requested output language's display label (e.g. `French`). If a template's prompt does not reference `{language}` at all, a directive sentence (`Write your entire response in <Label>.`) is appended automatically to the rendered prompt, so templates written before this placeholder existed still produce output in the requested language. The default language is English (`en`) when none is requested or the requested code is unrecognized.
- `section_schema` — optional JSON Schema describing the intended shape of the model's output. This is advisory only: it documents the expected structure for downstream tooling, but is **not enforced** on generated output. A local 3B-class model cannot reliably be constrained to emit conformant JSON without grammar-constrained decoding, which is out of scope for this phase.

## Built-ins

- `key-points.json` — bullet list of key points (`key_points: string[]`).
- `action-items.json` — action items with owner/due date (`action_items: [{ task, owner, due_date }]`).
- `decisions.json` — decisions made and their rationale (`decisions: [{ decision, rationale }]`).
- `meeting-notes.json` — full notes: `{ summary, discussion, decisions[] }`.

## Extending

Drop a new `*.json` file matching `schema.json` into this directory; it is picked up automatically by `myna-llm::template::list_templates` (sorted by `name`). `schema.json` itself is skipped by discovery. Files that fail to parse or fail validation are skipped individually rather than aborting discovery of the other templates.
