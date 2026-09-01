import { TestBed } from '@angular/core/testing';
import { afterEach, vi } from 'vitest';

import { transcriptSegment } from '../../../application/testing/transcript-segment.factory';
import {
  TranscriptViewComponent,
  type SpeakerRename,
  type TranscriptSelectionSpeakerAssignment,
  type TranscriptSegmentGroupSpeakerReassign,
  type TranscriptSegmentSpeakerReassign,
} from './transcript-view.component';

/**
 * "New speaker…" must never silently assign the auto-minted `others:mN`
 * label: choosing it surfaces an inline, auto-focused name input; Enter (or
 * blur-with-content) assigns the minted label AND renames it via
 * `speakerRenamed` — reassign first, rename keyed on the minted label second,
 * so the parent can resolve the rename against a label that now exists.
 * Escape or an empty name cancels without assigning. Both pickers (chip menu
 * and floating selection toolbar) share this contract.
 */
describe('TranscriptViewComponent — New speaker…', () => {
  let mounted: HTMLElement[] = [];

  const createFixture = (speakers: readonly string[], speakerNames: Readonly<Record<string, string>> = {}) => {
    const fixture = TestBed.createComponent(TranscriptViewComponent);
    fixture.componentRef.setInput('speakerNames', speakerNames);
    fixture.componentRef.setInput('transcript', {
      segments: speakers.map((speaker, index) =>
        transcriptSegment({ startSec: index * 5, endSec: index * 5 + 5, text: `Line ${index} content`, speaker }),
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

  const menuInput = (fixture: Fixture): HTMLInputElement | null =>
    fixture.nativeElement.querySelector('.new-speaker-row input') as HTMLInputElement | null;

  const clickMenuItem = (fixture: Fixture, text: string): void => {
    const option = Array.from(fixture.nativeElement.querySelectorAll('.speaker-menu [role="menuitem"]')).find(
      (el) => (el as HTMLElement).textContent?.trim() === text,
    ) as HTMLButtonElement;
    option.click();
    fixture.detectChanges();
  };

  /** Opens the chip menu on the `unknown` segment (index 1) and clicks "New speaker…". */
  const openChipNewSpeaker = async (fixture: Fixture): Promise<HTMLInputElement> => {
    const chips: HTMLButtonElement[] = Array.from(fixture.nativeElement.querySelectorAll('.speaker-chip'));
    chips[1]!.click();
    fixture.detectChanges();
    clickMenuItem(fixture, 'New speaker…');
    await fixture.whenStable();
    fixture.detectChanges();
    const input = menuInput(fixture);
    if (input === null) {
      throw new Error('New-speaker inline input did not render');
    }
    return input;
  };

  describe('chip menu', () => {
    const emitRecorder = (fixture: Fixture) => {
      const ops: string[] = [];
      const reassigned: TranscriptSegmentSpeakerReassign[] = [];
      const groupReassigned: TranscriptSegmentGroupSpeakerReassign[] = [];
      const renamed: SpeakerRename[] = [];
      fixture.componentInstance.segmentSpeakerReassigned.subscribe((event) => {
        ops.push('reassign');
        reassigned.push(event);
      });
      fixture.componentInstance.segmentGroupSpeakerReassigned.subscribe((event) => {
        ops.push('reassign-group');
        groupReassigned.push(event);
      });
      fixture.componentInstance.speakerRenamed.subscribe((event) => {
        ops.push('rename');
        renamed.push(event);
      });
      return { ops, reassigned, groupReassigned, renamed };
    };

    it('opens a focused inline name input instead of assigning anything', async () => {
      const fixture = createFixture(['others:1', 'unknown']);
      const { ops } = emitRecorder(fixture);

      const input = await openChipNewSpeaker(fixture);

      expect(document.activeElement).toBe(input);
      expect(ops).toEqual([]);
      expect(fixture.nativeElement.querySelector('.speaker-menu')).not.toBeNull();
    });

    it('Enter assigns a fresh others:mN label (never colliding with a diarizer numeric sub-id) THEN renames it to the typed name', async () => {
      const fixture = createFixture(['others:1', 'unknown']);
      const { ops, reassigned, renamed } = emitRecorder(fixture);

      const input = await openChipNewSpeaker(fixture);
      input.value = '  Jean  ';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      fixture.detectChanges();

      // Ordering matters: the parent must receive the reassign before the rename keyed on the minted label.
      expect(ops).toEqual(['reassign', 'rename']);
      expect(reassigned).toEqual([{ index: 1, speaker: 'others:m1' }]);
      expect(renamed).toEqual([{ label: 'others:m1', name: 'Jean' }]);
      expect(fixture.nativeElement.querySelector('.speaker-menu')).toBeNull();
    });

    it('Enter on a multi-segment group reassigns the whole group, then renames', async () => {
      const fixture = createFixture(['others', 'others', 'me']);
      const { ops, groupReassigned, renamed } = emitRecorder(fixture);
      const chips: HTMLButtonElement[] = Array.from(fixture.nativeElement.querySelectorAll('.speaker-chip'));
      chips[0]!.click();
      fixture.detectChanges();
      clickMenuItem(fixture, 'New speaker…');
      await fixture.whenStable();
      fixture.detectChanges();

      const input = menuInput(fixture)!;
      input.value = 'Jean';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

      expect(ops).toEqual(['reassign-group', 'rename']);
      expect(groupReassigned).toEqual([{ indices: [0, 1], speaker: 'others:m1' }]);
      expect(renamed).toEqual([{ label: 'others:m1', name: 'Jean' }]);
    });

    it('commits on blur with content, same as Enter', async () => {
      const fixture = createFixture(['others:1', 'unknown']);
      const { ops, reassigned, renamed } = emitRecorder(fixture);

      const input = await openChipNewSpeaker(fixture);
      input.value = 'Jean';
      input.dispatchEvent(new Event('blur'));
      fixture.detectChanges();

      expect(ops).toEqual(['reassign', 'rename']);
      expect(reassigned).toEqual([{ index: 1, speaker: 'others:m1' }]);
      expect(renamed).toEqual([{ label: 'others:m1', name: 'Jean' }]);
    });

    it('blur INTO another menu item abandons the typed name without committing — the item click wins, no double-assign or orphan phantom', async () => {
      const fixture = createFixture(['others:1', 'unknown']);
      const { ops, reassigned, renamed } = emitRecorder(fixture);

      const input = await openChipNewSpeaker(fixture);
      input.value = 'Jean';
      const meItem = Array.from(
        fixture.nativeElement.querySelectorAll('.speaker-menu [role="menuitem"]'),
      ).find((el) => (el as HTMLElement).textContent?.trim() === 'Me') as HTMLButtonElement;

      input.dispatchEvent(new FocusEvent('blur', { relatedTarget: meItem }));
      fixture.detectChanges();

      // The blur must NOT commit: no minted-label assign, no rename.
      expect(ops).toEqual([]);
      // The menu survives the blur, so the pending click lands and its own action wins.
      meItem.click();
      fixture.detectChanges();
      expect(ops).toEqual(['reassign']);
      expect(reassigned).toEqual([{ index: 1, speaker: 'me' }]);
      expect(renamed).toEqual([]);
    });

    it('Escape cancels with no assignment and closes the menu', async () => {
      const fixture = createFixture(['others:1', 'unknown']);
      const { ops } = emitRecorder(fixture);

      const input = await openChipNewSpeaker(fixture);
      input.value = 'Jean';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      fixture.detectChanges();

      expect(ops).toEqual([]);
      expect(fixture.nativeElement.querySelector('.speaker-menu')).toBeNull();
    });

    it('Enter with an empty name closes the menu without assigning', async () => {
      const fixture = createFixture(['others:1', 'unknown']);
      const { ops } = emitRecorder(fixture);

      const input = await openChipNewSpeaker(fixture);
      input.value = '   ';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      fixture.detectChanges();

      expect(ops).toEqual([]);
      expect(fixture.nativeElement.querySelector('.speaker-menu')).toBeNull();
    });

    it('hides the rename row while the New-speaker input is open, so the menu never shows two competing inputs', async () => {
      const fixture = createFixture(['others:1', 'unknown']);
      const chips: HTMLButtonElement[] = Array.from(fixture.nativeElement.querySelectorAll('.speaker-chip'));
      chips[0]!.click();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.rename-row input')).not.toBeNull();

      clickMenuItem(fixture, 'New speaker…');
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('.rename-row:not(.new-speaker-row)')).toBeNull();
      expect(menuInput(fixture)).not.toBeNull();
    });
  });

  describe('floating selection toolbar', () => {
    const segmentHosts = (fixture: Fixture): HTMLElement[] =>
      Array.from(fixture.nativeElement.querySelectorAll('[data-segment-index]')) as HTMLElement[];

    const firstTextNode = (root: HTMLElement): Text => {
      const node = document.createTreeWalker(root, NodeFilter.SHOW_TEXT).nextNode();
      if (node === null) {
        throw new Error(`No text node rendered under <${root.tagName.toLowerCase()}>`);
      }
      return node as Text;
    };

    /** Selects from the start of segment `fromIndex`'s text to the end of segment `toIndex`'s text. */
    const selectAcross = (fixture: Fixture, fromIndex: number, toIndex: number): void => {
      const hosts = segmentHosts(fixture);
      const start = firstTextNode(hosts[fromIndex]!);
      const end = firstTextNode(hosts[toIndex]!);
      const range = document.createRange();
      range.setStart(start, 0);
      range.setEnd(end, end.data.length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      if (selection) {
        selection.addRange(range);
      }
    };

    /** Mirrors what a real browser dispatches for one click — never a bare `.click()`. */
    const fullClick = (el: HTMLElement): void => {
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    };

    const toolbar = (fixture: Fixture): HTMLElement | null => fixture.nativeElement.querySelector('.selection-menu');

    const pickerItem = (fixture: Fixture, text: string): HTMLButtonElement => {
      const item = Array.from(
        fixture.nativeElement.querySelectorAll('.selection-menu .speaker-menu [role="menuitem"]'),
      ).find((el) => (el as HTMLElement).textContent?.trim() === text) as HTMLButtonElement;
      if (!item) {
        throw new Error(`Picker item "${text}" not found`);
      }
      return item;
    };

    /** Opens the toolbar over segments 0–1, then the picker, then clicks "New speaker…". */
    const openSelectionNewSpeaker = async (fixture: Fixture): Promise<HTMLInputElement> => {
      selectAcross(fixture, 0, 1);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      fixture.detectChanges();
      fullClick(fixture.nativeElement.querySelector('.selection-trigger') as HTMLButtonElement);
      fixture.detectChanges();
      fullClick(pickerItem(fixture, 'New speaker…'));
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
      const input = fixture.nativeElement.querySelector('.selection-menu .new-speaker-row input') as HTMLInputElement;
      if (!input) {
        throw new Error('New-speaker inline input did not render in the selection picker');
      }
      return input;
    };

    it('opens a focused inline name input instead of assigning anything', async () => {
      const fixture = createFixture(['others:1', 'others:2']);
      const emitted: TranscriptSelectionSpeakerAssignment[] = [];
      fixture.componentInstance.selectionSpeakerAssigned.subscribe((event) => emitted.push(event));

      const input = await openSelectionNewSpeaker(fixture);

      expect(document.activeElement).toBe(input);
      expect(emitted).toEqual([]);
      expect(toolbar(fixture)).not.toBeNull();
    });

    it('Enter assigns the minted others:mN label to EVERY selected index, THEN renames it to the typed name', async () => {
      const fixture = createFixture(['others:1', 'others:2']);
      const ops: string[] = [];
      const emitted: TranscriptSelectionSpeakerAssignment[] = [];
      const renamed: SpeakerRename[] = [];
      fixture.componentInstance.selectionSpeakerAssigned.subscribe((event) => {
        ops.push('assign');
        emitted.push(event);
      });
      fixture.componentInstance.speakerRenamed.subscribe((event) => {
        ops.push('rename');
        renamed.push(event);
      });

      const input = await openSelectionNewSpeaker(fixture);
      input.value = '  Alice  ';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      fixture.detectChanges();

      // Ordering matters: the parent must receive the assignment before the rename keyed on the minted label.
      expect(ops).toEqual(['assign', 'rename']);
      expect(emitted).toEqual([{ indices: [0, 1], speaker: 'others:m1' }]);
      expect(renamed).toEqual([{ label: 'others:m1', name: 'Alice' }]);
      expect(toolbar(fixture)).toBeNull();
    });

    it('Escape cancels with no assignment and closes the toolbar', async () => {
      const fixture = createFixture(['others:1', 'others:2']);
      const emitted: TranscriptSelectionSpeakerAssignment[] = [];
      const renamed: SpeakerRename[] = [];
      fixture.componentInstance.selectionSpeakerAssigned.subscribe((event) => emitted.push(event));
      fixture.componentInstance.speakerRenamed.subscribe((event) => renamed.push(event));

      const input = await openSelectionNewSpeaker(fixture);
      input.value = 'Alice';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      fixture.detectChanges();

      expect(emitted).toEqual([]);
      expect(renamed).toEqual([]);
      expect(toolbar(fixture)).toBeNull();
    });

    it('blur into the toolbar itself (e.g. its trigger) abandons the typed name without committing', async () => {
      const fixture = createFixture(['others:1', 'others:2']);
      const emitted: TranscriptSelectionSpeakerAssignment[] = [];
      const renamed: SpeakerRename[] = [];
      fixture.componentInstance.selectionSpeakerAssigned.subscribe((event) => emitted.push(event));
      fixture.componentInstance.speakerRenamed.subscribe((event) => renamed.push(event));

      const input = await openSelectionNewSpeaker(fixture);
      input.value = 'Alice';
      const trigger = fixture.nativeElement.querySelector('.selection-trigger') as HTMLButtonElement;

      input.dispatchEvent(new FocusEvent('blur', { relatedTarget: trigger }));
      fixture.detectChanges();

      expect(emitted).toEqual([]);
      expect(renamed).toEqual([]);
      expect(toolbar(fixture)).not.toBeNull();
    });
  });
});
