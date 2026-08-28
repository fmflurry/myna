import {
  ChangeDetectionStrategy,
  Component,
  type ElementRef,
  computed,
  effect,
  input,
  output,
  signal,
  viewChildren,
} from '@angular/core';

/** A single selectable entry in the searchable combobox list. */
export interface SearchableSelectOption {
  readonly id: string;
  readonly name: string;
}

let nextInstanceId = 0;

/**
 * Generic, presentational searchable combobox. Type to filter a flat list of
 * `{ id, name }` options, navigate with the keyboard, and emit the chosen id.
 * Replaces a plain `<select>` for lists long enough that scanning them
 * without search (e.g. ~50 running applications) is impractical.
 *
 * Pure UI: no facade, no service, no injected dependency of any kind. The
 * owning component wires `selectionChange` to whatever store/facade method
 * applies (e.g. `MeetingsFacade.selectAudioSource`).
 */
@Component({
  selector: 'app-searchable-select',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './searchable-select.component.html',
  styleUrl: './searchable-select.component.scss',
  host: {
    // Internal clicks never reach `document`, so the document listener
    // below only fires for genuine "clicked outside" interactions.
    '(click)': '$event.stopPropagation()',
    '(document:click)': 'close()',
  },
})
export class SearchableSelectComponent {
  readonly options = input<readonly SearchableSelectOption[]>([]);
  readonly selectedId = input<string>('');
  readonly placeholder = input('Search…');
  readonly ariaLabel = input<string>('');
  readonly disabled = input(false);

  readonly selectionChange = output<string>();

  protected readonly instanceId = `searchable-select-${nextInstanceId++}`;
  protected readonly listboxId = `${this.instanceId}-listbox`;

  protected readonly expanded = signal(false);
  protected readonly filterText = signal('');
  protected readonly activeIndex = signal(0);

  private readonly optionElements = viewChildren<ElementRef<HTMLElement>>('optionEl');

  protected readonly filteredOptions = computed<readonly SearchableSelectOption[]>(() => {
    const query = this.filterText().trim().toLowerCase();
    const all = this.options();
    if (!query) {
      return all;
    }
    return all.filter((option) => option.name.toLowerCase().includes(query));
  });

  protected readonly selectedOption = computed<SearchableSelectOption | null>(
    () => this.options().find((option) => option.id === this.selectedId()) ?? null,
  );

  protected readonly displayValue = computed(() =>
    this.expanded() ? this.filterText() : (this.selectedOption()?.name ?? ''),
  );

  protected readonly activeOptionDomId = computed<string | null>(() => {
    if (!this.expanded()) {
      return null;
    }
    const option = this.filteredOptions()[this.activeIndex()];
    return option ? this.optionDomId(option.id) : null;
  });

  protected readonly accessibleName = computed(() => this.ariaLabel() || this.placeholder());

  constructor() {
    // Keep the keyboard-active option in view as the user arrows through a
    // list taller than the capped popup (see `--select-popup-max-height`).
    effect(() => {
      if (!this.expanded()) {
        return;
      }
      const index = this.activeIndex();
      const elements = this.optionElements();
      elements[index]?.nativeElement.scrollIntoView?.({ block: 'nearest' });
    });
  }

  protected optionDomId(id: string): string {
    return `${this.instanceId}-option-${id}`;
  }

  protected open(): void {
    if (this.disabled() || this.expanded()) {
      return;
    }
    this.filterText.set('');
    this.activeIndex.set(this.currentSelectionIndex());
    this.expanded.set(true);
  }

  protected close(): void {
    this.expanded.set(false);
  }

  protected onFocus(): void {
    this.open();
  }

  protected onInput(event: Event): void {
    this.filterText.set((event.target as HTMLInputElement).value);
    this.activeIndex.set(0);
    if (!this.expanded()) {
      this.expanded.set(true);
    }
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (this.disabled()) {
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.open();
        this.moveActive(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.open();
        this.moveActive(-1);
        break;
      case 'Home':
        if (this.expanded()) {
          event.preventDefault();
          this.activeIndex.set(0);
        }
        break;
      case 'End':
        if (this.expanded()) {
          event.preventDefault();
          this.activeIndex.set(Math.max(this.filteredOptions().length - 1, 0));
        }
        break;
      case 'Enter':
        if (this.expanded()) {
          event.preventDefault();
          this.selectActive();
        }
        break;
      case 'Escape':
        if (this.expanded()) {
          event.preventDefault();
          this.close();
        }
        break;
      default:
        break;
    }
  }

  protected onOptionMouseDown(event: Event, id: string): void {
    // Prevent the input from blurring before the click is processed.
    event.preventDefault();
    this.selectionChange.emit(id);
    this.close();
  }

  protected onOptionMouseEnter(index: number): void {
    this.activeIndex.set(index);
  }

  private selectActive(): void {
    const option = this.filteredOptions()[this.activeIndex()];
    if (!option) {
      return;
    }
    this.selectionChange.emit(option.id);
    this.close();
  }

  private moveActive(delta: number): void {
    const count = this.filteredOptions().length;
    if (count === 0) {
      this.activeIndex.set(0);
      return;
    }
    this.activeIndex.update((current) => {
      const next = current + delta;
      if (next < 0) {
        return 0;
      }
      if (next >= count) {
        return count - 1;
      }
      return next;
    });
  }

  private currentSelectionIndex(): number {
    const id = this.selectedId();
    const index = this.options().findIndex((option) => option.id === id);
    return index >= 0 ? index : 0;
  }
}
