import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { toMeetingId } from '../../../core/models/meeting.model';
import { MeetingsFacade } from '../../../application/facades/meetings.facade';
import { AudioPlayerComponent } from './audio-player.component';

/**
 * Control-surface specs: volume glyph↔loudness pairing, media element state
 * driven purely through the [volume]/[muted]/[playbackRate] property
 * bindings (single source of truth), native-button keyboard activation
 * (Enter/Space fire click — no custom keydown handlers), the media `error`
 * branch, and playback-rate option re-selection. Split per concern to stay
 * under the lint max-lines limit.
 */
class MockMeetingsFacade {
  getAudioUrl = vi.fn().mockResolvedValue(null);
}

describe('AudioPlayerComponent controls', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [AudioPlayerComponent],
      providers: [
        { provide: MeetingsFacade, useClass: MockMeetingsFacade },
      ],
    });
  });

  const renderWithAudio = async (): Promise<ComponentFixture<AudioPlayerComponent>> => {
    const facade = TestBed.inject(MeetingsFacade) as unknown as MockMeetingsFacade;
    facade.getAudioUrl = vi.fn().mockResolvedValue('tauri://audio.wav');

    const fixture = TestBed.createComponent(AudioPlayerComponent);
    fixture.componentRef.setInput('meetingId', toMeetingId('m1'));
    fixture.componentRef.setInput('hasAudio', true);
    fixture.detectChanges();

    await Promise.resolve();
    fixture.detectChanges();
    return fixture;
  };

  const muteGlyph = (fixture: ComponentFixture<AudioPlayerComponent>): string => {
    const button = fixture.nativeElement.querySelector('.mute') as HTMLElement;
    return button.querySelector('span')?.textContent?.trim() ?? '';
  };

  it('pairs volume glyphs with loudness: low 🔈, mid 🔉, high 🔊, muted 🔇', async () => {
    const fixture = await renderWithAudio();
    const component = fixture.componentInstance;

    component['_volume'].set(0.9);
    fixture.detectChanges();
    expect(muteGlyph(fixture)).toBe('🔊');

    component['_volume'].set(0.5);
    fixture.detectChanges();
    expect(muteGlyph(fixture)).toBe('🔉');

    component['_volume'].set(0.2);
    fixture.detectChanges();
    expect(muteGlyph(fixture)).toBe('🔈');

    component['_muted'].set(true);
    fixture.detectChanges();
    expect(muteGlyph(fixture)).toBe('🔇');
  });

  it('drives element volume, muted and playbackRate through the property bindings', async () => {
    const fixture = await renderWithAudio();
    const audio = fixture.nativeElement.querySelector('audio') as HTMLAudioElement;

    const volumeSlider = fixture.nativeElement.querySelector('.volume-slider') as HTMLInputElement;
    volumeSlider.value = '0.4';
    volumeSlider.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(audio.volume).toBeCloseTo(0.4, 5);

    const muteButton = fixture.nativeElement.querySelector('.mute') as HTMLElement;
    muteButton.click();
    fixture.detectChanges();
    expect(audio.muted).toBe(true);

    muteButton.click();
    fixture.detectChanges();
    expect(audio.muted).toBe(false);

    const select = fixture.nativeElement.querySelector('.rate-select') as HTMLSelectElement;
    select.value = '2';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(audio.playbackRate).toBe(2);
  });

  it('activates play/pause via native click only — keydown must not double-fire', async () => {
    const fixture = await renderWithAudio();
    const audio = fixture.nativeElement.querySelector('audio') as HTMLAudioElement;
    const playSpy = vi.spyOn(audio, 'play').mockResolvedValue(undefined);
    const pauseSpy = vi.spyOn(audio, 'pause');
    const button = fixture.nativeElement.querySelector('.play-pause') as HTMLElement;

    // Enter/Space on a focused <button> is activated by the browser, which
    // dispatches a click. A custom keydown handler on top would double-fire.
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();
    expect(playSpy).not.toHaveBeenCalled();

    button.click();
    fixture.detectChanges();
    expect(playSpy).toHaveBeenCalledTimes(1);

    // Reflect the native playing state, then a second click pauses.
    audio.dispatchEvent(new Event('play'));
    fixture.detectChanges();
    button.click();
    expect(pauseSpy).toHaveBeenCalledTimes(1);
  });

  it('renders the error branch when the media element emits error', async () => {
    const fixture = await renderWithAudio();
    const audio = fixture.nativeElement.querySelector('audio') as HTMLAudioElement;

    audio.dispatchEvent(new Event('error'));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.audio-player.error')).toBeTruthy();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Playback error');
  });

  it('re-evaluates the selected option when the playback rate changes while rendered', async () => {
    const fixture = await renderWithAudio();
    const select = fixture.nativeElement.querySelector('.rate-select') as HTMLSelectElement;

    select.value = '1.25';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    const options = Array.from(select.querySelectorAll('option')) as HTMLOptionElement[];
    expect(options.map((o) => o.selected)).toEqual([false, false, false, true, false, false]);
    expect(select.selectedIndex).toBe(3);
  });
});
