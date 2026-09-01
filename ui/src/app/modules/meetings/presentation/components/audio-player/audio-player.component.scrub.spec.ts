import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { toMeetingId } from '../../../core/models/meeting.model';
import { MeetingsFacade } from '../../../application/facades/meetings.facade';
import { AudioPlayerComponent } from './audio-player.component';

/**
 * Scrubbing regressions: `timeupdate` fires ~4×/s and must never rewrite the
 * seek slider while the user is dragging it (jitter/snap-back), and the seek
 * must commit on release (pointerup) or on `change` (keyboard). Also pins the
 * quiet time readout: no aria-live announcement storm and a static slider
 * label. Split per concern to stay under the lint max-lines limit.
 */
class MockMeetingsFacade {
  getAudioUrl = vi.fn().mockResolvedValue(null);
}

describe('AudioPlayerComponent scrubbing', () => {
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

  it('holds the drag position through timeupdate ticks and commits on pointerup', async () => {
    const fixture = await renderWithAudio();
    const component = fixture.componentInstance;
    const audio = fixture.nativeElement.querySelector('audio') as HTMLAudioElement;
    component['_duration'].set(100);
    component['_currentTime'].set(50);
    fixture.detectChanges();

    const slider = fixture.nativeElement.querySelector('.seek-slider') as HTMLInputElement;
    expect(Number(slider.value)).toBeCloseTo(50, 5);

    // User presses and drags the thumb to 70% while media keeps ticking.
    slider.dispatchEvent(new Event('pointerdown'));
    slider.value = '70';

    // ~4Hz timeupdate from the still-playing media at the OLD position.
    audio.currentTime = 20;
    audio.dispatchEvent(new Event('timeupdate'));
    fixture.detectChanges();

    // The tick must not snap the thumb back to the old position.
    expect(Number(slider.value)).toBeCloseTo(70, 5);
    expect(component.currentTime()).toBe(50);

    // Release commits the drag position.
    slider.dispatchEvent(new Event('pointerup'));
    fixture.detectChanges();
    expect(component.currentTime()).toBe(70);
    expect(audio.currentTime).toBe(70);
  });

  it('holds the position and commits on change for keyboard scrubbing', async () => {
    const fixture = await renderWithAudio();
    const component = fixture.componentInstance;
    const audio = fixture.nativeElement.querySelector('audio') as HTMLAudioElement;
    component['_duration'].set(100);
    component['_currentTime'].set(50);
    fixture.detectChanges();

    const slider = fixture.nativeElement.querySelector('.seek-slider') as HTMLInputElement;
    slider.dispatchEvent(new Event('focus'));
    slider.value = '30';

    audio.currentTime = 10;
    audio.dispatchEvent(new Event('timeupdate'));
    fixture.detectChanges();
    expect(Number(slider.value)).toBeCloseTo(30, 5);

    slider.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(component.currentTime()).toBe(30);
    expect(audio.currentTime).toBe(30);
  });

  it('disarms scrubbing on blur without committing, so timeupdate resumes', async () => {
    const fixture = await renderWithAudio();
    const component = fixture.componentInstance;
    const audio = fixture.nativeElement.querySelector('audio') as HTMLAudioElement;
    component['_duration'].set(100);
    component['_currentTime'].set(50);
    fixture.detectChanges();

    const slider = fixture.nativeElement.querySelector('.seek-slider') as HTMLInputElement;
    slider.dispatchEvent(new Event('focus'));
    slider.value = '30';

    // Scrubbing is armed: the tick is held.
    audio.currentTime = 10;
    audio.dispatchEvent(new Event('timeupdate'));
    fixture.detectChanges();
    expect(Number(slider.value)).toBeCloseTo(30, 5);

    // Tab away with no release/change: blur must disarm scrubbing but must
    // NOT commit the drag position (only pointerup/change commit).
    slider.dispatchEvent(new Event('blur'));
    fixture.detectChanges();
    expect(component.currentTime()).toBe(50);
    expect(audio.currentTime).toBe(10);

    // timeupdate drives the slider again.
    audio.currentTime = 60;
    audio.dispatchEvent(new Event('timeupdate'));
    fixture.detectChanges();
    expect(component.currentTime()).toBe(60);
    expect(Number(slider.value)).toBeCloseTo(60, 5);
  });

  it('ignores seek attempts before metadata instead of silently rewinding to 0', async () => {
    const fixture = await renderWithAudio();
    const component = fixture.componentInstance;
    const audio = fixture.nativeElement.querySelector('audio') as HTMLAudioElement;
    component['_duration'].set(0);
    audio.currentTime = 42;
    component['_currentTime'].set(42);

    const slider = fixture.nativeElement.querySelector('.seek-slider') as HTMLInputElement;
    slider.dispatchEvent(new Event('pointerdown'));
    slider.value = '80';
    slider.dispatchEvent(new Event('input'));
    slider.dispatchEvent(new Event('pointerup'));
    fixture.detectChanges();

    expect(component.currentTime()).toBe(42);
    expect(audio.currentTime).toBe(42);
  });

  it('keeps the time readout quiet: no aria-live on the display, static Seek label', async () => {
    const fixture = await renderWithAudio();
    const component = fixture.componentInstance;
    const audio = fixture.nativeElement.querySelector('audio') as HTMLAudioElement;

    const timeDisplay = fixture.nativeElement.querySelector('.time-display') as HTMLElement;
    expect(timeDisplay.hasAttribute('aria-live')).toBe(false);

    const slider = fixture.nativeElement.querySelector('.seek-slider') as HTMLInputElement;
    expect(slider.getAttribute('aria-label')).toBe('Seek');

    // The label must stay frozen while the position keeps ticking.
    component['_duration'].set(100);
    audio.currentTime = 25;
    audio.dispatchEvent(new Event('timeupdate'));
    fixture.detectChanges();
    expect(slider.getAttribute('aria-label')).toBe('Seek');
    expect(slider.getAttribute('aria-valuenow')).toBe('25');
  });
});
