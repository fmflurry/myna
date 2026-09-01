import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { toMeetingId } from '../../../core/models/meeting.model';
import { MeetingsFacade } from '../../../application/facades/meetings.facade';
import { AudioPlayerComponent, formatTime } from './audio-player.component';

/**
 * Regression specs for the audio-player playback state: play/pause icon
 * flipping, seek-slider advancement, time display, and playback-rate select
 * sync. Split into its own file to keep `audio-player.component.spec.ts`
 * under the project's max-lines limit (same pattern as the
 * `meeting-detail-pane.component.*.spec.ts` files).
 */
class MockMeetingsFacade {
  getAudioUrl = vi.fn().mockResolvedValue(null);
}

describe('AudioPlayerComponent playback state regressions', () => {
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

  // BUG 1: icon never flipped because play/pause/ended listeners were
  // attached in ngAfterViewInit, before the <audio> element existed (it is
  // rendered only after the async URL resolves).
  it('flips play icon to pause on native play event and back on pause/ended', async () => {
    const fixture = await renderWithAudio();
    const audio = fixture.nativeElement.querySelector('audio') as HTMLAudioElement;
    expect(audio).toBeTruthy();
    const playButton = fixture.nativeElement.querySelector('.play-pause') as HTMLElement;
    expect(playButton.getAttribute('aria-label')).toBe('Play');

    audio.dispatchEvent(new Event('play'));
    fixture.detectChanges();
    expect(playButton.getAttribute('aria-label')).toBe('Pause');
    expect(playButton.getAttribute('title')).toBe('Pause');
    expect(playButton.querySelector('.icon-pause')).toBeTruthy();
    expect(playButton.querySelector('.icon-play')).toBeNull();

    // External pause (e.g. another player starting) must flip the icon too.
    audio.dispatchEvent(new Event('pause'));
    fixture.detectChanges();
    expect(playButton.getAttribute('aria-label')).toBe('Play');
    expect(playButton.querySelector('.icon-play')).toBeTruthy();

    audio.dispatchEvent(new Event('play'));
    fixture.detectChanges();
    audio.dispatchEvent(new Event('ended'));
    fixture.detectChanges();
    expect(playButton.getAttribute('aria-label')).toBe('Play');
    expect(playButton.querySelector('.icon-play')).toBeTruthy();
  });

  // BUG 2: slider never advanced — same root cause (no timeupdate listener).
  it('advances currentTime signal, slider value and time label on timeupdate', async () => {
    const fixture = await renderWithAudio();
    const component = fixture.componentInstance;
    const audio = fixture.nativeElement.querySelector('audio') as HTMLAudioElement;
    component['_duration'].set(760);

    audio.currentTime = 83;
    audio.dispatchEvent(new Event('timeupdate'));
    fixture.detectChanges();

    expect(component.currentTime()).toBe(83);
    expect(component.currentTimeDisplay()).toBe('1:23');

    const slider = fixture.nativeElement.querySelector('.seek-slider') as HTMLInputElement;
    expect(Number(slider.value)).toBeCloseTo((83 / 760) * 100, 1);

    const timeDisplay = fixture.nativeElement.querySelector('.time-display') as HTMLElement;
    expect(timeDisplay.textContent).toContain('1:23');
    expect(timeDisplay.textContent).toContain('12:40');
  });

  it('renders the current/total time label at the end of the seek slider', async () => {
    const fixture = await renderWithAudio();
    const controls = fixture.nativeElement.querySelector('.controls') as HTMLElement;
    const children = Array.from(controls.children) as HTMLElement[];
    const sliderIndex = children.findIndex((el) => el.classList.contains('seek-slider'));
    const timeIndex = children.findIndex((el) => el.classList.contains('time-display'));
    expect(sliderIndex).toBeGreaterThanOrEqual(0);
    expect(timeIndex).toBeGreaterThan(sliderIndex);
  });

  it('reads duration from durationchange and guards NaN before metadata loads', async () => {
    const fixture = await renderWithAudio();
    const component = fixture.componentInstance;
    const audio = fixture.nativeElement.querySelector('audio') as HTMLAudioElement;

    // jsdom: no resource loaded → duration is NaN. Must not surface NaN.
    audio.dispatchEvent(new Event('durationchange'));
    fixture.detectChanges();
    expect(component.duration()).toBe(0);
    const timeDisplay = fixture.nativeElement.querySelector('.time-display') as HTMLElement;
    expect(timeDisplay.textContent).not.toContain('NaN');

    Object.defineProperty(audio, 'duration', { value: 760, configurable: true });
    audio.dispatchEvent(new Event('durationchange'));
    fixture.detectChanges();
    expect(component.duration()).toBe(760);
    expect(component.durationDisplay()).toBe('12:40');
  });

  it('formats non-finite or negative times as 0:00', () => {
    const fixture = TestBed.createComponent(AudioPlayerComponent);
    const component = fixture.componentInstance;

    component['_duration'].set(Number.NaN);
    expect(component.durationDisplay()).toBe('0:00');

    component['_currentTime'].set(Number.POSITIVE_INFINITY);
    expect(component.currentTimeDisplay()).toBe('0:00');

    component['_currentTime'].set(-5);
    expect(component.currentTimeDisplay()).toBe('0:00');
  });

  // BUG 3: select showed 0.5x while the real rate was 1x — [value] was bound
  // on <select> before its @for options existed, so nothing matched and the
  // browser fell back to the first option.
  it('displays the actual playback rate (1x) in the select on init', async () => {
    const fixture = await renderWithAudio();
    const component = fixture.componentInstance;
    const select = fixture.nativeElement.querySelector('.rate-select') as HTMLSelectElement;
    const audio = fixture.nativeElement.querySelector('audio') as HTMLAudioElement;

    expect(component.playbackRate()).toBe(1);
    expect(select.value).toBe('1');
    expect(select.selectedIndex).toBe(2);
    expect(audio.playbackRate).toBe(1);
  });

  it('keeps select display and media element rate in sync after a manual change', async () => {
    const fixture = await renderWithAudio();
    const component = fixture.componentInstance;
    const select = fixture.nativeElement.querySelector('.rate-select') as HTMLSelectElement;
    const audio = fixture.nativeElement.querySelector('audio') as HTMLAudioElement;

    select.value = '1.5';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(component.playbackRate()).toBe(1.5);
    expect(select.value).toBe('1.5');
    expect(audio.playbackRate).toBe(1.5);
  });
});

describe('formatTime', () => {
  it('formats mm:ss', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(83)).toBe('1:23');
    expect(formatTime(760)).toBe('12:40');
    expect(formatTime(3661)).toBe('61:01');
  });

  it('guards NaN, Infinity, and negative values', () => {
    expect(formatTime(Number.NaN)).toBe('0:00');
    expect(formatTime(Number.POSITIVE_INFINITY)).toBe('0:00');
    expect(formatTime(-5)).toBe('0:00');
  });
});
