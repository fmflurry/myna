import { TestBed } from '@angular/core/testing';
import { afterEach, vi } from 'vitest';

import { transcriptSegment } from '../../../application/testing/transcript-segment.factory';
import {
  TranscriptViewComponent,
  type SpeakerRename,
  type TranscriptSelectionSpeakerAssignment,
} from './transcript-view.component';

/**
 * Contract for the floating selection toolbar: a text selection across
 * rendered segments opens a fixed-position menu ABOVE it; picking a speaker
 * assigns it to EVERY intersected segment in one compound emit. Driven with
 * the REAL jsdom Selection/Range API (createRange + addRange over rendered
 * text nodes, `mouseup` on `document`) — never mocked. Picker items get a
 * full `mousedown → mouseup → click` sequence plus an `isConnected` survival
 * check: a naive `.click()` passes even when the toolbar's own mouseup
 * handler detaches the item mid-click — Chrome then suppresses the click:
 * silently dead picker, green specs.
 */
describe('TranscriptViewComponent — selection toolbar', () => {
  let mounted: HTMLElement[] = [];
  interface FixtureOptions {
    readonly editable?: boolean;
    readonly speakerNames?: Readonly<Record<string, string>>;
    readonly texts?: readonly string[];
  }

  const createFixture = (speakers: readonly string[], options: FixtureOptions = {}) => {
    const fixture = TestBed.createComponent(TranscriptViewComponent);
    fixture.componentRef.setInput('transcript', {
      segments: speakers.map((speaker, index) =>
        transcriptSegment({
          startSec: index * 5,
          endSec: index * 5 + 5,
          text: options.texts?.[index] ?? `Line ${index} content`,
          speaker,
        }),
      ),
    });
    fixture.componentRef.setInput('speakerNames', options.speakerNames ?? {});
    if (options.editable !== undefined) {
      fixture.componentRef.setInput('editable', options.editable);
    }
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    mounted.push(root);
    document.body.appendChild(root);
    return fixture;
  };
  type Fixture = ReturnType<typeof createFixture>;

  afterEach(() => {
    mounted.forEach((el) => el.remove());
    mounted = [];
    window.getSelection()?.removeAllRanges();
    delete (Range.prototype as unknown as { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect;
    vi.restoreAllMocks();
  });

  /** Every rendered segment host, in DOM order — one per underlying segment, grouped or not. */
  const segmentHosts = (fixture: Fixture): HTMLElement[] =>
    Array.from(fixture.nativeElement.querySelectorAll('[data-segment-index]')) as HTMLElement[];

  const firstTextNode = (root: HTMLElement): Text => {
    const node = document.createTreeWalker(root, NodeFilter.SHOW_TEXT).nextNode();
    if (node === null) {
      throw new Error(`No text node rendered under <${root.tagName.toLowerCase()}>`);
    }
    return node as Text;
  };

  const setSelection = (range: Range): void => {
    const selection = window.getSelection();
    if (selection === null) {
      throw new Error('jsdom Selection API unavailable');
    }
    selection.removeAllRanges();
    selection.addRange(range);
  };

  /** Selects from the start of segment `fromIndex`'s text to the end of segment `toIndex`'s text. */
  const selectAcross = (fixture: Fixture, fromIndex: number, toIndex: number): void => {
    const hosts = segmentHosts(fixture);
    const start = firstTextNode(hosts[fromIndex]!);
    const end = firstTextNode(hosts[toIndex]!);
    const range = document.createRange();
    range.setStart(start, 0);
    range.setEnd(end, end.data.length);
    setSelection(range);
  };

  const selectNodeContents = (root: HTMLElement): void => {
    const range = document.createRange();
    range.selectNodeContents(root);
    setSelection(range);
  };

  const mouseupOn = (target: EventTarget): void => {
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  };

  /** Mirrors what a real browser dispatches for one mouse click — never a bare `.click()` on picker items. */
  const fullClick = (el: HTMLElement): void => {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  };

  const toolbar = (fixture: Fixture): HTMLElement | null => fixture.nativeElement.querySelector('.selection-menu');

  const attributionTrigger = (fixture: Fixture): HTMLButtonElement =>
    fixture.nativeElement.querySelector('.selection-trigger') as HTMLButtonElement;

  const pickerItems = (fixture: Fixture): HTMLButtonElement[] =>
    Array.from(fixture.nativeElement.querySelectorAll('.selection-menu .speaker-menu [role="menuitem"]')) as HTMLButtonElement[];

  const openToolbar = (fixture: Fixture, fromIndex: number, toIndex: number): void => {
    selectAcross(fixture, fromIndex, toIndex);
    mouseupOn(document);
    fixture.detectChanges();
  };

  /** Selects within the FIRST segment host's text, from offset `from` to offset `to`. */
  const selectInSingleText = (fixture: Fixture, from: number, to: number): void => {
    const text = firstTextNode(segmentHosts(fixture)[0]!);
    const range = document.createRange();
    range.setStart(text, from);
    range.setEnd(text, to);
    setSelection(range);
  };

  /** jsdom's `Range` has no `getBoundingClientRect` at all — install a prototype stub, removed in `afterEach`. */
  const stubSelectionRect = (rect: { readonly top: number; readonly bottom: number; readonly left: number }): void => {
    (Range.prototype as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
      ({
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.left + 200,
        width: 200,
        height: rect.bottom - rect.top,
        x: rect.left,
        y: rect.top,
        toJSON: () => ({}),
      }) as unknown as DOMRect;
  };

  describe('opening', () => {
    it('carries the ABSOLUTE segment index on every rendered segment, even inside one group', () => {
      const fixture = createFixture(['others:1', 'others:1', 'others:1']);
      expect(segmentHosts(fixture).map((el) => el.getAttribute('data-segment-index'))).toEqual(['0', '1', '2']);
    });

    it('opens the toolbar for a non-empty selection inside one segment, with an accessible attribution trigger', () => {
      const fixture = createFixture(['others:1', 'others:2']);
      openToolbar(fixture, 0, 0);

      expect(toolbar(fixture)).not.toBeNull();
      const trigger = attributionTrigger(fixture);
      expect(trigger.getAttribute('title')).toBe('Attribute this speech to another speaker');
      expect(trigger.getAttribute('aria-label')).toBe('Attribute this speech to another speaker');
      expect(trigger.querySelector('svg')).not.toBeNull();
    });

    it('labels the scope with the number of selected segments — plural and singular', () => {
      const fixture = createFixture(['others:1', 'others:2', 'others:3']);
      openToolbar(fixture, 0, 2);
      expect(toolbar(fixture)!.textContent).toContain('3 segments');
      openToolbar(fixture, 1, 1);
      expect(toolbar(fixture)!.textContent).toContain('1 segment');
    });

    it('does not open for a collapsed selection', () => {
      const fixture = createFixture(['others:1']);
      selectInSingleText(fixture, 2, 2);
      mouseupOn(document);
      fixture.detectChanges();
      expect(toolbar(fixture)).toBeNull();
    });

    it('does not open for a whitespace-only selection', () => {
      const fixture = createFixture(['others:1'], { texts: ['   '] });
      selectInSingleText(fixture, 0, 3);
      mouseupOn(document);
      fixture.detectChanges();
      expect(toolbar(fixture)).toBeNull();
    });

    it('does not open when the selection lies outside the transcript', () => {
      const fixture = createFixture(['others:1']);
      const outside = document.createElement('span');
      outside.textContent = 'text outside the transcript';
      document.body.appendChild(outside);
      selectNodeContents(outside);
      mouseupOn(document);
      fixture.detectChanges();
      expect(toolbar(fixture)).toBeNull();
      outside.remove();
    });

    it('does not open when the selection is anchored inside a speaker chip', () => {
      const fixture = createFixture(['others:1']);
      selectNodeContents(fixture.nativeElement.querySelector('.speaker-chip'));
      mouseupOn(document);
      fixture.detectChanges();
      expect(toolbar(fixture)).toBeNull();
    });

    it('does not open when the selection is anchored inside an open chip menu, and leaves the menu untouched', () => {
      const fixture = createFixture(['others:1']);
      (fixture.nativeElement.querySelector('.speaker-chip') as HTMLButtonElement).click();
      fixture.detectChanges();
      selectNodeContents(fixture.nativeElement.querySelector('.speaker-menu [role="menuitem"]'));
      mouseupOn(document);
      fixture.detectChanges();
      expect(toolbar(fixture)).toBeNull();
      expect(fixture.nativeElement.querySelector('.speaker-menu')).not.toBeNull();
    });

    it('never opens when editable is false', () => {
      const fixture = createFixture(['others:1', 'others:2'], { editable: false });
      openToolbar(fixture, 0, 1);
      expect(toolbar(fixture)).toBeNull();
    });
  });

  describe('speaker picker', () => {
    it('offers Me, Others (unassigned), every named identity from speakerNames, and New speaker…', () => {
      const fixture = createFixture(['others:1', 'others:2'], {
        speakerNames: { 'others:9': 'Jean', 'others:8': 'Alice' },
      });
      openToolbar(fixture, 0, 1);
      fullClick(attributionTrigger(fixture));
      fixture.detectChanges();
      const texts = pickerItems(fixture).map((el) => el.textContent?.trim() ?? '');
      const wanted = ['Me', 'Others (unassigned)', 'Jean', 'Alice', 'New speaker…'];
      expect(texts.filter((text) => wanted.includes(text)).length).toBe(wanted.length);
    });

    it('keeps the picker intact across a mouseup originating inside the toolbar (no close-and-reopen)', () => {
      const fixture = createFixture(['others:1', 'others:2']);
      openToolbar(fixture, 0, 1);
      fullClick(attributionTrigger(fixture));
      fixture.detectChanges();
      const [firstItem] = pickerItems(fixture);
      expect(firstItem).toBeDefined();

      mouseupOn(firstItem!);
      fixture.detectChanges();

      expect(firstItem!.isConnected).toBe(true);
      expect(toolbar(fixture)).not.toBeNull();
      expect(pickerItems(fixture).length).toBeGreaterThan(0);
    });

    it('emits selectionSpeakerAssigned with EVERY selected index on a full-sequence click of a picker item', () => {
      const fixture = createFixture(['others:1', 'others:2', 'others:3']);
      const emitted: TranscriptSelectionSpeakerAssignment[] = [];
      fixture.componentInstance.selectionSpeakerAssigned.subscribe((event) => emitted.push(event));
      openToolbar(fixture, 0, 2);
      fullClick(attributionTrigger(fixture));
      fixture.detectChanges();
      const meItem = pickerItems(fixture).find((el) => el.textContent?.trim() === 'Me');
      expect(meItem).toBeDefined();

      // The mid-sequence mouseup must NOT detach the item (Chrome suppresses
      // clicks on removed nodes — the exact shortcut that hid the bug).
      meItem!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      meItem!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      expect(meItem!.isConnected).toBe(true);
      meItem!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(emitted).toEqual([{ indices: [0, 1, 2], speaker: 'me' }]);
      fixture.detectChanges();
      expect(toolbar(fixture)).toBeNull();
    });

    it('toggle-closes the picker when the trigger is clicked again', () => {
      const fixture = createFixture(['others:1']);
      openToolbar(fixture, 0, 0);
      fullClick(attributionTrigger(fixture));
      fixture.detectChanges();
      expect(pickerItems(fixture).length).toBeGreaterThan(0);

      fullClick(attributionTrigger(fixture));
      fixture.detectChanges();

      expect(pickerItems(fixture).length).toBe(0);
      expect(toolbar(fixture)).not.toBeNull();
    });
  });

  describe('closing', () => {
    it('closes on Escape', () => {
      const fixture = createFixture(['others:1']);
      openToolbar(fixture, 0, 0);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      fixture.detectChanges();
      expect(toolbar(fixture)).toBeNull();
    });

    it('closes on a capture-phase scroll', () => {
      const fixture = createFixture(['others:1']);
      openToolbar(fixture, 0, 0);
      document.dispatchEvent(new Event('scroll'));
      fixture.detectChanges();
      expect(toolbar(fixture)).toBeNull();
    });

    it('closes when the transcript changes', () => {
      const fixture = createFixture(['others:1', 'others:2']);
      openToolbar(fixture, 0, 1);
      fixture.componentRef.setInput('transcript', {
        segments: [transcriptSegment({ startSec: 0, endSec: 5, text: 'replaced', speaker: 'others:1' })],
      });
      fixture.detectChanges();
      expect(toolbar(fixture)).toBeNull();
    });

    it('closes on a click outside the toolbar and the transcript', () => {
      const fixture = createFixture(['others:1']);
      openToolbar(fixture, 0, 0);
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      fixture.detectChanges();
      expect(toolbar(fixture)).toBeNull();
    });

    it('keeps the toolbar open for the trailing click a drag-select fires inside the transcript', () => {
      const fixture = createFixture(['others:1', 'others:2']);
      openToolbar(fixture, 0, 1);
      segmentHosts(fixture)[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      fixture.detectChanges();
      expect(toolbar(fixture)).not.toBeNull();
    });
  });

  describe('mutual exclusion with the chip menu', () => {
    it('opening the chip menu closes the toolbar', () => {
      const fixture = createFixture(['others:1', 'others:2']);
      openToolbar(fixture, 0, 1);
      (fixture.nativeElement.querySelector('.speaker-chip') as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(toolbar(fixture)).toBeNull();
      expect(fixture.nativeElement.querySelector('.speaker-menu')).not.toBeNull();
    });

    it('opening the toolbar closes the chip menu', () => {
      const fixture = createFixture(['others:1', 'others:2']);
      (fixture.nativeElement.querySelector('.speaker-chip') as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.speaker-menu')).not.toBeNull();
      openToolbar(fixture, 0, 1);
      expect(fixture.nativeElement.querySelector('.speaker-menu')).toBeNull();
      expect(toolbar(fixture)).not.toBeNull();
    });

    it('leaves chip-menu renaming untouched: typing and Enter still emit speakerRenamed', () => {
      const fixture = createFixture(['others:1']);
      const emitted: SpeakerRename[] = [];
      fixture.componentInstance.speakerRenamed.subscribe((event) => emitted.push(event));
      (fixture.nativeElement.querySelector('.speaker-chip') as HTMLButtonElement).click();
      fixture.detectChanges();

      const input: HTMLInputElement = fixture.nativeElement.querySelector('.rename-row input');
      mouseupOn(input);
      input.value = '  Jean  ';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      fixture.detectChanges();

      expect(emitted).toEqual([{ label: 'others:1', name: 'Jean' }]);
    });
  });

  describe('placement', () => {
    it('anchors the toolbar ABOVE the selection rect (bottom-anchored, no top)', () => {
      stubSelectionRect({ top: 300, bottom: 320, left: 40 });
      const fixture = createFixture(['others:1']);
      openToolbar(fixture, 0, 0);

      const menu = toolbar(fixture);
      expect(menu).not.toBeNull();
      expect(menu!.style.bottom).toBe(`${window.innerHeight - 300 + 4}px`);
      expect(menu!.style.top).toBe('');
      expect(menu!.style.left).toBe('40px');
    });

    it('flips BELOW the selection when there is no room above (rect near the viewport top)', () => {
      stubSelectionRect({ top: 20, bottom: 40, left: 40 });
      const fixture = createFixture(['others:1']);
      openToolbar(fixture, 0, 0);

      const menu = toolbar(fixture);
      expect(menu).not.toBeNull();
      expect(menu!.style.top).toBe('44px');
      expect(menu!.style.bottom).toBe('');
    });
  });
});
