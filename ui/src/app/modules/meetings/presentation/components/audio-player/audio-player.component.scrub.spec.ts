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

/** Port/facade view of one playable chunk (see adapter spec for the wire DTO). */
interface AudioChunkView {
  readonly url: string;
  readonly startSec: number;
  readonly durationSec: number;
}

const LEGACY_CHUNKS: readonly AudioChunkView[] = [
  { url: 'tauri://audio.wav', startSec: 0, durationSec: 0 },
];

const PART_ONE: AudioChunkView = {
  url: 'asset://localhost/audio.wav',
  startSec: 0,
  durationSec: 60,
};
const PART_TWO: AudioChunkView = {
  url: 'asset://localhost/audio.part-0002.wav',
  startSec: 60,
  durationSec: 40,
};

class MockMeetingsFacade {
  getAudioUrl = vi.fn().mockResolvedValue(null);
  getAudioChunks = vi.fn().mockResolvedValue(LEGACY_CHUNKS);
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
    facade.getAudioChunks = vi.fn().mockResolvedValue(LEGACY_CHUNKS);

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

  describe('multipart scrubbing (RED: global seek across chunked WAV)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    const flush = async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(0);
    };

    const renderWithChunks = async (
      chunks: readonly AudioChunkView[],
    ): Promise<ComponentFixture<AudioPlayerComponent>> => {
      const facade = TestBed.inject(MeetingsFacade) as unknown as MockMeetingsFacade;
      facade.getAudioUrl = vi.fn().mockResolvedValue(null);
      facade.getAudioChunks = vi.fn().mockResolvedValue(chunks);

      const fixture = TestBed.createComponent(AudioPlayerComponent);
      fixture.componentRef.setInput('meetingId', toMeetingId('m1'));
      fixture.componentRef.setInput('hasAudio', true);
      fixture.detectChanges();

      await flush();
      fixture.detectChanges();
      return fixture;
    };

    const dragTo = async (
      fixture: ComponentFixture<AudioPlayerComponent>,
      percent: string,
    ): Promise<void> => {
      const slider = fixture.nativeElement.querySelector('.seek-slider') as HTMLInputElement;
      slider.dispatchEvent(new Event('pointerdown'));
      slider.value = percent;
      slider.dispatchEvent(new Event('pointerup'));
      await flush();
      fixture.detectChanges();
    };

    it('maps a global seek into the second part to its local offset', async () => {
      const fixture = await renderWithChunks([PART_ONE, PART_TWO]);
      const component = fixture.componentInstance;
      expect(component.url()).toBe(PART_ONE.url);

      // 70% of the 100 s logical timeline = 70 s global → part 2, +10 s.
      await dragTo(fixture, '70');

      expect(component.currentTime()).toBe(70);
      expect(component.url()).toBe(PART_TWO.url);
      const audio = fixture.nativeElement.querySelector('audio') as HTMLAudioElement;
      expect(audio.currentTime).toBe(10);
    });

    it('seeks within the active first part without swapping the source', async () => {
      const fixture = await renderWithChunks([PART_ONE, PART_TWO]);
      const component = fixture.componentInstance;
      expect(component.url()).toBe(PART_ONE.url);

      await dragTo(fixture, '25');

      expect(component.currentTime()).toBe(25);
      expect(component.url()).toBe(PART_ONE.url);
      const audio = fixture.nativeElement.querySelector('audio') as HTMLAudioElement;
      expect(audio.currentTime).toBe(25);
    });

    it('treats a seek to a chunk boundary as the start of the next part', async () => {
      const fixture = await renderWithChunks([PART_ONE, PART_TWO]);
      const component = fixture.componentInstance;
      expect(component.url()).toBe(PART_ONE.url);

      await dragTo(fixture, '60');

      expect(component.currentTime()).toBe(60);
      expect(component.url()).toBe(PART_TWO.url);
      const audio = fixture.nativeElement.querySelector('audio') as HTMLAudioElement;
      expect(audio.currentTime).toBe(0);
    });

    it('seeks backward from the second part into the first', async () => {
      const fixture = await renderWithChunks([PART_ONE, PART_TWO]);
      const component = fixture.componentInstance;
      expect(component.url()).toBe(PART_ONE.url);

      const audio = fixture.nativeElement.querySelector('audio') as HTMLAudioElement;
      vi.spyOn(audio, 'play').mockResolvedValue(undefined);
      audio.dispatchEvent(new Event('play'));
      audio.dispatchEvent(new Event('ended'));
      await flush();
      fixture.detectChanges();
      expect(component.url()).toBe(PART_TWO.url);

      await dragTo(fixture, '10');

      expect(component.currentTime()).toBe(10);
      expect(component.url()).toBe(PART_ONE.url);
      expect(audio.currentTime).toBe(10);
    });

    it('keeps playback running when a seek crosses into the next part', async () => {
      const fixture = await renderWithChunks([PART_ONE, PART_TWO]);
      const component = fixture.componentInstance;
      expect(component.url()).toBe(PART_ONE.url);

      const audio = fixture.nativeElement.querySelector('audio') as HTMLAudioElement;
      const playSpy = vi.spyOn(audio, 'play').mockResolvedValue(undefined);
      audio.dispatchEvent(new Event('play'));
      fixture.detectChanges();

      await dragTo(fixture, '80');

      expect(component.url()).toBe(PART_TWO.url);
      expect(audio.currentTime).toBe(20);
      expect(component.playing()).toBe(true);
      expect(playSpy).toHaveBeenCalled();
    });
  });
});
