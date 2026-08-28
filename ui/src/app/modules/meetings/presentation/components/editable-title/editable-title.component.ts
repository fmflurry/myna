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
 * A title that reads as plain text until activated (click, or keyboard
 * focus + Enter), at which point it becomes a text input. Enter commits,
 * Escape cancels and restores the original text, and blur commits — the
 * same convention as most inline-rename UIs.
 *
 * Injects nothing: a pure input/output component. The owning page wires
 * `titleChanged` to `MeetingsFacade.renameMeeting`.
 */
@Component({
  selector: 'app-editable-title',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './editable-title.component.html',
  styleUrl: './editable-title.component.scss',
})
export class EditableTitleComponent {
  readonly title = input.required<string>();

  readonly titleChanged = output<string>();

  protected readonly editing = signal(false);
  protected readonly draft = signal('');

  private readonly titleInput = viewChild<ElementRef<HTMLInputElement>>('titleInput');

  constructor() {
    afterRenderEffect(() => {
      if (this.editing()) {
        this.titleInput()?.nativeElement.focus();
      }
    });
  }

  protected beginEdit(): void {
    this.draft.set(this.title());
    this.editing.set(true);
  }

  protected onInput(event: Event): void {
    this.draft.set((event.target as HTMLInputElement).value);
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
   * Commits the draft as the new title. A no-op when already committed or
   * cancelled (guards against the native blur that removing the focused
   * input from the DOM can trigger right after `cancel()`), when the
   * trimmed draft is empty, or when it's unchanged from the current title —
   * none of those are worth a round-trip to the backend.
   */
  protected commit(): void {
    if (!this.editing()) {
      return;
    }
    const trimmed = this.draft().trim();
    this.editing.set(false);
    if (trimmed.length === 0 || trimmed === this.title()) {
      return;
    }
    this.titleChanged.emit(trimmed);
  }

  protected cancel(): void {
    this.editing.set(false);
  }
}
