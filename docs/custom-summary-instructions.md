# Custom Summary Instructions

Myna lets you steer summaries with your own written guidance — no template
editing required. Two mechanisms work together:

- **General guidelines** — standing instructions you set once in Settings,
  applied to every summary by default.
- **Per-request instructions** — one-off guidance for a single summary,
  written right where you generate it.

Everything stays on your machine: instructions are stored locally and reach
only the on-device model.

## General Guidelines

Open **Settings** and type into the **General summary guidelines** textarea.
These guidelines apply to all summary generations by default.

- **Storage:** `<data_root>/preferences.json` under the `"summary"` key. The
  file is written with mode `0600`; other keys in it are preserved.
- **Data root:** `~/myna` (override with `MYNA_DATA_DIR`).
- **Limit:** 4000 Unicode scalars.

## Per-Request Instructions

Each summary tab — Notes, Key Points, Decisions, Action Items, and your
custom templates — shows an **Add instructions for this summary** editor
above the Generate button. It contains:

- A textarea for instructions specific to this summary.
- An **Apply general guidelines** checkbox (see below).

Drafts persist per meeting and template in the webview's PreferencesPort
(localStorage key
`meetings.summaryInstructions.{meetingId}.{template}`), so they survive a
webview reload.

## Combining or Ignoring General Guidelines

The **Apply general guidelines** checkbox controls how the two sets of text
are used for that request:

- **Checked (default):** general and specific instructions are combined.
- **Unchecked:** general guidelines are ignored for that request.

Where the two conflict, the specific instructions take precedence — the
prompt states this explicitly, so you don't have to repeat it.

## How Instructions Reach the Model

Your text is prepended to the rendered template prompt by
`SummaryInstructions::compose()` in `myna-llm`:

```text
General guidelines for this summary:
<general>

Instructions for this specific request (they take precedence over
the general guidelines above where they conflict):
<specific>

---

<rendered template prompt — trailing generation cue stays last>
```

Details worth knowing:

- Empty or whitespace-only parts are omitted. If both parts are empty, the
  prompt is identical to pre-feature behavior.
- Instruction text is literal: `{...}` placeholders inside your instructions
  are **not** substituted.
- Instructions count toward the map-reduce chunk token budget, so a long
  transcript may split into more chunks.

## Writing Effective Instructions

The bundled Qwen2.5-7B model follows short, imperative guidance best — for
example: "Use bullet points. Group by topic. Never invent owners." Vague or
very long prose may be blended imperfectly into the output.

## Backward Compatibility

Existing meetings, templates, and preferences files work unchanged. Omitting
instructions yields the old prompt byte-for-byte.

## Developer Notes: IPC Surface

- `summarize_meeting` gained an optional `instructions` parameter:
  `{ specific?, includeGeneral }`.
- New commands: `get_summary_guidelines` and `set_summary_guidelines`.

**Platform scope:** like the rest of Myna, this feature is developed and
tested on macOS first.

## Next Steps

- See the [Usage Guide](usage.md) for the full summarization walkthrough.
- See [templates/README.md](../templates/README.md) for the template prompt
  format your instructions are combined with.
