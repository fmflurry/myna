import { TestBed } from '@angular/core/testing';
import { afterEach, vi } from 'vitest';

import { transcriptSegment } from '../../../application/testing/transcript-segment.factory';
import { TranscriptViewComponent, type TranscriptSectionDelete } from './transcript-view.component';

/**
 * Per-entry ("one line") delete: EVERY rendered entry line carries a
 * `.line-delete` affordance that removes exactly ONE segment. The emit
 * deliberately REUSES `sectionDeleted` with a 1-element index list — the
 * pane re-emit, shell handler, facade compound-undo op, and the singular
 * undo label already treat a single-index section as a single-segment
 * delete, so no parallel pipeline is introduced.
 */
describe('TranscriptViewComponent — delete one line', () => {
  let mounted: HTMLElement[] = [];

  const createFixture = (speakers: readonly string[], texts?: readonly string[]) => {
    const fixture = TestBed.createComponent(TranscriptViewComponent);
    fixture.componentRef.setInput('transcript', {
      segments: speakers.map((speaker, index) =>
        transcriptSegment({
          startSec: index * 5,
          endSec: index * 5 + 5,
          text: texts?.[index] ?? `Line ${index}`,
          speaker,
        }),
      ),
    });
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
    vi.restoreAllMocks();
  });

  const lineDeleteButtons = (fixture: Fixture): HTMLButtonElement[] =>
    Array.from(fixture.nativeElement.querySelectorAll('button.line-delete')) as HTMLButtonElement[];

  /** Three 'me' lines (0,1,2) then one 'others' section of three lines (3,4,5). */
  const twoSections = () => ['me', 'me', 'me', 'others', 'others', 'others'];

  it('renders one delete button per entry line carrying its ABSOLUTE index — the middle line of the 3,4,5 section deletes 4', () => {
    const fixture = createFixture(twoSections());

    expect(lineDeleteButtons(fixture).map((el) => el.getAttribute('data-line-delete-index'))).toEqual([
      '0', '1', '2', '3', '4', '5',
    ]);
    const secondSection = fixture.nativeElement.querySelectorAll('.segment-group')[1] as HTMLElement;
    const sectionButtons = Array.from(
      secondSection.querySelectorAll('button.line-delete'),
    ) as HTMLButtonElement[];
    expect(sectionButtons.map((el) => el.getAttribute('data-line-delete-index'))).toEqual(['3', '4', '5']);
    expect(sectionButtons[1]!.getAttribute('data-line-delete-index')).toBe('4');
  });

  it('clicking the middle line with a confirmed prompt emits sectionDeleted with exactly [4]', () => {
    const fixture = createFixture(twoSections());
    const emitted: TranscriptSectionDelete[] = [];
    fixture.componentInstance.sectionDeleted.subscribe((event) => emitted.push(event));
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    lineDeleteButtons(fixture)[4]!.click();

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(emitted).toEqual([{ indices: [4] }]);
  });

  it('emits nothing when the user declines the confirmation', () => {
    const fixture = createFixture(twoSections());
    const emitted: TranscriptSectionDelete[] = [];
    fixture.componentInstance.sectionDeleted.subscribe((event) => emitted.push(event));
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    lineDeleteButtons(fixture)[4]!.click();

    expect(emitted).toEqual([]);
  });

  it('confirmation message quotes the line text, truncated to an excerpt for long lines', () => {
    const longText = 'The quick brown fox jumps over the lazy dog, then keeps running far past the fence.';
    const fixture = createFixture(twoSections(), undefined);
    fixture.componentRef.setInput('transcript', {
      segments: twoSections().map((speaker, index) =>
        transcriptSegment({
          startSec: index * 5,
          endSec: index * 5 + 5,
          text: index === 4 ? longText : `Line ${index}`,
          speaker,
        }),
      ),
    });
    fixture.detectChanges();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    lineDeleteButtons(fixture)[4]!.click();

    const message = String(confirmSpy.mock.calls[0]?.[0]);
    expect(message).toContain('quick brown fox');
    expect(message.length).toBeLessThan(longText.length + 120);
    expect(message).toContain('…');
  });

  it('the affordance is a focusable native button with an accessible name and a decorative icon', () => {
    const fixture = createFixture(['others']);
    const button = lineDeleteButtons(fixture)[0]!;

    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.hasAttribute('tabindex')).toBe(false);
    expect(button.getAttribute('aria-label')).toContain('Delete');
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('a mouseup on the delete button with a collapsed selection never opens the selection toolbar', () => {
    const fixture = createFixture(['others', 'others', 'others']);

    lineDeleteButtons(fixture)[1]!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.selection-menu')).toBeNull();
  });

  it('clicking a line delete while the chip menu is open closes the menu cleanly', () => {
    const fixture = createFixture(twoSections());
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const chips: HTMLButtonElement[] = Array.from(fixture.nativeElement.querySelectorAll('.speaker-chip'));
    chips[0]!.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.speaker-menu')).not.toBeNull();

    lineDeleteButtons(fixture)[1]!.click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.speaker-menu')).toBeNull();
  });
});
