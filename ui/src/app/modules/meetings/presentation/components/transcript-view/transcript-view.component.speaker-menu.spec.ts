import { TestBed } from '@angular/core/testing';
import { afterEach, vi } from 'vitest';

import { transcriptSegment } from '../../../application/testing/transcript-segment.factory';
import {
  TranscriptViewComponent,
  type SpeakerRename,
  type TranscriptSegmentSpeakerReassign,
} from './transcript-view.component';

describe('TranscriptViewComponent — speaker chip menu', () => {
  const createFixture = (
    speakerNames: Readonly<Record<string, string>> = {},
    speakers: readonly string[] = ['others:1', 'unknown'],
  ) => {
    const fixture = TestBed.createComponent(TranscriptViewComponent);
    fixture.componentRef.setInput('speakerNames', speakerNames);
    fixture.componentRef.setInput('transcript', {
      segments: speakers.map((speaker, index) =>
        transcriptSegment({ startSec: index * 5, endSec: index * 5 + 5, text: `Line ${index}`, speaker }),
      ),
    });
    fixture.detectChanges();
    return fixture;
  };

  it('opens the menu on chip click, listing Me, Others (unassigned), and New speaker…', () => {
    const fixture = createFixture();
    const chips: HTMLButtonElement[] = Array.from(fixture.nativeElement.querySelectorAll('.speaker-chip'));
    chips[0]!.click();
    fixture.detectChanges();

    const items: string[] = Array.from(fixture.nativeElement.querySelectorAll('.speaker-menu [role="menuitem"]')).map(
      (el) => (el as HTMLElement).textContent?.trim() ?? '',
    );
    expect(items).toContain('Me');
    expect(items).toContain('Others (unassigned)');
    expect(items).toContain('New speaker…');
  });

  it('lists a known named identity from speakerNames as a menu option', () => {
    const fixture = createFixture({ 'others:1': 'Jean' });
    const chips: HTMLButtonElement[] = Array.from(fixture.nativeElement.querySelectorAll('.speaker-chip'));
    chips[1]!.click();
    fixture.detectChanges();

    const items: string[] = Array.from(fixture.nativeElement.querySelectorAll('.speaker-menu [role="menuitem"]')).map(
      (el) => (el as HTMLElement).textContent?.trim() ?? '',
    );
    expect(items).toContain('Jean');
  });

  it('emits segmentSpeakerReassigned when a menu option is clicked, and closes the menu', () => {
    const fixture = createFixture();
    const emitted: TranscriptSegmentSpeakerReassign[] = [];
    fixture.componentInstance.segmentSpeakerReassigned.subscribe((event) => emitted.push(event));

    const chips: HTMLButtonElement[] = Array.from(fixture.nativeElement.querySelectorAll('.speaker-chip'));
    chips[1]!.click();
    fixture.detectChanges();
    const meOption = Array.from(fixture.nativeElement.querySelectorAll('.speaker-menu [role="menuitem"]')).find(
      (el) => (el as HTMLElement).textContent?.trim() === 'Me',
    ) as HTMLButtonElement;
    meOption.click();
    fixture.detectChanges();

    expect(emitted).toEqual([{ index: 1, speaker: 'me' }]);
    expect(fixture.nativeElement.querySelector('.speaker-menu')).toBeNull();
  });

  it('mints a fresh others:mN label via "New speaker…" that never collides with a diarizer-produced numeric sub-id', () => {
    const fixture = createFixture();
    const emitted: TranscriptSegmentSpeakerReassign[] = [];
    fixture.componentInstance.segmentSpeakerReassigned.subscribe((event) => emitted.push(event));

    const chips: HTMLButtonElement[] = Array.from(fixture.nativeElement.querySelectorAll('.speaker-chip'));
    chips[1]!.click();
    fixture.detectChanges();
    const newSpeakerOption = Array.from(fixture.nativeElement.querySelectorAll('.speaker-menu [role="menuitem"]')).find(
      (el) => (el as HTMLElement).textContent?.trim() === 'New speaker…',
    ) as HTMLButtonElement;
    newSpeakerOption.click();

    expect(emitted).toEqual([{ index: 1, speaker: 'others:m1' }]);
  });

  it('offers renaming only once the segment carries a sub-identity', () => {
    const withSubId = createFixture();
    const subIdChip: HTMLButtonElement = withSubId.nativeElement.querySelectorAll('.speaker-chip')[0]!;
    subIdChip.click();
    withSubId.detectChanges();
    expect(withSubId.nativeElement.querySelector('.rename-row')).toBeTruthy();

    const withoutSubId = createFixture();
    const bareChip: HTMLButtonElement = withoutSubId.nativeElement.querySelectorAll('.speaker-chip')[1]!;
    bareChip.click();
    withoutSubId.detectChanges();
    expect(withoutSubId.nativeElement.querySelector('.rename-row')).toBeNull();
  });

  it('emits speakerRenamed with the trimmed name on Enter', () => {
    const fixture = createFixture();
    const emitted: SpeakerRename[] = [];
    fixture.componentInstance.speakerRenamed.subscribe((event) => emitted.push(event));

    const chips: HTMLButtonElement[] = Array.from(fixture.nativeElement.querySelectorAll('.speaker-chip'));
    chips[0]!.click();
    fixture.detectChanges();

    const input: HTMLInputElement = fixture.nativeElement.querySelector('.rename-row input');
    input.value = '  Jean  ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();

    expect(emitted).toEqual([{ label: 'others:1', name: 'Jean' }]);
  });

  it('offers renaming a "me" chip and emits speakerRenamed with label "me"', () => {
    const fixture = createFixture({}, ['me']);
    const emitted: SpeakerRename[] = [];
    fixture.componentInstance.speakerRenamed.subscribe((event) => emitted.push(event));

    const chip: HTMLButtonElement = fixture.nativeElement.querySelector('.speaker-chip');
    chip.click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.rename-row')).toBeTruthy();
    const input: HTMLInputElement = fixture.nativeElement.querySelector('.rename-row input');
    expect(input.placeholder).toBe('Me');
    input.value = '  Alice  ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();

    expect(emitted).toEqual([{ label: 'me', name: 'Alice' }]);
  });

  it('shows the resolved name as the rename placeholder for a named "me" chip', () => {
    const fixture = createFixture({ me: 'Alice' }, ['me']);
    const chip: HTMLButtonElement = fixture.nativeElement.querySelector('.speaker-chip');
    chip.click();
    fixture.detectChanges();

    const input: HTMLInputElement = fixture.nativeElement.querySelector('.rename-row input');
    expect(input.placeholder).toBe('Alice');
  });

  describe('viewport-aware flip and fixed portal', () => {
    afterEach(() => vi.restoreAllMocks());

    it('when last chip at window.innerHeight - 10, menu is dropup or fixed, stays within viewport and is scrollable', () => {
      Object.defineProperty(window, 'innerHeight', { value: 600, writable: true, configurable: true });
      Object.defineProperty(window, 'innerWidth', { value: 1024, writable: true, configurable: true });
      const fixture = createFixture({}, ['others:1', 'others:2']);
      const chips: HTMLButtonElement[] = Array.from(fixture.nativeElement.querySelectorAll('.speaker-chip'));
      const lastChip = chips[chips.length - 1]!;
      vi.spyOn(lastChip, 'getBoundingClientRect').mockReturnValue({
        top: 570,
        bottom: 590,
        left: 40,
        right: 140,
        width: 100,
        height: 20,
        x: 40,
        y: 570,
        toJSON: () => ({}),
      } as unknown as DOMRect);
      lastChip.click();
      fixture.detectChanges();

      const menu = fixture.nativeElement.querySelector('.speaker-menu') as HTMLElement | null;
      expect(menu).not.toBeNull();
      const isDropup = menu!.classList.contains('dropup');
      const isFixed = menu!.classList.contains('speaker-menu--fixed') || menu!.style.position === 'fixed';
      expect(isDropup || isFixed).toBe(true);
      expect(getComputedStyle(menu!).overflowY).toBe('auto');
      const menuRect = menu!.getBoundingClientRect();
      expect(menuRect.bottom).toBeLessThanOrEqual(window.innerHeight);
      // includes Rename input scenario still visible via scroll: menu must have max-height / overflow
      expect(menu!.style.maxHeight !== '' || getComputedStyle(menu!).maxHeight !== 'none').toBe(true);
    });

    it('closes on Escape', () => {
      const fixture = createFixture();
      const chip: HTMLButtonElement = fixture.nativeElement.querySelector('.speaker-chip');
      chip.click();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.speaker-menu')).not.toBeNull();
      const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
      document.dispatchEvent(escapeEvent);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.speaker-menu')).toBeNull();
    });

    it('closes the menu when the user clicks outside it', () => {
      const fixture = createFixture();
      const chip: HTMLButtonElement = fixture.nativeElement.querySelector('.speaker-chip');
      chip.click();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.speaker-menu')).not.toBeNull();

      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('.speaker-menu')).toBeNull();
    });

    it('keeps the menu open when the user clicks inside it', () => {
      const fixture = createFixture();
      document.body.appendChild(fixture.nativeElement);
      const chip: HTMLButtonElement = fixture.nativeElement.querySelector('.speaker-chip');
      chip.click();
      fixture.detectChanges();
      const input: HTMLInputElement = fixture.nativeElement.querySelector('.rename-row input');
      expect(input).not.toBeNull();

      input.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('.speaker-menu')).not.toBeNull();
    });

    it('clamps left to viewport margin when trigger near right edge', () => {
      Object.defineProperty(window, 'innerWidth', { value: 400, writable: true, configurable: true });
      Object.defineProperty(window, 'innerHeight', { value: 800, writable: true, configurable: true });
      const fixture = createFixture({}, ['others:1']);
      const chip: HTMLButtonElement = fixture.nativeElement.querySelector('.speaker-chip');
      vi.spyOn(chip, 'getBoundingClientRect').mockReturnValue({
        top: 100,
        bottom: 120,
        left: 380,
        right: 480,
        width: 100,
        height: 20,
        x: 380,
        y: 100,
        toJSON: () => ({}),
      } as unknown as DOMRect);
      chip.click();
      fixture.detectChanges();
      const menu = fixture.nativeElement.querySelector('.speaker-menu') as HTMLElement;
      const left = Number.parseInt(menu.style.left, 10);
      expect(left).toBeGreaterThanOrEqual(8);
      expect(left).toBeLessThanOrEqual(window.innerWidth - 8);
    });
  });

  describe('Remove speaker…', () => {
    afterEach(() => vi.restoreAllMocks());

    const menuItems = (fixture: ReturnType<typeof createFixture>): string[] =>
      Array.from(fixture.nativeElement.querySelectorAll('.speaker-menu [role="menuitem"]')).map(
        (el) => (el as HTMLElement).textContent?.trim() ?? '',
      );

    it('is offered only for sub-id speakers — never for me, bare others, or unknown', () => {
      const fixture = createFixture({}, ['me', 'others', 'others:1', 'unknown']);
      const chips: HTMLButtonElement[] = Array.from(fixture.nativeElement.querySelectorAll('.speaker-chip'));

      chips[0]!.click();
      fixture.detectChanges();
      expect(menuItems(fixture)).not.toContain('Remove speaker…');
      chips[0]!.click();

      chips[1]!.click();
      fixture.detectChanges();
      expect(menuItems(fixture)).not.toContain('Remove speaker…');
      chips[1]!.click();

      chips[2]!.click();
      fixture.detectChanges();
      expect(menuItems(fixture)).toContain('Remove speaker…');
      chips[2]!.click();

      chips[3]!.click();
      fixture.detectChanges();
      expect(menuItems(fixture)).not.toContain('Remove speaker…');
    });

    it('emits speakerRemoved with the label after the user confirms', () => {
      const fixture = createFixture({ 'others:1': 'Jean' }, ['others:1']);
      const emitted: string[] = [];
      fixture.componentInstance.speakerRemoved.subscribe((label) => emitted.push(label));
      vi.spyOn(window, 'confirm').mockReturnValue(true);

      const chip: HTMLButtonElement = fixture.nativeElement.querySelector('.speaker-chip');
      chip.click();
      fixture.detectChanges();
      const removeOption = Array.from(fixture.nativeElement.querySelectorAll('.speaker-menu [role="menuitem"]')).find(
        (el) => (el as HTMLElement).textContent?.trim() === 'Remove speaker…',
      ) as HTMLButtonElement;
      removeOption.click();
      fixture.detectChanges();

      expect(window.confirm).toHaveBeenCalledWith('Remove speaker "Jean"? Its segments return to Others (unassigned).');
      expect(emitted).toEqual(['others:1']);
      expect(fixture.nativeElement.querySelector('.speaker-menu')).toBeNull();
    });

    it('emits nothing when the user declines the confirmation', () => {
      const fixture = createFixture({}, ['others:1']);
      const emitted: string[] = [];
      fixture.componentInstance.speakerRemoved.subscribe((label) => emitted.push(label));
      vi.spyOn(window, 'confirm').mockReturnValue(false);

      const chip: HTMLButtonElement = fixture.nativeElement.querySelector('.speaker-chip');
      chip.click();
      fixture.detectChanges();
      const removeOption = Array.from(fixture.nativeElement.querySelectorAll('.speaker-menu [role="menuitem"]')).find(
        (el) => (el as HTMLElement).textContent?.trim() === 'Remove speaker…',
      ) as HTMLButtonElement;
      removeOption.click();
      fixture.detectChanges();

      expect(emitted).toEqual([]);
    });
  });
});
