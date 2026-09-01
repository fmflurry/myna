import { TestBed } from '@angular/core/testing';
import { afterEach, vi } from 'vitest';

import { transcriptSegment } from '../../../application/testing/transcript-segment.factory';
import { TranscriptViewComponent, type TranscriptSectionDelete } from './transcript-view.component';

/**
 * Chip-menu "Delete section…": one visible section (a run of consecutive
 * same-speaker segments) is removed as a unit. The component only emits the
 * group's ABSOLUTE indices — persistence and undo live behind
 * the facade (see `meetings-facade-transcript-history.support.ts`).
 */
describe('TranscriptViewComponent — delete section', () => {
  const createFixture = (speakers: readonly string[]) => {
    const fixture = TestBed.createComponent(TranscriptViewComponent);
    fixture.componentRef.setInput('transcript', {
      segments: speakers.map((speaker, index) =>
        transcriptSegment({ startSec: index * 5, endSec: index * 5 + 5, text: `Line ${index}`, speaker }),
      ),
    });
    fixture.detectChanges();
    return fixture;
  };

  afterEach(() => vi.restoreAllMocks());

  const menuItems = (fixture: ReturnType<typeof createFixture>): string[] =>
    Array.from(fixture.nativeElement.querySelectorAll('.speaker-menu [role="menuitem"]')).map(
      (el) => (el as HTMLElement).textContent?.trim() ?? '',
    );

  const deleteOption = (fixture: ReturnType<typeof createFixture>): HTMLButtonElement => {
    const option = Array.from(
      fixture.nativeElement.querySelectorAll('.speaker-menu [role="menuitem"]'),
    ).find((el) => (el as HTMLElement).textContent?.trim() === 'Delete section…');
    if (!option) {
      throw new Error('Menu item "Delete section…" not found');
    }
    return option as HTMLButtonElement;
  };

  it('offers "Delete section…" on a multi-segment group chip', () => {
    const fixture = createFixture(['others', 'others', 'me']);
    const chips: HTMLButtonElement[] = Array.from(fixture.nativeElement.querySelectorAll('.speaker-chip'));
    chips[0]!.click();
    fixture.detectChanges();

    expect(menuItems(fixture)).toContain('Delete section…');
  });

  it('emits sectionDeleted with the group ABSOLUTE indices after the user confirms, and closes the menu', () => {
    const fixture = createFixture(['me', 'others', 'others', 'me']);
    const emitted: TranscriptSectionDelete[] = [];
    fixture.componentInstance.sectionDeleted.subscribe((event) => emitted.push(event));
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    const chips: HTMLButtonElement[] = Array.from(fixture.nativeElement.querySelectorAll('.speaker-chip'));
    chips[1]!.click();
    fixture.detectChanges();
    deleteOption(fixture).click();
    fixture.detectChanges();

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(emitted).toEqual([{ indices: [1, 2] }]);
    expect(fixture.nativeElement.querySelector('.speaker-menu')).toBeNull();
  });

  it('emits a single-index payload for a one-segment section', () => {
    const fixture = createFixture(['me', 'unknown']);
    const emitted: TranscriptSectionDelete[] = [];
    fixture.componentInstance.sectionDeleted.subscribe((event) => emitted.push(event));
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const chips: HTMLButtonElement[] = Array.from(fixture.nativeElement.querySelectorAll('.speaker-chip'));
    chips[1]!.click();
    fixture.detectChanges();
    deleteOption(fixture).click();

    expect(emitted).toEqual([{ indices: [1] }]);
  });

  it('emits nothing when the user declines the confirmation', () => {
    const fixture = createFixture(['others', 'others']);
    const emitted: TranscriptSectionDelete[] = [];
    fixture.componentInstance.sectionDeleted.subscribe((event) => emitted.push(event));
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    const chips: HTMLButtonElement[] = Array.from(fixture.nativeElement.querySelectorAll('.speaker-chip'));
    chips[0]!.click();
    fixture.detectChanges();
    deleteOption(fixture).click();

    expect(emitted).toEqual([]);
  });

  it('uses the resolved speaker name in the confirmation message', () => {
    const fixture = createFixture(['others:1']);
    fixture.componentRef.setInput('speakerNames', { 'others:1': 'Jean' });
    fixture.detectChanges();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    const chip: HTMLButtonElement = fixture.nativeElement.querySelector('.speaker-chip');
    chip.click();
    fixture.detectChanges();
    deleteOption(fixture).click();

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(String(confirmSpy.mock.calls[0]?.[0])).toContain('Jean');
  });
});
