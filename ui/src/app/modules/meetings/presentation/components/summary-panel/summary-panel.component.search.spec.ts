import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { vi } from 'vitest';

import {
  installTauriInternalsStub,
  uninstallTauriInternalsStub,
} from '../../../infrastructure/tauri/testing/tauri-internals.stub';
import { SummaryPanelComponent } from './summary-panel.component';

/**
 * Find-in-summary wiring for the read-only summary viewer.
 *
 * The panel owns the `searchOpen`/`searchQuery`/`activeMatch` signals; the
 * detail pane's toolbar magnifier forwards into the public `toggleSearch()`
 * API (covered in `meeting-detail-pane.component.summary-edit.spec.ts`) and
 * Cmd/Ctrl+F on `window` mirrors it. Highlights are applied to the rendered
 * `.markdown` container via `summary-search.util` in an `afterRenderEffect`,
 * so every interaction below needs a real change-detection pass — `TestBed`
 * plus `vi.useFakeTimers()` only (no `fakeAsync`, no `vi.mock` hoisting).
 * jsdom has no layout, so scrolling is asserted via a `scrollIntoView` spy
 * (the receiver must be the `.current` mark) — never via pixel positions.
 */
describe('SummaryPanelComponent — find in summary', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // The panel itself never touches Tauri; the stub only seals the boundary
    // so a future import cannot reach a live runtime from these specs.
    installTauriInternalsStub(() => {
      throw new Error('unexpected Tauri invoke in summary search spec');
    });
  });

  afterEach(() => {
    uninstallTauriInternalsStub();
    vi.useRealTimers();
  });

  type SearchFixture = ComponentFixture<SummaryPanelComponent>;

  /** Macrotask hop that drains the highlight `afterRenderEffect` on the fake clock. */
  const flush = (): Promise<void> => vi.advanceTimersByTimeAsync(0).then(() => undefined);

  /** Renders a readable summary and flushes the highlight effect. */
  const renderSearchable = async (
    markdown = 'alpha beta alpha. Gamma has Alpha too.',
  ): Promise<SearchFixture> => {
    const fixture = TestBed.createComponent(SummaryPanelComponent);
    fixture.componentRef.setInput('markdown', markdown);
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
    return fixture;
  };

  /** Opens the bar through the public API and flushes focus + highlights. */
  const openBar = async (fixture: SearchFixture): Promise<void> => {
    fixture.componentInstance.openSearch();
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
  };

  /** Types into the search input and flushes the highlight effect. */
  const typeQuery = async (fixture: SearchFixture, query: string): Promise<HTMLInputElement> => {
    const input = fixture.nativeElement.querySelector('.search-input') as HTMLInputElement;
    input.value = query;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
    return input;
  };

  const markList = (fixture: SearchFixture): Element[] =>
    Array.from(fixture.nativeElement.querySelectorAll('mark[data-search-mark]'));

  const countText = (fixture: SearchFixture): string =>
    (fixture.nativeElement.querySelector('.search-count')?.textContent ?? '').trim();

  /** Index of the `.current` mark among all search marks, or -1. */
  const currentIndex = (fixture: SearchFixture): number =>
    markList(fixture).findIndex((mark) => mark.classList.contains('current'));

  const pressKey = async (fixture: SearchFixture, target: EventTarget, init: KeyboardEventInit): Promise<void> => {
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
  };

  it('opens on Cmd+F (macOS) and prevents the browser find', async () => {
    const fixture = await renderSearchable();

    const event = new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();

    expect(event.defaultPrevented).toBe(true);
    expect(fixture.componentInstance.searchOpen()).toBe(true);
    expect(fixture.nativeElement.querySelector('.search-bar')).toBeTruthy();
  });

  it('opens on Ctrl+F (other platforms) and prevents the browser find', async () => {
    const fixture = await renderSearchable();

    const event = new KeyboardEvent('keydown', { key: 'F', ctrlKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();

    expect(event.defaultPrevented).toBe(true);
    expect(fixture.componentInstance.searchOpen()).toBe(true);
    expect(fixture.nativeElement.querySelector('.search-bar')).toBeTruthy();
  });

  it('ignores Cmd+F when there is nothing readable to search', async () => {
    const fixture = TestBed.createComponent(SummaryPanelComponent);
    fixture.componentRef.setInput('markdown', '# Points');
    fixture.componentRef.setInput('generating', true);
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();

    const event = new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();

    expect(event.defaultPrevented).toBe(false);
    expect(fixture.componentInstance.searchOpen()).toBe(false);
    expect(fixture.nativeElement.querySelector('.search-bar')).toBeNull();
  });

  it('openSearch() is a no-op without readable content', async () => {
    const fixture = TestBed.createComponent(SummaryPanelComponent);
    fixture.componentRef.setInput('markdown', '');
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();

    fixture.componentInstance.openSearch();
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();

    expect(fixture.componentInstance.searchOpen()).toBe(false);
    expect(fixture.nativeElement.querySelector('.search-bar')).toBeNull();
  });

  it('typing highlights every literal hit, counts 1 of N, and marks the active hit current', async () => {
    const fixture = await renderSearchable();
    await openBar(fixture);

    await typeQuery(fixture, 'alpha');

    const marks = markList(fixture);
    expect(marks.length).toBe(3);
    expect(countText(fixture)).toBe('1 of 3');
    expect(currentIndex(fixture)).toBe(0);
    expect(marks[0]?.classList.contains('current')).toBe(true);
    expect(marks[0]?.getAttribute('aria-current')).toBe('true');
    expect(marks[1]?.getAttribute('aria-current')).toBeNull();
    expect(marks[2]?.getAttribute('aria-current')).toBeNull();
  });

  it('Next/Enter advance, Prev/Shift+Enter go back, wrapping at the ends', async () => {
    const fixture = await renderSearchable();
    await openBar(fixture);
    const input = await typeQuery(fixture, 'alpha');
    expect(countText(fixture)).toBe('1 of 3');

    (fixture.nativeElement.querySelector('.search-next') as HTMLButtonElement).click();
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
    expect(countText(fixture)).toBe('2 of 3');
    expect(currentIndex(fixture)).toBe(1);

    await pressKey(fixture, input, { key: 'Enter' });
    expect(countText(fixture)).toBe('3 of 3');
    expect(currentIndex(fixture)).toBe(2);

    await pressKey(fixture, input, { key: 'Enter' });
    expect(countText(fixture)).toBe('1 of 3');
    expect(currentIndex(fixture)).toBe(0);

    await pressKey(fixture, input, { key: 'Enter', shiftKey: true });
    expect(countText(fixture)).toBe('3 of 3');
    expect(currentIndex(fixture)).toBe(2);

    (fixture.nativeElement.querySelector('.search-prev') as HTMLButtonElement).click();
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
    expect(countText(fixture)).toBe('2 of 3');
    expect(currentIndex(fixture)).toBe(1);
  });

  it('ArrowDown/ArrowUp cycle matches, keep focus, and no-op without matches', async () => {
    const fixture = await renderSearchable();
    document.body.appendChild(fixture.nativeElement);
    try {
      await openBar(fixture);
      const input = await typeQuery(fixture, 'alpha');
      expect(countText(fixture)).toBe('1 of 3');
      expect(document.activeElement).toBe(input);

      const sendKey = async (init: KeyboardEventInit): Promise<KeyboardEvent> => {
        const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
        input.dispatchEvent(event);
        fixture.detectChanges();
        await flush();
        fixture.detectChanges();
        return event;
      };
      const down = await sendKey({ key: 'ArrowDown' });
      expect(down.defaultPrevented).toBe(true);
      expect(countText(fixture)).toBe('2 of 3');
      expect(currentIndex(fixture)).toBe(1);
      expect(document.activeElement).toBe(input);
      await sendKey({ key: 'ArrowDown' });
      expect(countText(fixture)).toBe('3 of 3');
      expect(currentIndex(fixture)).toBe(2);
      await sendKey({ key: 'ArrowDown' });
      expect(countText(fixture)).toBe('1 of 3');
      expect(currentIndex(fixture)).toBe(0);
      const up = await sendKey({ key: 'ArrowUp' });
      expect(up.defaultPrevented).toBe(true);
      expect(countText(fixture)).toBe('3 of 3');
      expect(currentIndex(fixture)).toBe(2);
      expect(document.activeElement).toBe(input);
      const enter = await sendKey({ key: 'Enter' });
      expect(enter.defaultPrevented).toBe(true);
      expect(countText(fixture)).toBe('1 of 3');
      const shiftEnter = await sendKey({ key: 'Enter', shiftKey: true });
      expect(shiftEnter.defaultPrevented).toBe(true);
      expect(countText(fixture)).toBe('3 of 3');
      (fixture.nativeElement.querySelector('.search-next') as HTMLButtonElement).click();
      fixture.detectChanges();
      await flush();
      fixture.detectChanges();
      expect(countText(fixture)).toBe('1 of 3');
      expect(document.activeElement).toBe(input);
      input.value = '';
      input.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      await flush();
      fixture.detectChanges();
      expect(countText(fixture)).toBe('0 of 0');
      const idle = await sendKey({ key: 'ArrowDown' });
      expect(idle.defaultPrevented).toBe(false);
      expect(countText(fixture)).toBe('0 of 0');
      expect(markList(fixture).length).toBe(0);
    } finally {
      fixture.nativeElement.remove();
    }
  });

  it('Escape in the input closes, clears highlights, and returns focus to the invoker', async () => {
    const fixture = await renderSearchable();
    document.body.appendChild(fixture.nativeElement);
    const invoker = document.createElement('button');
    invoker.textContent = 'Invoker';
    document.body.appendChild(invoker);
    try {
      invoker.focus();
      expect(document.activeElement).toBe(invoker);

      fixture.componentInstance.openSearch();
      fixture.detectChanges();
      await flush();
      fixture.detectChanges();

      const input = await typeQuery(fixture, 'alpha');
      expect(markList(fixture).length).toBe(3);
      expect(document.activeElement).toBe(input);

      await pressKey(fixture, input, { key: 'Escape' });

      expect(fixture.componentInstance.searchOpen()).toBe(false);
      expect(fixture.nativeElement.querySelector('.search-bar')).toBeNull();
      expect(markList(fixture).length).toBe(0);
      expect(document.activeElement).toBe(invoker);
    } finally {
      invoker.remove();
      fixture.nativeElement.remove();
    }
  });

  it('window Escape also closes the bar and clears highlights', async () => {
    const fixture = await renderSearchable();
    await openBar(fixture);
    await typeQuery(fixture, 'alpha');
    expect(markList(fixture).length).toBe(3);

    await pressKey(fixture, window, { key: 'Escape' });

    expect(fixture.componentInstance.searchOpen()).toBe(false);
    expect(fixture.nativeElement.querySelector('.search-bar')).toBeNull();
    expect(markList(fixture).length).toBe(0);
  });

  it('empty query shows 0 of 0 with no hint and a valid input', async () => {
    const fixture = await renderSearchable();
    await openBar(fixture);

    expect(countText(fixture)).toBe('0 of 0');
    expect(fixture.nativeElement.querySelector('.search-hint')).toBeNull();
    expect(fixture.nativeElement.querySelector('.search-input')?.getAttribute('aria-invalid')).toBe('false');
    expect((fixture.nativeElement.querySelector('.search-prev') as HTMLButtonElement).disabled).toBe(true);
    expect((fixture.nativeElement.querySelector('.search-next') as HTMLButtonElement).disabled).toBe(true);
    expect(markList(fixture).length).toBe(0);
  });

  it('no-result query shows 0 of 0 plus a hint and aria-invalid, disabling stepping', async () => {
    const fixture = await renderSearchable();
    await openBar(fixture);

    await typeQuery(fixture, 'zzz');

    expect(countText(fixture)).toBe('0 of 0');
    expect(fixture.nativeElement.querySelector('.search-hint')?.textContent).toContain('No matches found');
    expect(fixture.nativeElement.querySelector('.search-input')?.getAttribute('aria-invalid')).toBe('true');
    expect((fixture.nativeElement.querySelector('.search-prev') as HTMLButtonElement).disabled).toBe(true);
    expect((fixture.nativeElement.querySelector('.search-next') as HTMLButtonElement).disabled).toBe(true);
    expect(markList(fixture).length).toBe(0);
  });

  it('exposes role=search with labelled controls and a live count', async () => {
    const fixture = await renderSearchable();
    await openBar(fixture);
    await typeQuery(fixture, 'alpha');

    const bar = fixture.nativeElement.querySelector('.search-bar') as HTMLElement;
    expect(bar.getAttribute('role')).toBe('search');
    expect(fixture.nativeElement.querySelector('.search-input')?.getAttribute('aria-label')).toBe('Search summary');
    expect(fixture.nativeElement.querySelector('.search-count')?.getAttribute('aria-live')).toBe('polite');
    expect(fixture.nativeElement.querySelector('.search-prev')?.getAttribute('aria-label')).toBe('Previous');
    expect(fixture.nativeElement.querySelector('.search-next')?.getAttribute('aria-label')).toBe('Next');
    expect(fixture.nativeElement.querySelector('.search-close')?.getAttribute('aria-label')).toBe('Close');
    const marks = markList(fixture);
    expect(marks.filter((mark) => mark.getAttribute('aria-current') === 'true').length).toBe(1);
  });

  it('scrolls the active mark into view cycling both directions, never for a single match', async () => {
    const fixture = await renderSearchable();
    if (typeof Element.prototype.scrollIntoView !== 'function') {
      // jsdom has no layout — stub so the spy below has something to wrap.
      Element.prototype.scrollIntoView = function (): void {
        // Intentional no-op: assert the call, not the pixels.
      };
    }
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {
      // Intentional no-op: assert the call, not the pixels.
    });
    const activeEl = (): Element | null =>
      fixture.nativeElement.querySelector('mark[data-search-mark].current');
    const lastReceiver = (): unknown => spy.mock.instances[spy.mock.instances.length - 1];
    try {
      await openBar(fixture);
      await typeQuery(fixture, 'alpha');
      expect(spy).toHaveBeenCalledWith({ block: 'center', inline: 'nearest' });
      expect(lastReceiver()).toBe(activeEl());
      const input = fixture.nativeElement.querySelector('.search-input') as HTMLInputElement;
      const steps: readonly (readonly [string, boolean, number])[] = [
        ['Enter', false, 1],
        ['Enter', false, 2],
        ['Enter', false, 0],
        ['Enter', true, 2],
      ];
      for (const [key, shift, want] of steps) {
        spy.mockClear();
        await pressKey(fixture, input, { key, shiftKey: shift });
        expect(currentIndex(fixture)).toBe(want);
        expect(lastReceiver()).toBe(activeEl());
      }
      spy.mockClear();
      await typeQuery(fixture, 'gamma');
      expect(countText(fixture)).toBe('1 of 1');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
