import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

/**
 * Streams the summary markdown; shows a cancel affordance while generating.
 *
 * Edit mode is emit-only: the panel owns the draft textarea (auto-sized to
 * fit its content, same technique as `EditableSegmentComponent`) and emits
 * `summaryEdited` with the trimmed markdown — persistence is wired by the
 * owning page, never from in here. A pure input/output component.
 */
@Component({
  selector: 'app-summary-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './summary-panel.component.html',
  styleUrl: './summary-panel.component.scss',
})
export class SummaryPanelComponent {
  readonly markdown = input.required<string>();
  readonly generating = input(false);
  /** True while a persisted summary's content is being fetched via `get_summary` — distinct from `generating`. */
  readonly loading = input(false);
  /** True when the displayed summary was generated from a PREVIOUS transcript — the meeting has since been re-transcribed. Never hides the summary; it stays readable alongside the banner. */
  readonly stale = input(false);
  /** Whether the summary can be edited. The parent clears it while generating/loading; the panel never edits a summary it isn't showing. */
  readonly editable = input(false);

  readonly cancelClicked = output<void>();
  /** Emits the trimmed edited markdown — only when it actually differs from the current markdown. */
  readonly summaryEdited = output<string>();

  protected readonly editing = signal(false);
  protected readonly draft = signal('');

  private readonly textArea = viewChild<ElementRef<HTMLTextAreaElement>>('summaryInput');

  constructor() {
    afterRenderEffect(() => {
      const el = this.textArea()?.nativeElement;
      if (this.editing() && el) {
        el.focus();
        this.autoSize();
      }
    });
  }

  protected beginEdit(): void {
    if (!this.editable() || this.editing()) {
      return;
    }
    this.draft.set(this.markdown());
    this.editing.set(true);
  }

  protected onInput(event: Event): void {
    this.draft.set((event.target as HTMLTextAreaElement).value);
    this.autoSize();
  }

  /**
   * Grows the textarea to fit its entire content so the whole summary stays
   * visible while editing, at the same typography as the read-only `<pre>`
   * (font, line-height and color are inherited via CSS). Runs when editing
   * begins (via `afterRenderEffect`, once the textarea is in the DOM) and on
   * every input.
   */
  private autoSize(): void {
    const el = this.textArea()?.nativeElement;
    if (!el) {
      return;
    }
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.cancel();
    }
  }

  /**
   * Commits the draft as the edited markdown. Always leaves edit mode; emits
   * `summaryEdited` only when the trimmed draft differs from the current
   * markdown — an unchanged commit is not worth a round-trip to the backend.
   */
  protected commit(): void {
    if (!this.editing()) {
      return;
    }
    const trimmed = this.draft().trim();
    this.editing.set(false);
    if (trimmed === this.markdown()) {
      return;
    }
    this.summaryEdited.emit(trimmed);
  }

  protected cancel(): void {
    this.editing.set(false);
  }
}
