# Custom Template Prompts

Myna lets you rewrite the prompt behind any summary type — Notes, Key
Points, Decisions, Action Items, or your own custom templates — without
editing files or recompiling. The override replaces the built-in
template's `prompt` text at render time.

This is separate from [Custom Summary Instructions](custom-summary-instructions.md):
instructions are prepended per request; a template prompt override
replaces the template body itself for every future summary of that type.

Everything stays on your machine: overrides are stored locally and reach
only the on-device model.

## Editing an Override

Each summary tab has a cogwheel button next to the instructions editor.
It opens a dialog showing the template's current effective prompt
(override when one exists, otherwise the built-in file text). Save to
store your version; Reset clears the override back to the built-in.

- **Scope:** global per template type, not per meeting. Setting an
  override for `key-points` changes every meeting's Key Points tab.
- **Effect:** future summaries only. Summaries already generated are
  never rewritten.
- **Empty input clears:** saving empty or whitespace-only text removes
  the override (same as Reset).

## Where Overrides Live

- **Storage:** `<data_root>/preferences.json` under the
  `"template_prompts"` key, as `{ "prompts": { "<name>": "<prompt>" } }`.
  The file is written with mode `0600`; unrelated top-level keys
  (e.g. `"summary"`, `"updates"`) are preserved on save.
- **Data root:** `~/myna` (override with `MYNA_DATA_DIR`).
- **Limit:** 12000 Unicode scalars per override. Input is trimmed and
  cut at a `char` boundary, so the result is always valid UTF-8 and the
  cap means the same thing for ASCII and non-ASCII text.
- **Reads never fail:** a missing, corrupt, or unreadable
  `preferences.json` yields no overrides — the app falls back to the
  built-in prompts.

## Placeholders and Validation

Overrides support the same four placeholders as template files
(see [templates/README.md](../templates/README.md)):

- `{title}` — meeting title.
- `{duration}` — human-readable duration.
- `{transcript}` — the meeting transcript. **Required.**
- `{language}` — requested output language's display label
  (e.g. `French`).

Validation mirrors template-file rules (`crates/myna-llm/src/template.rs`):

- Prompt must be non-empty (after trimming).
- Prompt must contain `{transcript}`.
- No unknown `{...}` tokens — anything outside the four placeholders
  above is rejected.
- `{language}` backward compatibility: if your override omits
  `{language}`, a directive sentence
  (`Write your entire response in <Label>.`) is appended automatically
  at render time, so older prompts still produce output in the requested
  language. Include `{language}` explicitly to control placement
  yourself.

Template names are restricted to `^[a-z0-9-]+$` (lowercase, digits,
dashes). Invalid keys are dropped on load and never written to disk.

## Custom Templates Interplay

Custom `*.json` files dropped into `templates/` keep working with no
recompile — overrides compose with them:

- **Override wins** when both a custom file and a stored override exist
  for the same name. The override text is rendered; the file's `prompt`
  is ignored.
- **Deleting the file hides the tab**, even if an override for that name
  is still stored. Tabs are driven by discovered files; the orphaned
  override is inert until a file with that name returns.
- Reset (or saving empty text) restores the file's prompt as the
  effective prompt.

## Developer Notes: IPC Surface

- New commands: `get_template_prompt`, `set_template_prompt`,
  `reset_template_prompt` (key: `template_prompts`, cap 12000).
- `load_template` applies the stored override to the returned prompt
  when one exists.

**Platform scope:** like the rest of Myna, this feature is developed and
tested on macOS first.

## Next Steps

- See the [Usage Guide](usage.md) for the full summarization walkthrough.
- See [Custom Summary Instructions](custom-summary-instructions.md) for
  per-request steering that combines with these overrides.
- See [templates/README.md](../templates/README.md) for the template
  file format overrides replace at render time.
