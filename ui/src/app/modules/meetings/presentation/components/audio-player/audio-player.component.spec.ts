import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { toMeetingId } from '../../../core/models/meeting.model';
import { MeetingsFacade } from '../../../application/facades/meetings.facade';
import { AudioPlayerComponent } from './audio-player.component';

class MockMeetingsFacade {
  getAudioUrl = vi.fn().mockResolvedValue(null);
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
});
