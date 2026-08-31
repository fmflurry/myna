import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { vi } from 'vitest';

import { toMeetingId } from '../../../core/models/meeting.model';
import type { SpeakerOp } from '../../../application/stores/speaker-history.model';
import { SpeakersPanelComponent } from './speakers-panel.component';

describe('SpeakersPanelComponent', () => {
  let fixture: ComponentFixture<SpeakersPanelComponent>;

  const opMeetingId = toMeetingId('m-1');

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SpeakersPanelComponent],
    }).compileComponents();
    fixture = TestBed.createComponent(SpeakersPanelComponent);
  });

  const render = (speakerNames: Readonly<Record<string, string>> = {}, history: readonly SpeakerOp[] = []): void => {
    fixture.componentRef.setInput('speakerNames', speakerNames);
    fixture.componentRef.setInput('history', history);
    fixture.detectChanges();
  };

  it('renders Me plus every known named identity, with remove buttons only for removable rows', () => {
    render({ me: 'Yann', 'others:1': 'Jean', 'others:2': 'Amélie' });

    const rows = fixture.nativeElement.querySelectorAll('.speaker-row');
    expect(rows.length).toBe(3);
    expect(rows[0].querySelector('.speaker-role').textContent).toBe('Me');
    expect((rows[0].querySelector('.speaker-name') as HTMLInputElement).value).toBe('Yann');
    expect((rows[1].querySelector('.speaker-name') as HTMLInputElement).value).toBe('Amélie');
    expect(rows[0].querySelector('.remove-speaker')).toBeNull();
    expect(rows[1].querySelector('.remove-speaker')).toBeTruthy();
  });

  it('emits speakerRenamed with the trimmed name on commit', () => {
    render({ 'others:1': 'Jean' });
    const renamed = vi.fn();
    fixture.componentInstance.speakerRenamed.subscribe(renamed);

    const input = fixture.nativeElement.querySelector('.speaker-row:nth-child(2) .speaker-name') as HTMLInputElement;
    input.value = '  Jeanne  ';
    input.dispatchEvent(new Event('change'));

    expect(renamed).toHaveBeenCalledWith({ label: 'others:1', name: 'Jeanne' });
  });

  it('does not emit speakerRenamed when the name is unchanged', () => {
    render({ 'others:1': 'Jean' });
    const renamed = vi.fn();
    fixture.componentInstance.speakerRenamed.subscribe(renamed);

    const input = fixture.nativeElement.querySelector('.speaker-row:nth-child(2) .speaker-name') as HTMLInputElement;
    input.value = 'Jean';
    input.dispatchEvent(new Event('change'));

    expect(renamed).not.toHaveBeenCalled();
  });

  it('emits speakerRemoved with the label after the user confirms', () => {
    render({ 'others:1': 'Jean' });
    const removed = vi.fn();
    fixture.componentInstance.speakerRemoved.subscribe(removed);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    (fixture.nativeElement.querySelector('.remove-speaker') as HTMLElement).click();

    expect(confirmSpy).toHaveBeenCalledWith('Remove speaker "Jean"? Its segments return to Others (unassigned).');
    expect(removed).toHaveBeenCalledWith('others:1');
  });

  it('emits nothing when the user declines the removal confirmation', () => {
    render({ 'others:1': 'Jean' });
    const removed = vi.fn();
    fixture.componentInstance.speakerRemoved.subscribe(removed);
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    (fixture.nativeElement.querySelector('.remove-speaker') as HTMLElement).click();

    expect(removed).not.toHaveBeenCalled();
  });

  it('disables undo while the history is empty and describes the last op otherwise', () => {
    render({ 'others:1': 'Jean' }, []);
    const button = fixture.nativeElement.querySelector('.undo-speaker-op') as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    fixture.componentRef.setInput('history', [
      { kind: 'remove', meetingId: opMeetingId, label: 'others:1', previousName: 'Jean', segments: [] },
    ]);
    fixture.detectChanges();

    expect(button.disabled).toBe(false);
    expect(button.textContent).toContain('Undo remove Jean');
  });

  it('emits undoRequested on click', () => {
    render({}, [{ kind: 'reassign', meetingId: opMeetingId, index: 0, previousLabel: 'others' }]);
    const undo = vi.fn();
    fixture.componentInstance.undoRequested.subscribe(undo);

    (fixture.nativeElement.querySelector('.undo-speaker-op') as HTMLElement).click();

    expect(undo).toHaveBeenCalled();
  });
});
