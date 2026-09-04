import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

import { DEFAULT_SUMMARY_INSTRUCTIONS_DRAFT } from '../../../application/stores/summary-instructions-preferences.util';
import type { SummaryInstructionsDraft } from '../../../core/models/summary-instructions.model';

/** A draft with nothing the user has actually written: empty focus text, general guidelines still included. */
const isDefaultDraft = (draft: SummaryInstructionsDraft): boolean => draft.text === '' && draft.includeGeneral;

/**
 * Per-request summary-instructions editor, rendered above Generate on every
 * summary tab. Dumb by contract: it receives the active (meeting, template)
 * draft plus a single-line general-guidelines preview and emits the next
 * draft — persistence and generation capture live behind the shell/facade.
 * Collapsed by default while the draft is still the default one, expanded
 * whenever a real draft exists; a local edit is bound to the draft object it
 * started from, so switching tabs/meetings can never show stale text. The
 * guidelines hint renders only when the checkbox is on AND the preview is
 * non-empty — never placeholder content.
 */
@Component({
  selector: 'app-summary-instructions-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './summary-instructions-editor.component.html',
  styleUrl: './summary-instructions-editor.component.scss',
})
export class SummaryInstructionsEditorComponent {
  /** The stored (meeting, template) draft; a new object identity means another draft was loaded. */
  readonly draft = input.required<SummaryInstructionsDraft>();
  /** Whitespace-collapsed, truncated preview of the general guidelines; `''` when there are none. */
  readonly guidelinesPreview = input('');
  /**
   * When true, the editor stays expanded regardless of draft default-ness —
   * the detail pane's regenerate confirm strip sets this while armed so the
   * instructions surface before every re-run.
   */
  readonly forceExpanded = input(false);

  /** The next draft to persist for this (meeting, template); emitted on blur and on checkbox change. */
  readonly draftChanged = output<SummaryInstructionsDraft>();

  /** Uncommitted textarea value, valid only while its source is the current `draft` input. */
  private readonly textEdit = signal<{ readonly source: SummaryInstructionsDraft; readonly value: string } | null>(null);
  /** Manual expand/collapse, valid only for the draft it was made against; any other draft follows its default-ness. */
  private readonly expandedEdit = signal<{ readonly source: SummaryInstructionsDraft; readonly value: boolean } | null>(null);

  protected readonly text = computed(() => {
    const draft = this.draft();
    const edit = this.textEdit();
    return edit !== null && edit.source === draft ? edit.value : draft.text;
  });

  protected readonly expanded = computed(() => {
    if (this.forceExpanded()) {
      return true;
    }
    const draft = this.draft();
    const edit = this.expandedEdit();
    return edit !== null && edit.source === draft ? edit.value : !isDefaultDraft(draft);
  });

  protected readonly showGuidelinesHint = computed(
    () => this.draft().includeGeneral && this.guidelinesPreview() !== '',
  );

  /** Visible only when the stored draft is non-default; Remove resets to the default via `draftChanged`. */
  protected readonly showRemove = computed(() => !isDefaultDraft(this.draft()));

  toggleExpanded(): void {
    this.expandedEdit.set({ source: this.draft(), value: !this.expanded() });
  }

  onTextInput(event: Event): void {
    this.textEdit.set({ source: this.draft(), value: (event.target as HTMLTextAreaElement).value });
  }

  /** Blur commits so clicking Generate (or tabbing away) never loses the typed focus text. */
  onTextBlur(): void {
    const draft = this.draft();
    const text = this.text().trim();
    if (text !== draft.text) {
      this.draftChanged.emit({ text, includeGeneral: draft.includeGeneral });
    }
  }

  onIncludeGeneralToggled(event: Event): void {
    this.draftChanged.emit({
      text: this.text().trim(),
      includeGeneral: (event.target as HTMLInputElement).checked,
    });
  }

  /** Resets to the default draft via the existing `draftChanged` output — no new shell wiring. */
  clearInstructions(): void {
    this.draftChanged.emit({ ...DEFAULT_SUMMARY_INSTRUCTIONS_DRAFT });
  }
}
