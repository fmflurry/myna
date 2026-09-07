import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  afterRenderEffect,
  computed,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

import { renderMarkdown } from './markdown-render.util';
import { clearHighlights, highlightMatches } from './summary-search.util';

/**
 * Streams the summary markdown; shows a cancel affordance while generating.
 *
 * Edit mode is emit-only: the panel owns the draft textarea (auto-sized to
 * fit its content, same technique as `EditableSegmentComponent`) and emits
 * `summaryEdited` with the trimmed markdown — persistence is wired by the
 * owning page, never from in here. A pure input/output component.
 *
 * Find-in-summary is panel-local: `searchOpen`/`searchQuery`/`activeMatch`
 * signals drive a `role=search` bar whose highlights are applied to the
 * rendered `.markdown` container via `summary-search.util` in an
 * `afterRenderEffect`. The detail pane forwards its toolbar magnifier into
 * the public `toggleSearch()` API; Cmd/Ctrl+F on `window` mirrors it.
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
  protected readonly renderedMarkdown = computed(() => renderMarkdown(this.markdown()));

  /** Find-in-summary state: open bar, literal query, zero-based active hit. */
  readonly searchOpen = signal(false);
  readonly searchQuery = signal('');
  readonly activeMatch = signal(0);
  protected readonly matchCount = signal(0);

  /** Readable summary on screen — the only state where find makes sense. */
  protected readonly canSearch = computed(
    () => this.markdown() !== '' && !this.generating() && !this.loading() && !this.editing(),
  );
  protected readonly matchLabel = computed(() => {
    const total = this.matchCount();
    if (total === 0) {
      return '0 of 0';
    }
    const active = Math.min(this.activeMatch(), total - 1);
    return `${active + 1} of ${total}`;
  });
  protected readonly noSearchMatch = computed(() => this.searchQuery() !== '' && this.matchCount() === 0);

  private readonly textArea = viewChild<ElementRef<HTMLTextAreaElement>>('summaryInput');
  private readonly markdownContainer = viewChild<ElementRef<HTMLElement>>('markdownContainer');
  private readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('searchInput');
  private searchInvoker: HTMLElement | null = null;
  private lastMarkdown = '';
  private searchWasOpen = false;

  constructor() {
    afterRenderEffect(() => {
      const el = this.textArea()?.nativeElement;
      if (this.editing() && el) {
        el.focus();
        this.autoSize();
      }
      this.applySearchHighlights();
    });
  }

  toggleSearch(): void {
    if (this.searchOpen()) {
      this.closeSearch();
    } else {
      this.openSearch();
    }
  }

  openSearch(): void {
    if (!this.canSearch() || this.searchOpen()) {
      return;
    }
    const active = document.activeElement;
    this.searchInvoker = active instanceof HTMLElement ? active : null;
    this.searchOpen.set(true);
  }

  closeSearch(): void {
    if (!this.searchOpen()) {
      return;
    }
    this.searchOpen.set(false);
    this.searchQuery.set('');
    this.activeMatch.set(0);
    const container = this.markdownContainer()?.nativeElement;
    if (container) {
      clearHighlights(container);
    }
    this.matchCount.set(0);
    const invoker = this.searchInvoker;
    this.searchInvoker = null;
    if (invoker && invoker.isConnected) {
      invoker.focus();
    }
  }

  beginEdit(): void {
    if (!this.editable() || this.editing()) {
      return;
    }
    this.closeSearch();
    this.draft.set(this.markdown());
    this.editing.set(true);
  }

  protected onInput(event: Event): void {
    this.draft.set((event.target as HTMLTextAreaElement).value);
    this.autoSize();
  }

  protected onSearchInput(event: Event): void {
    this.searchQuery.set((event.target as HTMLInputElement).value);
    this.activeMatch.set(0);
  }

  protected onSearchKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) {
        this.prevMatch();
      } else {
        this.nextMatch();
      }
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      // Caret has nowhere useful to go in a single-line search box while
      // matches exist; claim the keys for match stepping instead. With zero
      // matches stepping is a no-op, so leave the default caret move alone.
      if (this.matchCount() === 0) {
        return;
      }
      event.preventDefault();
      if (event.key === 'ArrowDown') {
        this.nextMatch();
      } else {
        this.prevMatch();
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.closeSearch();
    }
  }

  protected nextMatch(): void {
    const total = this.matchCount();
    if (total === 0) {
      return;
    }
    this.activeMatch.set((this.activeMatch() + 1) % total);
    this.refocusSearchInput();
  }

  protected prevMatch(): void {
    const total = this.matchCount();
    if (total === 0) {
      return;
    }
    this.activeMatch.set((this.activeMatch() - 1 + total) % total);
    this.refocusSearchInput();
  }

  /**
   * Stepping via the Prev/Next buttons moves focus to the clicked button, and
   * the highlight re-render can drop it — either strands keyboard nav (Enter /
   * arrows only fire from the input). Hand focus back so repeated Enter and
   * arrow steps keep working. No-op while the bar is closed.
   */
  private refocusSearchInput(): void {
    if (!this.searchOpen()) {
      return;
    }
    this.searchInput()?.nativeElement.focus();
  }

  @HostListener('window:keydown', ['$event'])
  protected onWindowKeydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
      if (!this.canSearch()) {
        return;
      }
      event.preventDefault();
      this.toggleSearch();
      return;
    }
    if (event.key === 'Escape' && this.searchOpen()) {
      event.preventDefault();
      this.closeSearch();
    }
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

  /**
   * Re-applies literal-query highlights to the rendered markdown container.
   * Runs in `afterRenderEffect` so `[innerHTML]` is already painted; the
   * active hit gets `.current` (alongside the util's `aria-current`) and is
   * scrolled into view in both directions via `scrollActiveMarkIntoView`. A
   * changed `markdown` resets the query — the query is never persisted
   * across summaries.
   */
  private applySearchHighlights(): void {
    const currentMarkdown = this.markdown();
    if (currentMarkdown !== this.lastMarkdown) {
      this.lastMarkdown = currentMarkdown;
      this.searchQuery.set('');
      this.activeMatch.set(0);
      this.matchCount.set(0);
    }
    const container = this.markdownContainer()?.nativeElement;
    if (!container) {
      return;
    }
    const open = this.searchOpen();
    if (open && !this.searchWasOpen) {
      this.searchWasOpen = true;
      this.searchInput()?.nativeElement.focus();
    } else if (!open && this.searchWasOpen) {
      this.searchWasOpen = false;
    }
    const query = this.searchQuery();
    if (!open || !this.canSearch() || query === '') {
      clearHighlights(container);
      if (this.matchCount() !== 0) {
        this.matchCount.set(0);
      }
      return;
    }
    const total = highlightMatches(container, query, this.activeMatch());
    if (total !== this.matchCount()) {
      this.matchCount.set(total);
    }
    if (total === 0) {
      return;
    }
    if (this.activeMatch() >= total) {
      this.activeMatch.set(0);
      return;
    }
    const marks = container.querySelectorAll('mark[data-search-mark]');
    marks.forEach((mark) => mark.classList.remove('current'));
    const current = marks[this.activeMatch()];
    if (current === undefined) {
      return;
    }
    current.classList.add('current');
    this.scrollActiveMarkIntoView(current, total);
  }

  /**
   * Keeps the active hit visible while cycling with Enter/arrows, in both
   * directions (down AND back up on wrap). `block: 'center'` — not
   * `'nearest'` — forces a scroll even when the browser still considers the
   * mark "visible" inside a nested overflow container: `'nearest'` no-ops
   * there, which stranded the viewport at the bottom while the active hit
   * moved above it. `scrollIntoView` propagates through every scrollable
   * ancestor, so this works whether the page or an inner pane scrolls, and
   * it runs here — after the highlight DOM update — so the mark exists.
   * Skipped for a lone match so typing the query never yanks the viewport;
   * guarded for jsdom (no `scrollIntoView`, no layout).
   */
  private scrollActiveMarkIntoView(current: Element, total: number): void {
    if (total <= 1) {
      return;
    }
    if (typeof current.scrollIntoView !== 'function') {
      return;
    }
    current.scrollIntoView({ block: 'center', inline: 'nearest' });
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
