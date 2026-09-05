import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { toMeetingId } from '../../../core/models/meeting.model';
import { MeetingsFacade } from '../../../application/facades/meetings.facade';
import { AudioPlayerComponent } from './audio-player.component';

/**
 * Port/facade view of one playable chunk of a meeting's audio (RED contract
 * for seamless multipart playback): `url` is already asset-converted by the
 * adapter; `startSec` is the chunk's offset on the meeting's global timeline.
 */
interface AudioChunkView {
  readonly url: string;
  readonly startSec: number;
  readonly durationSec: number;
}

/** Legacy non-segmented meetings resolve to exactly one whole-file chunk. */
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
  // Default mirrors the legacy single-file case through the new chunks API,
  // so every pre-multipart spec keeps passing both today and after GREEN.
  getAudioChunks = vi.fn().mockResolvedValue(LEGACY_CHUNKS);
}

describe('AudioPlayerComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [AudioPlayerComponent],
      providers: [
        { provide: MeetingsFacade, useClass: MockMeetingsFacade },
      ],
    });
  });

  it('should create', () => {
    const fixture = TestBed.createComponent(AudioPlayerComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should show loading state while URL is being fetched', () => {
    const facade = TestBed.inject(MeetingsFacade) as unknown as MockMeetingsFacade;
    facade.getAudioUrl = vi.fn().mockImplementation(() => new Promise(() => { /* never resolves */ }));
    facade.getAudioChunks = vi.fn().mockImplementation(() => new Promise(() => { /* never resolves */ }));

    const fixture = TestBed.createComponent(AudioPlayerComponent);
    fixture.componentRef.setInput('meetingId', toMeetingId('m1'));
    fixture.componentRef.setInput('hasAudio', true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.audio-player.loading')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.spinner')).toBeTruthy();
  });

  it('should show no-audio message when hasAudio is false', () => {
    const fixture = TestBed.createComponent(AudioPlayerComponent);
    fixture.componentRef.setInput('meetingId', toMeetingId('m1'));
    fixture.componentRef.setInput('hasAudio', false);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.audio-player.no-audio')).toBeTruthy();
    expect(fixture.nativeElement.textContent).toContain('No recording available');
  });

  it('should show error message when URL fetch fails', async () => {
    const facade = TestBed.inject(MeetingsFacade) as unknown as MockMeetingsFacade;
    facade.getAudioUrl = vi.fn().mockRejectedValue(new Error('Not found'));
    facade.getAudioChunks = vi.fn().mockRejectedValue(new Error('Not found'));

    const fixture = TestBed.createComponent(AudioPlayerComponent);
    fixture.componentRef.setInput('meetingId', toMeetingId('m1'));
    fixture.componentRef.setInput('hasAudio', true);
    fixture.detectChanges();

    await Promise.resolve();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.audio-player.error')).toBeTruthy();
    expect(fixture.nativeElement.textContent).toContain('Failed to load audio');
  });

  it('should render controls when URL resolves successfully', async () => {
    const facade = TestBed.inject(MeetingsFacade) as unknown as MockMeetingsFacade;
    facade.getAudioUrl = vi.fn().mockResolvedValue('tauri://audio.wav');

    const fixture = TestBed.createComponent(AudioPlayerComponent);
    fixture.componentRef.setInput('meetingId', toMeetingId('m1'));
    fixture.componentRef.setInput('hasAudio', true);
    fixture.detectChanges();

    await Promise.resolve();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.audio-player .controls')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.play-pause')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.seek-slider')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.volume-controls')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.rate-select')).toBeTruthy();
  });

  it('should format time correctly', () => {
    const fixture = TestBed.createComponent(AudioPlayerComponent);
    const component = fixture.componentInstance;

    expect(component.currentTimeDisplay()).toBe('0:00');

    component['_currentTime'].set(65);
    expect(component.currentTimeDisplay()).toBe('1:05');

    component['_currentTime'].set(3661);
    expect(component.currentTimeDisplay()).toBe('61:01');
  });

  it('should format duration correctly', () => {
    const fixture = TestBed.createComponent(AudioPlayerComponent);
    const component = fixture.componentInstance;

    expect(component.durationDisplay()).toBe('0:00');

    component['_duration'].set(125);
    expect(component.durationDisplay()).toBe('2:05');
  });

  it('should have all playback rate options', () => {
    const fixture = TestBed.createComponent(AudioPlayerComponent);
    const component = fixture.componentInstance;

    expect(component.playbackRates).toEqual([0.5, 0.75, 1, 1.25, 1.5, 2]);
  });

  it('should calculate seek percent correctly', () => {
    const fixture = TestBed.createComponent(AudioPlayerComponent);
    const component = fixture.componentInstance;

    component['_duration'].set(100);
    component['_currentTime'].set(50);
    expect(component.seekPercent()).toBe(50);

    component['_currentTime'].set(25);
    expect(component.seekPercent()).toBe(25);
  });

  it('should return 0 seek percent when duration is 0', () => {
    const fixture = TestBed.createComponent(AudioPlayerComponent);
    const component = fixture.componentInstance;

    component['_duration'].set(0);
    component['_currentTime'].set(50);
    expect(component.seekPercent()).toBe(0);
  });

  it('should have play button with correct aria-label when not playing', async () => {
    const facade = TestBed.inject(MeetingsFacade) as unknown as MockMeetingsFacade;
    facade.getAudioUrl = vi.fn().mockResolvedValue('tauri://audio.wav');

    const fixture = TestBed.createComponent(AudioPlayerComponent);
    fixture.componentRef.setInput('meetingId', toMeetingId('m1'));
    fixture.componentRef.setInput('hasAudio', true);
    fixture.detectChanges();

    await Promise.resolve();
    fixture.detectChanges();

    const playButton = fixture.nativeElement.querySelector('.play-pause');
    expect(playButton?.getAttribute('aria-label')).toBe('Play');
    expect(playButton?.getAttribute('aria-pressed')).toBe('false');
  });

  it('should have pause button with correct aria-label when playing', async () => {
    const facade = TestBed.inject(MeetingsFacade) as unknown as MockMeetingsFacade;
    facade.getAudioUrl = vi.fn().mockResolvedValue('tauri://audio.wav');

    const fixture = TestBed.createComponent(AudioPlayerComponent);
    fixture.componentRef.setInput('meetingId', toMeetingId('m1'));
    fixture.componentRef.setInput('hasAudio', true);
    fixture.detectChanges();

    await Promise.resolve();
    fixture.detectChanges();

    const component = fixture.componentInstance;
    component['_playing'].set(true);
    fixture.detectChanges();

    const playButton = fixture.nativeElement.querySelector('.play-pause');
    expect(playButton?.getAttribute('aria-label')).toBe('Pause');
    expect(playButton?.getAttribute('aria-pressed')).toBe('true');
  });

  it('should have volume slider with correct attributes', async () => {
    const facade = TestBed.inject(MeetingsFacade) as unknown as MockMeetingsFacade;
    facade.getAudioUrl = vi.fn().mockResolvedValue('tauri://audio.wav');

    const fixture = TestBed.createComponent(AudioPlayerComponent);
    fixture.componentRef.setInput('meetingId', toMeetingId('m1'));
    fixture.componentRef.setInput('hasAudio', true);
    fixture.detectChanges();

    await Promise.resolve();
    fixture.detectChanges();

    const volumeSlider = fixture.nativeElement.querySelector('.volume-slider');
    expect(volumeSlider?.getAttribute('aria-label')).toContain('Volume:');
    expect(volumeSlider?.getAttribute('aria-valuemin')).toBe('0');
    expect(volumeSlider?.getAttribute('aria-valuemax')).toBe('100');
  });

  it('should have seek slider with correct attributes', async () => {
    const facade = TestBed.inject(MeetingsFacade) as unknown as MockMeetingsFacade;
    facade.getAudioUrl = vi.fn().mockResolvedValue('tauri://audio.wav');

    const fixture = TestBed.createComponent(AudioPlayerComponent);
    fixture.componentRef.setInput('meetingId', toMeetingId('m1'));
    fixture.componentRef.setInput('hasAudio', true);
    fixture.detectChanges();

    await Promise.resolve();
    fixture.detectChanges();

    const seekSlider = fixture.nativeElement.querySelector('.seek-slider');
    // Frozen static label (item: aria announcement storm) — position comes
    // from native range aria-valuenow, not from a 4×/s label rewrite.
    expect(seekSlider?.getAttribute('aria-label')).toBe('Seek');
    expect(seekSlider?.getAttribute('aria-valuemin')).toBe('0');
    expect(seekSlider?.getAttribute('aria-valuemax')).toBe('100');
  });

  it('should have rate select with correct options', async () => {
    const facade = TestBed.inject(MeetingsFacade) as unknown as MockMeetingsFacade;
    facade.getAudioUrl = vi.fn().mockResolvedValue('tauri://audio.wav');

    const fixture = TestBed.createComponent(AudioPlayerComponent);
    fixture.componentRef.setInput('meetingId', toMeetingId('m1'));
    fixture.componentRef.setInput('hasAudio', true);
    fixture.detectChanges();

    await Promise.resolve();
    fixture.detectChanges();

    const rateSelect = fixture.nativeElement.querySelector('.rate-select');
    const options = Array.from(rateSelect?.querySelectorAll('option') ?? []) as HTMLOptionElement[];
    expect(options.length).toBe(6);
    expect(options.map((o) => o.value)).toEqual(['0.5', '0.75', '1', '1.25', '1.5', '2']);
    expect(options.map((o) => o.textContent)).toEqual(['0.5x', '0.75x', '1x', '1.25x', '1.5x', '2x']);
  });

  it('should have mute button with correct aria-label based on state', async () => {
    const facade = TestBed.inject(MeetingsFacade) as unknown as MockMeetingsFacade;
    facade.getAudioUrl = vi.fn().mockResolvedValue('tauri://audio.wav');

    const fixture = TestBed.createComponent(AudioPlayerComponent);
    fixture.componentRef.setInput('meetingId', toMeetingId('m1'));
    fixture.componentRef.setInput('hasAudio', true);
    fixture.detectChanges();

    await Promise.resolve();
    fixture.detectChanges();

    let muteButton = fixture.nativeElement.querySelector('.mute');
    expect(muteButton?.getAttribute('aria-label')).toBe('Mute');

    const component = fixture.componentInstance;
    component['_muted'].set(true);
    fixture.detectChanges();

    muteButton = fixture.nativeElement.querySelector('.mute');
    expect(muteButton?.getAttribute('aria-label')).toBe('Unmute');
  });

  describe('multipart playback (RED: seamless chunked WAV)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    // Drains the chunk-load promise chain (and any timer the implementation
    // schedules around the async multi-URL resolution).
    const flush = async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(0);
    };

    const renderWithChunks = async (
      chunks: readonly AudioChunkView[],
    ): Promise<ComponentFixture<AudioPlayerComponent>> => {
      const facade = TestBed.inject(MeetingsFacade) as unknown as MockMeetingsFacade;
      // The player must drive playback from getAudioChunks; the legacy
      // single-URL API resolving null proves nothing renders without it.
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

    it('exposes the first chunk URL and the summed duration as one timeline', async () => {
      const fixture = await renderWithChunks([PART_ONE, PART_TWO]);
      const component = fixture.componentInstance;

      // RED today: the player only knows getAudioUrl, which resolves null.
      expect(component.url()).toBe(PART_ONE.url);
      expect(component.duration()).toBe(100);
      expect(component.loading()).toBe(false);
      expect(component.error()).toBeNull();

      const audio = fixture.nativeElement.querySelector('audio') as HTMLAudioElement;
      expect(audio).toBeTruthy();
      expect(audio.src).toContain('asset://localhost/audio.wav');
    });

    it('renders the same control surface for a legacy single-chunk meeting', async () => {
      const fixture = await renderWithChunks(LEGACY_CHUNKS);
      const component = fixture.componentInstance;

      expect(component.url()).toBe('tauri://audio.wav');
      expect(fixture.nativeElement.querySelector('.audio-player .controls')).toBeTruthy();
      expect(fixture.nativeElement.querySelector('.play-pause')).toBeTruthy();
      expect(fixture.nativeElement.querySelector('.seek-slider')).toBeTruthy();
    });

    it('shows the no-audio branch when the backend returns zero chunks', async () => {
      const fixture = await renderWithChunks([]);
      const component = fixture.componentInstance;

      expect(component.url()).toBeNull();
      expect(component.error()).toBeNull();
      expect(component.loading()).toBe(false);
      expect(fixture.nativeElement.querySelector('.audio-player.no-audio')).toBeTruthy();
      expect((fixture.nativeElement as HTMLElement).textContent).toContain('No recording available');
    });

    it('surfaces "Failed to load audio" when the chunks request rejects', async () => {
      const facade = TestBed.inject(MeetingsFacade) as unknown as MockMeetingsFacade;
      facade.getAudioUrl = vi.fn().mockResolvedValue(null);
      facade.getAudioChunks = vi.fn().mockRejectedValue(new Error('boom'));

      const fixture = TestBed.createComponent(AudioPlayerComponent);
      fixture.componentRef.setInput('meetingId', toMeetingId('m1'));
      fixture.componentRef.setInput('hasAudio', true);
      fixture.detectChanges();

      await flush();
      fixture.detectChanges();

      expect(fixture.componentInstance.error()).toBe('Failed to load audio');
      expect(fixture.nativeElement.querySelector('.audio-player.error')).toBeTruthy();
    });
  });
});
