import { TestBed } from '@angular/core/testing';

import { transcriptSegment } from '../../../application/testing/transcript-segment.factory';
import { TranscriptViewComponent } from './transcript-view.component';

/**
 * Registry-aware chip rendering: a speaker rename must update EVERY chip for
 * that label, so the visible chip text resolves through the meeting's
 * `speakerNames` registry FIRST and only falls back to the derived
 * `speakerDisplayName`. Mirrors `renamePlaceholder`'s precedence.
 */
describe('TranscriptViewComponent — speakerNames registry rendering', () => {
  const createFixture = (
    speakerNames: Readonly<Record<string, string>>,
    speakers: readonly string[],
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

  const chipTexts = (fixture: ReturnType<typeof createFixture>): string[] =>
    Array.from(fixture.nativeElement.querySelectorAll('.speaker-chip')).map(
      (el) => (el as HTMLElement).textContent?.trim() ?? '',
    );

  it('renders the registered display name on the chip instead of the derived label', () => {
    const fixture = createFixture({ 'others:1': 'Jean' }, ['others:1']);
    expect(chipTexts(fixture)).toEqual(['Jean']);
  });

  it('falls back to the derived label when the registry is empty', () => {
    const fixture = createFixture({}, ['others:1']);
    expect(chipTexts(fixture)).toEqual(['Others 1']);
  });

  it('renders the registered name for a named "me" chip', () => {
    const fixture = createFixture({ me: 'Alice' }, ['me']);
    expect(chipTexts(fixture)).toEqual(['Alice']);
  });

  it('updates EVERY chip sharing a label (rename hits all occurrences)', () => {
    const fixture = createFixture({ 'others:1': 'François' }, ['others:1', 'others', 'others:1']);
    expect(chipTexts(fixture)).toEqual(['François', 'Others', 'François']);
  });

  it('never fabricates attribution for unknown, even with a registry entry for another label', () => {
    const fixture = createFixture({ 'others:1': 'Jean' }, ['unknown']);
    expect(chipTexts(fixture)).toEqual(['Assign speaker']);
  });
});
