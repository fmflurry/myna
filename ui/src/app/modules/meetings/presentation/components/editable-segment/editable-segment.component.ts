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
 * A transcript segment that reads as plain text until activated (click, or
 * keyboard focus + Enter), at which point it becomes a textarea. Enter
 * commits (and never inserts a newline), Escape cancels and restores the
 * original text, and blur commits — the same convention as `EditableTitle`.
 *
 * Injects nothing: a pure input/output component. The owning page wires
 * `textChanged` to `MeetingsFacade.editTranscriptSegment`.
 */
@Component({
  selector: 'app-editable-segment',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './editable-segment.component.html',
  styleUrl: './editable-segment.component.scss',
})
export class EditableSegmentComponent {
  readonly text = input.required<string>();
  readonly editable = input(true);

  readonly textChanged = output<string>();

  protected readonly editing = signal(false);
  protected readonly draft = signal('');

  private readonly textArea = viewChild<ElementRef<HTMLTextAreaElement>>('segmentInput');

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
    if (!this.editable()) {
      return;
    }
    this.draft.set(this.text());
    this.editing.set(true);
  }

  protected onInput(event: Event): void {
    this.draft.set((event.target as HTMLTextAreaElement).value);
    this.autoSize();
  }

  /**
   * Grows the textarea to fit its entire content so the whole segment stays
   * visible while editing, at the same typography as the non-editing section
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
    if (event.key === 'Enter') {
      event.preventDefault();
      this.commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.cancel();
    }
  }

  /**
   * Commits the draft as the new text. A no-op when already committed or
   * cancelled (guards against the native blur that removing the focused
   * textarea from the DOM can trigger right after `cancel()`), when the
   * trimmed draft is empty, or when it's unchanged from the current text —
   * none of those are worth a round-trip to the backend.
   */
  protected commit(): void {
    if (!this.editing()) {
      return;
    }
    const trimmed = this.draft().trim();
    this.editing.set(false);
    if (trimmed.length === 0 || trimmed === this.text()) {
      return;
    }
    this.textChanged.emit(trimmed);
  }

  protected cancel(): void {
    this.editing.set(false);
  }
}
